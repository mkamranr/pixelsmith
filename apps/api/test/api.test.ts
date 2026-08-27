import { PDFDocument, StandardFonts } from 'pdf-lib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BOUNDARY, cookieJar, multipart, openApp, samplePng, signIn, testApp } from './helpers/app.js'

let h: Awaited<ReturnType<typeof openApp>>

beforeEach(async () => {
  h = await openApp()
})
afterEach(() => h.close())

const headers = { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` }

/** A small labelled PDF, so a result can be told apart from its inputs. */
async function samplePdf(labels: string[]): Promise<Buffer> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (const label of labels) {
    doc.addPage([200, 300]).drawText(label, { x: 20, y: 150, size: 24, font })
  }
  return Buffer.from(await doc.save())
}

/**
 * Create a job the way a script would: one request, no page fetched first, no
 * token scraped out of HTML.
 */
const create = (fields: Record<string, string>, files: { name: string; filename: string; data: Buffer }[]) =>
  h.app.inject({ method: 'POST', url: '/api/jobs', headers, payload: multipart(fields, files) })

describe('creating a job over the API', () => {
  it('takes an image tool and answers with the job', async () => {
    const res = await create({ tool: 'resize', mode: 'pixels', width: '320' }, [
      { name: 'files', filename: 'a.png', data: await samplePng() },
    ])

    expect(res.statusCode).toBe(202)
    const body = res.json() as Record<string, string>
    expect(body.tool).toBe('resize')
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(body.status).toBeDefined()
    // Somewhere to poll and somewhere to watch, so a client needs no guesswork.
    expect(body.statusUrl).toBe(`/api/jobs/${body.id}`)
    expect(body.eventsUrl).toBe(`/api/jobs/${body.id}/events`)
  })

  it('takes a PDF tool with several documents', async () => {
    const res = await create({ tool: 'merge-pdf', filename: 'joined' }, [
      { name: 'files', filename: 'one.pdf', data: await samplePdf(['A']) },
      { name: 'files', filename: 'two.pdf', data: await samplePdf(['B']) },
    ])

    expect(res.statusCode).toBe(202)
    expect((res.json() as { tool: string }).tool).toBe('merge-pdf')
  })

  it('needs no CSRF token, being an API rather than a form', async () => {
    // The browser form scrapes a token from the page it was served on. A script
    // has no page, and demanding one would make the API unusable.
    const res = await create({ tool: 'rotate', angle: '90' }, [
      { name: 'files', filename: 'a.png', data: await samplePng() },
    ])
    expect(res.statusCode).toBe(202)
  })

  it('lets the caller read back the job it just made', async () => {
    const created = await create({ tool: 'resize', mode: 'pixels', width: '100' }, [
      { name: 'files', filename: 'a.png', data: await samplePng() },
    ])
    const { id } = created.json() as { id: string }

    const read = await h.app.inject({
      method: 'GET',
      url: `/api/jobs/${id}`,
      headers: { cookie: cookieJar(created) },
    })

    expect(read.statusCode).toBe(200)
    expect((read.json() as { id: string }).id).toBe(id)
  })

  /**
   * The test above carries the cookie the create response set, which is why the
   * suite never noticed this: a script does not. `curl` without `-c/-b`,
   * `requests.post` without a Session, a `fetch` in a shell one-liner — none of
   * them keep cookies, and every cookie-less request used to mint a fresh
   * anonymous visitor, so the poll asked as somebody who had never created
   * anything and got told the job did not exist. The create response hands back
   * a token for exactly this, so a script needs no cookie jar.
   */
  it('lets a script poll a job without carrying a cookie', async () => {
    const created = await create({ tool: 'resize', mode: 'pixels', width: '100' }, [
      { name: 'files', filename: 'a.png', data: await samplePng() },
    ])
    const { id, statusUrl, token } = created.json() as {
      id: string
      statusUrl: string
      token: string
    }

    const read = await h.app.inject({
      method: 'GET',
      url: statusUrl,
      headers: { 'x-job-token': token },
    })

    expect(read.statusCode).toBe(200)
    expect((read.json() as { id: string }).id).toBe(id)
  })

  it('lets that script download the result without carrying a cookie either', async () => {
    const created = await create({ tool: 'resize', mode: 'pixels', width: '60' }, [
      { name: 'files', filename: 'a.png', data: await samplePng() },
    ])
    const { statusUrl, token } = created.json() as { statusUrl: string; token: string }
    const carrying = { 'x-job-token': token }

    await h.ctx.queue.close()
    const read = await h.app.inject({ method: 'GET', url: statusUrl, headers: carrying })
    const [output] = (read.json() as { outputs: { url: string }[] }).outputs
    expect(output).toBeDefined()
    const file = await h.app.inject({ method: 'GET', url: output!.url, headers: carrying })

    expect(file.statusCode).toBe(200)
    expect(file.rawPayload.length).toBeGreaterThan(0)
  })

  it('does not add an account for every poll a script makes', async () => {
    // Thirty polls of one job used to leave thirty user rows behind, in a
    // database nobody prunes.
    const created = await create({ tool: 'resize', mode: 'pixels', width: '100' }, [
      { name: 'files', filename: 'a.png', data: await samplePng() },
    ])
    const { statusUrl, token } = created.json() as { statusUrl: string; token: string }
    const before = await h.ctx.users.countUsers()

    for (let i = 0; i < 5; i += 1) {
      await h.app.inject({ method: 'GET', url: statusUrl, headers: { 'x-job-token': token } })
    }

    expect(await h.ctx.users.countUsers()).toBe(before)
  })

  it('refuses a caller with neither the cookie nor the token', async () => {
    // The id is not the permission: a job id that turns up in a log, a pasted
    // link or someone's history does not open the file.
    const created = await create({ tool: 'resize', mode: 'pixels', width: '100' }, [
      { name: 'files', filename: 'a.png', data: await samplePng() },
    ])
    const { statusUrl, token } = created.json() as { statusUrl: string; token: string }

    const bare = await h.app.inject({ method: 'GET', url: statusUrl })
    const wrong = await h.app.inject({
      method: 'GET',
      url: statusUrl,
      headers: { 'x-job-token': `${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}` },
    })

    expect(bare.statusCode).toBe(404)
    expect(wrong.statusCode).toBe(404)
  })

  it('says which tool it does not have', async () => {
    const res = await create({ tool: 'not-a-tool' }, [
      { name: 'files', filename: 'a.png', data: await samplePng() },
    ])
    expect(res.statusCode).toBe(404)
  })

  it('says what is wrong with the settings, rather than failing later', async () => {
    const res = await create({ tool: 'resize', mode: 'pixels', width: 'wide' }, [
      { name: 'files', filename: 'a.png', data: await samplePng() },
    ])

    expect(res.statusCode).toBe(400)
    expect((res.json() as { error: { message: string } }).error.message).toMatch(/width/i)
  })

  it('refuses a file the tool cannot read, in the words the form would use', async () => {
    /**
     * The API and the form share one intake. This is the case that was broken
     * once before, when they did not: a PNG offered to a PDF tool passed the
     * door and failed in a worker.
     */
    const res = await create({ tool: 'merge-pdf' }, [
      { name: 'files', filename: 'a.png', data: await samplePng() },
    ])

    // 415 rather than 400: the request was well formed, the file was the wrong
    // sort of thing.
    expect(res.statusCode).toBe(415)
    expect((res.json() as { error: { message: string } }).error.message).toMatch(/PDF/i)
  })

  it('insists on a file for a tool that works on one', async () => {
    const res = await create({ tool: 'resize', width: '100' }, [])
    expect(res.statusCode).toBe(400)
  })

  it('accepts a tool that takes no files at all', async () => {
    const res = await create(
      { tool: 'html-to-pdf', source: 'html', html: '<h1>From a script</h1>', pageSize: 'a4' },
      [],
    )
    expect(res.statusCode).toBe(202)
  })
})

describe('what the API says about itself', () => {
  it('lists every tool, both families, with the endpoints to use', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/tools' })
    const body = res.json() as { tools: { id: string; family: string }[] }

    expect(res.statusCode).toBe(200)
    expect(body.tools.some((t) => t.family === 'image')).toBe(true)
    expect(body.tools.some((t) => t.family === 'pdf')).toBe(true)
  })

  it('describes one tool well enough to call it without reading the source', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/tools/redact-pdf' })
    const body = res.json() as { id: string; accepts: string[]; params: unknown }

    expect(body.id).toBe('redact-pdf')
    expect(body.accepts).toContain('application/pdf')
    expect(body.params).toBeDefined()
  })
})

describe('the API under accounts mode', () => {
  it('refuses an anonymous caller when the deployment has accounts', async () => {
    // Open access is the default, but a deployment that turned accounts on must
    // not have an unauthenticated API sitting behind them.
    const guarded = await testApp()
    try {
      const res = await guarded.app.inject({
        method: 'POST',
        url: '/api/jobs',
        headers,
        payload: multipart({ tool: 'resize', width: '100' }, [
          { name: 'files', filename: 'a.png', data: await samplePng() },
        ]),
      })
      expect(res.statusCode).toBe(401)
    } finally {
      await guarded.close()
    }
  })
})

describe('one account cannot see another account\'s job', () => {
  let h: Awaited<ReturnType<typeof testApp>>

  beforeEach(async () => {
    h = await testApp()
  })
  afterEach(() => h.close())

  it('keeps the job to the account that created it', async () => {
    // With accounts switched off the job id is the permission, because there is
    // nothing else it could be. With accounts on, ownership decides — and the
    // change that made scripts work must not have quietly loosened this.
    const mine = await signIn(h, 'first@example.test')
    const created = await h.app.inject({
      method: 'POST',
      url: '/api/jobs',
      headers: { ...headers, cookie: mine.cookie },
      payload: multipart({ tool: 'resize', mode: 'pixels', width: '100' }, [
        { name: 'files', filename: 'a.png', data: await samplePng() },
      ]),
    })
    const { id } = created.json() as { id: string }

    const theirs = await signIn(h, 'second@example.test')
    const peek = await h.app.inject({
      method: 'GET',
      url: `/api/jobs/${id}`,
      headers: { cookie: theirs.cookie },
    })

    expect(peek.statusCode).toBe(404)
  })
})

describe('the documentation', () => {
  const docs = async () => (await h.app.inject({ method: 'GET', url: '/api/docs' })).body

  /**
   * Asserted against the page's own markers rather than its raw text: every
   * tool id appears in the navigation menus too, so a plain substring check
   * passes whether the documentation mentions them or not.
   */
  const documented = (body: string, attribute: string) =>
    [...body.matchAll(new RegExp(`${attribute}="([^"]+)"`, 'g'))].map((m) => m[1])

  it('documents the endpoint that actually creates a job', async () => {
    expect(documented(await docs(), 'data-api-endpoint')).toContain('POST /api/jobs')
  })

  it('documents both families of tool, not only the image ones', async () => {
    /**
     * The page listed `groups`, which is the image family alone — so half the
     * product was undocumented while appearing to be fully documented.
     */
    const tools = documented(await docs(), 'data-api-tool')

    expect(tools).toContain('redact-pdf')
    expect(tools).toContain('organize-pdf')
    expect(tools).toContain('compress')
    expect(tools.length).toBeGreaterThan(30)
  })

  it('does not offer an authentication method that does not exist', async () => {
    // The page advertised `Authorization: Bearer` API keys. The table is in the
    // schema; nothing verifies a key. Documenting it invites a support call at
    // best and a false sense of security at worst.
    expect(await docs()).not.toContain('Bearer')
  })

  it('teaches a script how to read back the job it created', async () => {
    // Without this the create call succeeds and every poll answers 404, which
    // reads as a broken server rather than a missing header.
    const body = await docs()

    expect(body).toContain('X-Job-Token')
    expect(body).toMatch(/curl[\s\S]{0,400}X-Job-Token/)
  })

  it('shows an example that would actually work', async () => {
    // The old one posted to the form endpoint without a CSRF token, which is a
    // 403 every time.
    const body = await docs()
    expect(body).toContain('POST')
    expect(body).not.toMatch(/curl[^<]*\/tools\//)
  })
})
