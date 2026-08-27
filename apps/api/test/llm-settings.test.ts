import { createServer, type Server } from 'node:http'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { writeRunnerLlmStatus } from '@pixelsmith/core'
import { BOUNDARY, cookieJar, csrfFrom, multipart, openApp, samplePng } from './helpers/app.js'

let h: Awaited<ReturnType<typeof openApp>>
let server: Server
let port: number
/** Whether the stand-in model answers at all. */
let answering = true

beforeAll(async () => {
  server = createServer((req, res) => {
    if (!answering) {
      res.writeHead(500)
      res.end('{}')
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'test-model' }] }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as { port: number }).port
})

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

beforeEach(async () => {
  answering = true
  h = await openApp()
})
afterEach(() => h.close())

/** Post the settings form the way the page does: no files, so form-encoded. */
async function save(fields: Record<string, string>) {
  const page = await h.app.inject({ method: 'GET', url: '/settings/llm' })
  return h.app.inject({
    method: 'POST',
    url: '/settings/llm',
    headers: { cookie: cookieJar(page), 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ ...fields, _csrf: csrfFrom(page.body) }).toString(),
  })
}

const reachable = () => ({ baseUrl: `http://127.0.0.1:${port}/v1`, model: 'test-model' })

describe('configuring a language model', () => {
  it('offers a page that says nothing is set up yet', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/settings/llm' })

    expect(res.statusCode).toBe(200)
    expect(res.body).toMatch(/not configured|no model/i)
  })

  it('remembers what it was told, and confirms the endpoint answered', async () => {
    const res = await save(reachable())

    expect(res.statusCode).toBe(302)
    const page = await h.app.inject({ method: 'GET', url: '/settings/llm' })
    expect(page.body).toContain('test-model')
    // This server reached it. Whether the workers can is a separate question,
    // reported separately, and the one that decides whether tools appear.
    expect(page.body).toMatch(/reached it/i)
  })

  it('stores the settings but stays switched off when nothing answers', async () => {
    answering = false
    await save(reachable())

    const page = await h.app.inject({ method: 'GET', url: '/settings/llm' })
    // Kept, so a typo can be corrected rather than retyped — but not trusted.
    expect(page.body).toContain('test-model')
    expect(page.body).toMatch(/could not|not reachable|500/i)
  })

  it('never puts the key back on the page', async () => {
    await save({ ...reachable(), apiKey: 'sk-secret-value-here' })

    const page = await h.app.inject({ method: 'GET', url: '/settings/llm' })
    expect(page.body).not.toContain('sk-secret-value-here')
    // It does say that one is set, which is what an operator needs to know.
    expect(page.body).toMatch(/a key is set|key is stored/i)
  })
})

describe('features that need a model', () => {
  const home = async () => (await h.app.inject({ method: 'GET', url: '/' })).body

  it('are not offered at all until a model has answered', async () => {
    /**
     * Hidden rather than shown-and-broken: a menu entry that always fails is
     * worse than one that is not there, and the registry drives the menus, so
     * one declaration keeps them out of every list.
     */
    expect(await home()).not.toContain('summarise-pdf')
  })

  it('stay hidden while only the web process has reached it', async () => {
    /**
     * The web process and the workers are not on the same network — on the
     * shipped compose the workers have no route off the host. A model this
     * process can reach may be unreachable from the one that does the work, and
     * a menu entry that always fails is exactly what the gate is for.
     */
    await save(reachable())
    expect(await home()).not.toContain('summarise-pdf')
  })

  it('appear once the workers confirm the same endpoint', async () => {
    await save(reachable())
    await writeRunnerLlmStatus(h.dir, {
      ok: true,
      detail: 'Answered.',
      at: Date.now(),
      ...reachable(),
    })
    await h.ctx.refreshCapabilities()

    expect(await home()).toContain('summarise-pdf')
  })

  it('disappear again if the workers stop reaching it', async () => {
    await save(reachable())
    await writeRunnerLlmStatus(h.dir, { ok: true, detail: 'Answered.', at: Date.now(), ...reachable() })
    await h.ctx.refreshCapabilities()
    expect(await home()).toContain('summarise-pdf')

    await writeRunnerLlmStatus(h.dir, {
      ok: false,
      detail: 'It could not be reached.',
      at: Date.now(),
      ...reachable(),
    })
    await h.ctx.refreshCapabilities()
    expect(await home()).not.toContain('summarise-pdf')
  })

  it('ignore a worker report about a different endpoint', async () => {
    // Someone changed the address; the old confirmation means nothing now.
    await save(reachable())
    await writeRunnerLlmStatus(h.dir, {
      ok: true,
      detail: 'Answered.',
      at: Date.now(),
      baseUrl: 'http://stale:8000/v1',
      model: 'test-model',
    })
    await h.ctx.refreshCapabilities()

    expect(await home()).not.toContain('summarise-pdf')
  })

  it('are refused by the API with a reason, not a puzzle', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/jobs',
      headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
      payload: multipart({ tool: 'summarise-pdf' }, [
        { name: 'files', filename: 'a.png', data: await samplePng() },
      ]),
    })

    expect(res.statusCode).toBe(503)
    expect((res.json() as { error: { message: string } }).error.message).toMatch(/language model/i)
  })

  it('are still described by the API, so a client can see why it cannot use them', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/tools' })
    const tools = (res.json() as { tools: { id: string; available: boolean; requires?: string }[] }).tools
    const summarise = tools.find((t) => t.id === 'summarise-pdf')

    expect(summarise).toBeDefined()
    expect(summarise!.available).toBe(false)
    expect(summarise!.requires).toBe('llm')
  })
})

describe('what the settings page says about the workers', () => {
  it('reports the workers separately, since they are the ones that matter', async () => {
    await save(reachable())
    const page = await h.app.inject({ method: 'GET', url: '/settings/llm' })

    expect(page.body).toMatch(/workers/i)
    expect(page.body).toMatch(/have not reported yet/i)
  })
})
