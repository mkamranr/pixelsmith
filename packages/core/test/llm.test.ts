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

/** Like stubFetch, but answers a different way each call. */
function stubReplies(answers: { status?: number; body?: unknown }[]) {
  const calls: { url: string; init: RequestInit }[] = []
  const impl = async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init })
    const answer = answers[Math.min(calls.length - 1, answers.length - 1)]!
    return {
      ok: (answer.status ?? 200) < 400,
      status: answer.status ?? 200,
      async json() { return answer.body ?? {} },
      async text() { return JSON.stringify(answer.body ?? {}) },
    } as unknown as Response
  }
  return { impl: impl as unknown as typeof fetch, calls }
}

const bodyOf = (call: { init: RequestInit }) => JSON.parse(String(call.init.body))

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
describe('a model that thinks out loud', () => {
  /**
   * Reasoning models — Qwen's and DeepSeek's among them — narrate their working
   * inside <think> tags and put the answer after it. Both come back in the same
   * `content` field, so writing that field into a document puts the model's
   * private deliberation in front of the reader. Found the first time this ran
   * against a real Qwen: a summary PDF whose first two thirds were the model
   * talking to itself about how to write the summary.
   */
  const answerFor = (content: string) =>
    chatWithLlm(settings, [{ role: 'user', content: 'x' }], {
      fetchImpl: stubFetch({ body: { choices: [{ message: { content } }] } }).impl,
    })

  it('keeps the answer and drops the thinking', async () => {
    const said = await answerFor(
      '<think>The user wants one paragraph. I should not add anything extra.</think>\nThe upgrade finished in June.',
    )

    expect(said).toBe('The upgrade finished in June.')
  })

  it('drops thinking that runs over many lines, and more than one block', async () => {
    const said = await answerFor(
      '<think>\nfirst\nsecond\n</think>Part one.<think>more thought</think> Part two.',
    )

    expect(said).toBe('Part one. Part two.')
  })

  it('leaves an ordinary answer exactly as it came', async () => {
    const said = await answerFor('The contract expires in September. 4 < 5 and a > b.')

    expect(said).toBe('The contract expires in September. 4 < 5 and a > b.')
  })

  it('says it got no answer when the model only thought', async () => {
    // Better a clear failure than a document containing deliberation alone.
    await expect(answerFor('<think>Let me consider this at length.</think>   ')).rejects.toThrow(
      /reasoning but no answer/,
    )
  })

  it('says it got no answer when the thinking was cut off mid-sentence', async () => {
    // Ran out of tokens before closing the tag, so there is no answer at all.
    await expect(answerFor('<think>I will start by looking at the first')).rejects.toThrow(
      /reasoning but no answer/,
    )
  })

  it('ignores a reasoning field kept separate from the answer', async () => {
    // vLLM can be configured to split them out. Nothing to strip, but the
    // answer must not pick the wrong field up.
    const fetcher = stubFetch({
      body: {
        choices: [{ message: { reasoning_content: 'thinking about it', content: 'The answer.' } }],
      },
    })

    const said = await chatWithLlm(settings, [{ role: 'user', content: 'x' }], {
      fetchImpl: fetcher.impl,
    })

    expect(said).toBe('The answer.')
  })
})

describe('asking a model not to think out loud', () => {
  /**
   * Stripping the thinking afterwards still pays for it. The same one-sentence
   * summary from the same Qwen cost 199 completion tokens with thinking and 10
   * without, so this is the difference between a summary that takes a moment
   * and one that takes twenty — on a document split into many parts, multiplied
   * by every part.
   */
  const ok = { choices: [{ message: { content: 'The answer.' } }] }

  it('says so in the request', async () => {
    const fetcher = stubReplies([{ body: ok }])

    await chatWithLlm(settings, [{ role: 'user', content: 'x' }], { fetchImpl: fetcher.impl })

    expect(bodyOf(fetcher.calls[0]!).chat_template_kwargs).toEqual({ enable_thinking: false })
  })

  it('asks again without it when the endpoint will not accept the field', async () => {
    // vLLM and SGLang understand it and other servers ignore what they do not
    // know, but an endpoint that validates strictly would otherwise refuse
    // every request — a working model that never answers.
    const fetcher = stubReplies([
      { status: 400, body: { error: { message: 'unrecognised field chat_template_kwargs' } } },
      { body: ok },
    ])

    const said = await chatWithLlm(settings, [{ role: 'user', content: 'x' }], {
      fetchImpl: fetcher.impl,
    })

    expect(said).toBe('The answer.')
    expect(fetcher.calls).toHaveLength(2)
    expect(bodyOf(fetcher.calls[1]!).chat_template_kwargs).toBeUndefined()
    expect(bodyOf(fetcher.calls[1]!).messages).toEqual([{ role: 'user', content: 'x' }])
  })

  it('reports the refusal when asking again does not help either', async () => {
    // The second attempt's answer is the honest one: the field was never the
    // problem, and a real fault must not be reported as a retry that failed.
    const fetcher = stubReplies([{ status: 400, body: { error: { message: 'context too long' } } }])

    await expect(
      chatWithLlm(settings, [{ role: 'user', content: 'x' }], { fetchImpl: fetcher.impl }),
    ).rejects.toThrow(/context too long/)
  })

  it('does not ask twice when the endpoint failed for its own reasons', async () => {
    // A model out of memory is not a model objecting to a field.
    const fetcher = stubReplies([{ status: 500, body: { error: { message: 'out of memory' } } }])

    await expect(
      chatWithLlm(settings, [{ role: 'user', content: 'x' }], { fetchImpl: fetcher.impl }),
    ).rejects.toThrow(/out of memory/)
    expect(fetcher.calls).toHaveLength(1)
  })

  it('still strips thinking from a model that thinks anyway', async () => {
    // Not every server understands the field, and a model can be built to think
    // regardless. Asking is the saving; stripping is the guarantee.
    const fetcher = stubReplies([
      { body: { choices: [{ message: { content: '<think>hmm</think>The answer.' } }] } },
    ])

    const said = await chatWithLlm(settings, [{ role: 'user', content: 'x' }], {
      fetchImpl: fetcher.impl,
    })

    expect(said).toBe('The answer.')
  })
})

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
