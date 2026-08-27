import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { LlmFailedError, LlmUnavailableError } from './errors.js'

/**
 * Where the model settings live.
 *
 * A file on the data volume rather than the environment, because this is
 * something an operator configures through the interface — and both the web
 * process and the workers have to read it. Environment variables would mean
 * restarting containers to point at a different model.
 */
const SETTINGS_FILE = 'llm.json'

/** Long enough for a slow local model on modest hardware. */
const DEFAULT_TIMEOUT_MS = 120_000

export const LlmSettings = z.object({
  /** An OpenAI-compatible base, as vLLM, Ollama, llama.cpp and others expose. */
  baseUrl: z.string().trim().max(500),
  model: z.string().trim().max(200),
  /** Optional: a local vLLM or Ollama usually needs none. */
  apiKey: z.string().max(400).optional(),
  timeoutMs: z.coerce.number().int().min(1000).max(600_000).optional(),
  /** When the endpoint last answered, and with which model listed. */
  verifiedAt: z.number().optional(),
  verifiedModel: z.string().optional(),
  /**
   * The last check and what it said, kept so the page can explain itself later.
   * A status that says only "not working" sends an operator hunting through
   * container logs for something the server already knew.
   */
  lastCheckedAt: z.number().optional(),
  lastDetail: z.string().max(600).optional(),
})

export type LlmSettings = z.infer<typeof LlmSettings>

/** What may safely be shown on a page: everything except the key itself. */
export interface LlmPublic {
  baseUrl: string
  model: string
  hasKey: boolean
  timeoutMs: number
  verifiedAt: number | null
  lastCheckedAt: number | null
  lastDetail: string | null
  ready: boolean
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface LlmProbe {
  ok: boolean
  /** What happened, in words worth showing to whoever is configuring this. */
  detail: string
  models?: string[]
  /** Reachable, but something about the configuration looks wrong. */
  warning?: string
}

/**
 * Where the workers record whether they can reach the model.
 *
 * The web process and the workers do not share a network: on the shipped
 * compose the workers have no route off the host at all, deliberately. So the
 * web process reaching a model proves nothing about the process that will
 * actually do the work — and a page reporting "ready" while every job fails is
 * the worst of both worlds.
 */
const RUNNER_STATUS_FILE = 'llm-runner.json'

export const RunnerLlmStatus = z.object({
  ok: z.boolean(),
  detail: z.string().max(600),
  at: z.number(),
  /** Which endpoint was tried, so a stale result is not mistaken for this one. */
  baseUrl: z.string(),
  model: z.string(),
})

export type RunnerLlmStatus = z.infer<typeof RunnerLlmStatus>

const settingsPath = (dataDir: string) => join(dataDir, SETTINGS_FILE)
const runnerStatusPath = (dataDir: string) => join(dataDir, RUNNER_STATUS_FILE)

/** Trailing slashes are the most common way to get an OpenAI base URL wrong. */
const endpoint = (baseUrl: string, path: string) => `${baseUrl.replace(/\/+$/, '')}/${path}`

export async function readLlmSettings(dataDir: string): Promise<LlmSettings | null> {
  let raw: string
  try {
    raw = await readFile(settingsPath(dataDir), 'utf8')
  } catch {
    return null
  }

  try {
    const parsed = LlmSettings.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    // A corrupt file reads as "nothing configured" rather than breaking every
    // page that asks whether a model is available.
    return null
  }
}

export async function writeLlmSettings(dataDir: string, settings: LlmSettings): Promise<void> {
  await mkdir(dataDir, { recursive: true })
  const path = settingsPath(dataDir)
  // The key is a secret: owner-only, and chmod again because the mode passed to
  // writeFile is masked by the umask.
  await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 })
  await chmod(path, 0o600)
}

export async function readRunnerLlmStatus(dataDir: string): Promise<RunnerLlmStatus | null> {
  try {
    const parsed = RunnerLlmStatus.safeParse(JSON.parse(await readFile(runnerStatusPath(dataDir), 'utf8')))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export async function writeRunnerLlmStatus(dataDir: string, status: RunnerLlmStatus): Promise<void> {
  await mkdir(dataDir, { recursive: true })
  await writeFile(runnerStatusPath(dataDir), `${JSON.stringify(status, null, 2)}\n`)
}

/**
 * Whether a job sent to a worker would actually reach a model.
 *
 * Requires the workers to have said so themselves, about this very endpoint. A
 * check from the web process is necessary but not sufficient — the two are on
 * different networks by design.
 */
export function isLlmUsable(
  settings: LlmSettings | null,
  runner: RunnerLlmStatus | null,
): boolean {
  if (!isLlmReady(settings) || !runner?.ok) return false
  return runner.baseUrl === settings!.baseUrl && runner.model === settings!.model
}

/**
 * One check, from wherever this is called, recorded for the web process to read.
 *
 * Called on a timer by the workers. Kept as a single pass rather than owning a
 * loop so it can be tested without waiting for one.
 */
export async function refreshRunnerLlmStatus(
  dataDir: string,
  fetchImpl?: typeof fetch,
): Promise<RunnerLlmStatus | null> {
  const settings = await readLlmSettings(dataDir)
  if (!settings?.baseUrl || !settings.model) return null

  const probe = await probeLlm(settings, fetchImpl ?? fetch)
  const status: RunnerLlmStatus = {
    ok: probe.ok,
    detail: probe.warning ? `${probe.detail} ${probe.warning}` : probe.detail,
    at: Date.now(),
    baseUrl: settings.baseUrl,
    model: settings.model,
  }

  await writeRunnerLlmStatus(dataDir, status)
  return status
}

export function describeLlm(settings: LlmSettings | null): LlmPublic {
  return {
    baseUrl: settings?.baseUrl ?? '',
    model: settings?.model ?? '',
    hasKey: Boolean(settings?.apiKey),
    timeoutMs: settings?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    verifiedAt: settings?.verifiedAt ?? null,
    lastCheckedAt: settings?.lastCheckedAt ?? null,
    lastDetail: settings?.lastDetail ?? null,
    ready: isLlmReady(settings),
  }
}

/**
 * Whether the features that need a model may be offered.
 *
 * Configured is not enough: a base URL somebody typed once and never reached is
 * how a menu fills up with entries that only fail. It has to have answered.
 */
export function isLlmReady(settings: LlmSettings | null): boolean {
  if (!settings) return false
  return Boolean(settings.baseUrl && settings.model && settings.verifiedAt)
}

function headersFor(settings: LlmSettings): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`
  return headers
}

/** The message an OpenAI-compatible endpoint puts in an error body, if any. */
function apiMessage(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null
  const error = (body as { error?: unknown }).error
  if (typeof error === 'string') return error
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string') return message
  }
  return null
}

/**
 * Ask the endpoint what it has.
 *
 * `/models` is the cheapest question an OpenAI-compatible server answers, and
 * the answer also says whether the configured model is actually present — which
 * is a different problem from being unreachable, and worth telling apart.
 */
export async function probeLlm(
  settings: LlmSettings,
  fetchImpl: typeof fetch = fetch,
): Promise<LlmProbe> {
  if (!settings.baseUrl || !settings.model) {
    return { ok: false, detail: 'Give a base URL and a model name first.' }
  }

  try {
    const response = await fetchImpl(endpoint(settings.baseUrl, 'models'), {
      method: 'GET',
      headers: headersFor(settings),
      signal: AbortSignal.timeout(settings.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    })

    if (!response.ok) {
      const body = await response.json().catch(() => null)
      const said = apiMessage(body)
      return {
        ok: false,
        detail: `The endpoint answered ${response.status}${said ? `: ${said}` : ''}.`,
      }
    }

    const body = (await response.json().catch(() => null)) as { data?: { id?: string }[] } | null
    const models = (body?.data ?? [])
      .map((entry) => entry?.id)
      .filter((id): id is string => typeof id === 'string')

    const probe: LlmProbe = {
      ok: true,
      detail: models.length
        ? `Answered, offering ${models.length} model${models.length === 1 ? '' : 's'}.`
        : 'Answered, though it listed no models.',
      models,
    }

    if (models.length > 0 && !models.includes(settings.model)) {
      probe.warning =
        `It did not list ${settings.model}. Available: ${models.slice(0, 8).join(', ')}` +
        `${models.length > 8 ? '…' : ''}.`
    }

    return probe
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    return { ok: false, detail: `It could not be reached: ${detail}` }
  }
}

export interface ChatOptions {
  fetchImpl?: typeof fetch
  temperature?: number
  maxTokens?: number
}

/**
 * Put a conversation to the model and return what it said.
 *
 * Deliberately the whole of the interface: everything here that needs a model
 * needs exactly this, and a thin seam is easy to point at vLLM, Ollama,
 * llama.cpp or anything else that speaks the same shape.
 */
/**
 * Asks the server to run the model in its non-thinking mode. Understood by vLLM
 * and SGLang, which is what a self-hosted Qwen or DeepSeek is usually served
 * by; other servers ignore fields they do not know.
 *
 * Worth asking rather than only cleaning up afterwards: the same one-sentence
 * summary from the same Qwen cost 199 completion tokens with thinking and 10
 * without. On a long document split into parts, that is the difference between
 * a summary that arrives and one somebody gives up waiting for.
 *
 * `stripReasoning` stays the guarantee, because a server may ignore this and a
 * model may think regardless.
 */
const THINKING_OFF = { chat_template_kwargs: { enable_thinking: false } }

/**
 * A reasoning model narrates its working in <think> blocks and puts the answer
 * after them, both in the same `content` field. The narration is the model
 * talking to itself — never the answer, and not something to show a reader, who
 * asked for a summary and not for deliberation about how to write one.
 *
 * An unclosed block means the response hit its token limit while still
 * thinking, so there is no answer in it at all. Cutting from the opening tag to
 * the end leaves nothing, and the caller reports that rather than passing along
 * half a thought.
 */
export function stripReasoning(content: string): string {
  return content
    .replace(/<think\b[^>]*>[\s\S]*?<\/think\s*>/gi, '')
    .replace(/<think\b[^>]*>[\s\S]*$/i, '')
    .trim()
}

export async function chatWithLlm(
  settings: LlmSettings | null,
  messages: LlmMessage[],
  options: ChatOptions = {},
): Promise<string> {
  if (!settings || !settings.baseUrl || !settings.model) {
    throw new LlmUnavailableError('one is not configured on this server yet')
  }

  const fetchImpl = options.fetchImpl ?? fetch

  const send = async (body: object): Promise<Response> => {
    try {
      return await fetchImpl(endpoint(settings.baseUrl, 'chat/completions'), {
        method: 'POST',
        headers: headersFor(settings),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(settings.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      })
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      throw new LlmUnavailableError(`${settings.baseUrl} could not be reached: ${detail}`)
    }
  }

  const request = {
    model: settings.model,
    messages,
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
  }

  let response = await send({ ...request, ...THINKING_OFF })

  // Only a refusal of the request itself is worth a second attempt. Anything
  // else — the model out of memory, the endpoint gone — is a real fault, and
  // asking again would just fail twice and report the second failure.
  if (response.status === 400) response = await send(request)

  const body = (await response.json().catch(() => null)) as {
    choices?: { message?: { content?: string } }[]
  } | null

  if (!response.ok) {
    const said = apiMessage(body)
    throw new LlmFailedError(`it answered ${response.status}${said ? `: ${said}` : ''}`)
  }

  const raw = body?.choices?.[0]?.message?.content
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new LlmFailedError('it returned no text')
  }

  const content = stripReasoning(raw)
  if (content === '') {
    throw new LlmFailedError('it returned its reasoning but no answer')
  }

  return content
}
