import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  chatWithLlm,
  describeLlm,
  isLlmReady,
  isLlmUsable,
  readRunnerLlmStatus,
  writeRunnerLlmStatus,
  probeLlm,
  readLlmSettings,
  writeLlmSettings,
} from '../src/llm.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pixelsmith-llm-'))
})
afterEach(() => rm(dir, { recursive: true, force: true }))

const settings = {
  baseUrl: 'http://gpu-box.internal:8000/v1',
  model: 'qwen2.5:14b',
  apiKey: 'sk-not-a-real-key',
  timeoutMs: 30_000,
}

/** A stand-in for fetch that records what it was asked and answers as told. */
function stubFetch(answer: { status?: number; body?: unknown; throws?: string }) {
  const calls: { url: string; init: RequestInit }[] = []
  const impl = async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init })
    if (answer.throws) throw new Error(answer.throws)
    return {
      ok: (answer.status ?? 200) < 400,
      status: answer.status ?? 200,
      async json() { return answer.body ?? {} },
      async text() { return JSON.stringify(answer.body ?? {}) },
    } as unknown as Response
  }
  return { impl: impl as unknown as typeof fetch, calls }
}

describe('remembering how to reach a model', () => {
  it('keeps the settings where both the web process and the workers can read them', async () => {
    // A file on the shared data volume rather than the environment, so
    // configuring a model does not mean restarting containers.
    await writeLlmSettings(dir, settings)
    expect(await readLlmSettings(dir)).toMatchObject(settings)
  })

  it('keeps the key to itself on disk', async () => {
    await writeLlmSettings(dir, settings)
    const mode = (await stat(join(dir, 'llm.json'))).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('says nothing is configured when nothing is', async () => {
    expect(await readLlmSettings(dir)).toBeNull()
  })

  it('never hands the key back out, only whether there is one', async () => {
    /**
     * The settings page has to show what is configured without showing the
     * secret — a key rendered into HTML ends up in a browser cache, a
     * screenshot, or a support ticket.
     */
    await writeLlmSettings(dir, settings)
    const shown = describeLlm(await readLlmSettings(dir))

    expect(shown.baseUrl).toBe(settings.baseUrl)
    expect(shown.model).toBe(settings.model)
    expect(shown.hasKey).toBe(true)
    expect(JSON.stringify(shown)).not.toContain('sk-not-a-real-key')
  })

  it('treats a model as ready only once it has answered', async () => {
    expect(isLlmReady(null)).toBe(false)
    expect(isLlmReady({ ...settings, verifiedAt: undefined })).toBe(false)
    expect(isLlmReady({ ...settings, verifiedAt: Date.now() })).toBe(true)
    // Configured but never reachable is not ready.
    expect(isLlmReady({ baseUrl: '', model: '', verifiedAt: Date.now() })).toBe(false)
  })
})

describe('checking a model can be reached', () => {
  it('asks the endpoint what it can do, the OpenAI way', async () => {
    const fetcher = stubFetch({ body: { data: [{ id: 'qwen2.5:14b' }, { id: 'llama3.1:8b' }] } })
    const result = await probeLlm(settings, fetcher.impl)

    expect(fetcher.calls[0]!.url).toBe('http://gpu-box.internal:8000/v1/models')
    expect((fetcher.calls[0]!.init.headers as Record<string, string>).Authorization)
      .toBe('Bearer sk-not-a-real-key')
    expect(result.ok).toBe(true)
    expect(result.models).toEqual(['qwen2.5:14b', 'llama3.1:8b'])
  })

  it('warns when the endpoint answers but does not have the model asked for', async () => {
    // Reachable and useless is a distinct problem from unreachable, and saying
    // which saves a long afternoon.
    const fetcher = stubFetch({ body: { data: [{ id: 'llama3.1:8b' }] } })
    const result = await probeLlm(settings, fetcher.impl)

    expect(result.ok).toBe(true)
    expect(result.warning).toMatch(/qwen2\.5:14b/)
  })

  it('says what the endpoint said when it refuses', async () => {
    const fetcher = stubFetch({ status: 401, body: { error: { message: 'invalid api key' } } })
    const result = await probeLlm(settings, fetcher.impl)

    expect(result.ok).toBe(false)
    expect(result.detail).toMatch(/401/)
  })

  it('says plainly when nothing answered at all', async () => {
    const fetcher = stubFetch({ throws: 'connect ECONNREFUSED 10.0.0.5:8000' })
    const result = await probeLlm(settings, fetcher.impl)

    expect(result.ok).toBe(false)
    expect(result.detail).toMatch(/ECONNREFUSED|could not be reached/i)
  })

  it('does not mind a base URL given with a trailing slash', async () => {
    const fetcher = stubFetch({ body: { data: [] } })
    await probeLlm({ ...settings, baseUrl: 'http://ollama:11434/v1/' }, fetcher.impl)
    expect(fetcher.calls[0]!.url).toBe('http://ollama:11434/v1/models')
  })
})

describe('asking a model for something', () => {
  it('sends the conversation to the completions endpoint', async () => {
    const fetcher = stubFetch({
      body: { choices: [{ message: { role: 'assistant', content: 'A short summary.' } }] },
    })

    const answer = await chatWithLlm(
      settings,
      [{ role: 'user', content: 'Summarise this.' }],
      { fetchImpl: fetcher.impl },
    )

    expect(fetcher.calls[0]!.url).toBe('http://gpu-box.internal:8000/v1/chat/completions')
    const sent = JSON.parse(String(fetcher.calls[0]!.init.body))
    expect(sent.model).toBe('qwen2.5:14b')
    expect(sent.messages[0].content).toBe('Summarise this.')
    expect(answer).toBe('A short summary.')
  })

  it('reports what went wrong rather than an empty answer', async () => {
    const fetcher = stubFetch({ status: 500, body: { error: { message: 'out of memory' } } })

    await expect(
      chatWithLlm(settings, [{ role: 'user', content: 'x' }], { fetchImpl: fetcher.impl }),
    ).rejects.toThrow(/out of memory|500/)
  })

  it('refuses to try when no model is configured', async () => {
    await expect(
      chatWithLlm(null, [{ role: 'user', content: 'x' }], { fetchImpl: stubFetch({}).impl }),
    ).rejects.toThrow(/not configured/i)
  })
})

/**
 * The web process and the workers sit on different networks: on the shipped
 * compose the workers have no route off the host at all. So one of them
 * reaching a model says nothing about the other, and it is the workers that do
 * the work.
 */
describe('deciding whether a job would actually reach a model', () => {
  const verified = { ...settings, verifiedAt: Date.now() }
  const confirmed = {
    ok: true,
    detail: 'Answered.',
    at: Date.now(),
    baseUrl: settings.baseUrl,
    model: settings.model,
  }

  it('needs the workers to have said so, not just the web process', async () => {
    expect(isLlmUsable(verified, null)).toBe(false)
    expect(isLlmUsable(verified, confirmed)).toBe(true)
  })

  it('does not accept a worker report about a different endpoint', async () => {
    // The address was changed after the workers last looked.
    expect(isLlmUsable({ ...verified, baseUrl: 'http://elsewhere:8000/v1' }, confirmed)).toBe(false)
    expect(isLlmUsable({ ...verified, model: 'other-model' }, confirmed)).toBe(false)
  })

  it('does not accept a worker report that failed', async () => {
    expect(isLlmUsable(verified, { ...confirmed, ok: false })).toBe(false)
  })

  it('remembers what the workers found, between processes', async () => {
    await writeRunnerLlmStatus(dir, confirmed)
    expect(await readRunnerLlmStatus(dir)).toMatchObject({ ok: true, model: settings.model })
  })

  it('reads as unknown when the workers have not reported yet', async () => {
    expect(await readRunnerLlmStatus(dir)).toBeNull()
  })
})
