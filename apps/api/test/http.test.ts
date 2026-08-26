import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  BOUNDARY,
  cookieJar,
  csrfFrom,
  multipart,
  samplePng,
  signIn,
  testApp,
} from './helpers/app.js'

let h: Awaited<ReturnType<typeof testApp>>

beforeEach(async () => {
  h = await testApp()
})
afterEach(() => h.close())

const uploadHeaders = (cookie: string) => ({
  cookie,
  'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
})

/** Post an image to a tool, returning the response. */
async function upload(cookie: string, tool: string, fields: Record<string, string>, csrf?: string) {
  const page = await h.app.inject({ method: 'GET', url: `/tools/${tool}`, headers: { cookie } })
  const token = csrf ?? csrfFrom(page.body)
  return h.app.inject({
    method: 'POST',
    url: `/tools/${tool}`,
    headers: uploadHeaders(cookieJar(cookie, page)),
    payload: multipart({ ...fields, _csrf: token }, [
      { name: 'files', filename: 'input.png', data: await samplePng() },
    ]),
  })
}

describe('public access', () => {
  it('serves the tool index to anyone', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/' })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('Pixelsmith')
  })

  it('serves the API docs to anyone', async () => {
    expect((await h.app.inject({ method: 'GET', url: '/api/docs' })).statusCode).toBe(200)
  })

  it('reports health without a session', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/healthz' })
    expect(res.json()).toMatchObject({ status: 'ok' })
  })

  it('sets a restrictive content security policy', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/' })
    const csp = String(res.headers['content-security-policy'])
    expect(csp).toContain("default-src 'self'")
    expect(csp).not.toContain('unsafe-inline')
  })

  it('renders a 404 page for an unknown path', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/nope' })
    expect(res.statusCode).toBe(404)
  })

  it('returns JSON, not HTML, for an unknown API path', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/nope' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ error: { code: 'not_found' } })
  })
})

describe('requiring a session', () => {
  it.each(['/jobs', '/account', '/admin/users'])('sends an anonymous visitor from %s to sign in', async (url) => {
    const res = await h.app.inject({ method: 'GET', url })
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toContain('/login')
  })

  it('remembers where the visitor was headed', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/jobs' })
    expect(res.headers.location).toContain(encodeURIComponent('/jobs'))
  })

  it('answers the API with 401 JSON rather than a redirect', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/jobs/some-id' })
    expect(res.statusCode).toBe(401)
    expect(res.json().error.code).toBe('unauthorized')
  })
})

describe('signing in', () => {
  it('accepts correct credentials and issues a session', async () => {
    const { cookie, status } = await signIn(h, 'ok@example.test')
    expect(status).toBe(302)
    expect(cookie).toContain('pixelsmith_session')

    const res = await h.app.inject({ method: 'GET', url: '/jobs', headers: { cookie } })
    expect(res.statusCode).toBe(200)
  })

  it('rejects a wrong password without revealing whether the account exists', async () => {
    await h.ctx.users.createUser({ email: 'real@example.test', name: 'R', password: 'a-sufficiently-long-password' })
    const form = await h.app.inject({ method: 'GET', url: '/login' })

    const attempt = (email: string, password: string) =>
      h.app.inject({
        method: 'POST',
        url: '/login',
        headers: { cookie: cookieJar(form), 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({ email, password, _csrf: csrfFrom(form.body) }).toString(),
      })

    const wrongPassword = await attempt('real@example.test', 'wrong-password-here')
    const noSuchUser = await attempt('ghost@example.test', 'wrong-password-here')

    expect(wrongPassword.headers.location).toBe(noSuchUser.headers.location)
  })

  it('refuses a login form posted without a CSRF token', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ email: 'a@b.test', password: 'x' }).toString(),
    })
    expect(res.statusCode).toBe(403)
  })

  it('locks an account after repeated failures', async () => {
    await h.ctx.users.createUser({ email: 'lock@example.test', name: 'L', password: 'a-sufficiently-long-password' })
    const form = await h.app.inject({ method: 'GET', url: '/login' })

    for (let i = 0; i < 5; i++) {
      await h.app.inject({
        method: 'POST',
        url: '/login',
        headers: { cookie: cookieJar(form), 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({
          email: 'lock@example.test',
          password: 'definitely-wrong-here',
          _csrf: csrfFrom(form.body),
        }).toString(),
      })
    }

    const withRightPassword = await h.app.inject({
      method: 'POST',
      url: '/login',
      headers: { cookie: cookieJar(form), 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        email: 'lock@example.test',
        password: 'a-sufficiently-long-password',
        _csrf: csrfFrom(form.body),
      }).toString(),
    })
    expect(decodeURIComponent(String(withRightPassword.headers.location))).toMatch(/failed attempts/i)
  })

  it('invalidates the session on sign out', async () => {
    const { cookie } = await signIn(h, 'out@example.test')
    const page = await h.app.inject({ method: 'GET', url: '/account', headers: { cookie } })

    await h.app.inject({
      method: 'POST',
      url: '/logout',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ _csrf: csrfFrom(page.body) }).toString(),
    })

    const after = await h.app.inject({ method: 'GET', url: '/jobs', headers: { cookie } })
    expect(after.statusCode).toBe(302)
  })
})

describe('administration', () => {
  it('refuses an ordinary user, rather than redirecting them to sign in again', async () => {
    const { cookie } = await signIn(h, 'plain@example.test')
    const res = await h.app.inject({ method: 'GET', url: '/admin/users', headers: { cookie } })
    expect(res.statusCode).toBe(403)
  })

  it('admits an administrator', async () => {
    const { cookie } = await signIn(h, 'boss@example.test', 'a-sufficiently-long-password', 'admin')
    const res = await h.app.inject({ method: 'GET', url: '/admin/users', headers: { cookie } })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('boss@example.test')
  })

  it('does not let an administrator disable their own account', async () => {
    const { cookie } = await signIn(h, 'self@example.test', 'a-sufficiently-long-password', 'admin')
    const page = await h.app.inject({ method: 'GET', url: '/admin/users', headers: { cookie } })
    const me = await h.ctx.users.findByEmail('self@example.test')

    const res = await h.app.inject({
      method: 'POST',
      url: `/admin/users/${me!.id}/state`,
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ active: 'false', _csrf: csrfFrom(page.body) }).toString(),
    })

    expect(decodeURIComponent(String(res.headers.location))).toMatch(/cannot deactivate your own/i)
    expect((await h.ctx.users.findByEmail('self@example.test'))!.isActive).toBe(true)
  })
})

describe('uploads', () => {
  it('accepts an image and starts a job', async () => {
    const { cookie } = await signIn(h, 'up@example.test')
    const res = await upload(cookie, 'resize', { mode: 'pixels', width: '60' })
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toMatch(/^\/jobs\/[0-9a-f-]{36}$/)
  })

  it('refuses an upload with no CSRF token, before writing anything to disk', async () => {
    const { cookie } = await signIn(h, 'nocsrf@example.test')
    const res = await h.app.inject({
      method: 'POST',
      url: '/tools/resize',
      headers: uploadHeaders(cookie),
      payload: multipart({ mode: 'pixels', width: '60' }, [
        { name: 'files', filename: 'x.png', data: await samplePng() },
      ]),
    })
    expect(res.statusCode).toBe(403)
    // Nothing may be left behind by a rejected request.
    expect(await h.ctx.storage.listJobDirs()).toEqual([])
  })

  it('refuses an anonymous upload', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/tools/resize',
      headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
      payload: multipart({ mode: 'pixels', width: '60' }, [
        { name: 'files', filename: 'x.png', data: await samplePng() },
      ]),
    })
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toContain('/login')
  })

  it('sends the user back with an explanation when the file is not an image', async () => {
    const { cookie } = await signIn(h, 'bad@example.test')
    const page = await h.app.inject({ method: 'GET', url: '/tools/resize', headers: { cookie } })
    const res = await h.app.inject({
      method: 'POST',
      url: '/tools/resize',
      headers: uploadHeaders(cookieJar(cookie, page)),
      payload: multipart({ mode: 'pixels', width: '60', _csrf: csrfFrom(page.body) }, [
        { name: 'files', filename: 'notes.txt', data: Buffer.from('this is not an image') },
      ]),
    })
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toContain('/tools/resize?error=')
    expect(await h.ctx.storage.listJobDirs()).toEqual([])
  })

  it('rejects an unknown tool', async () => {
    const { cookie } = await signIn(h, 'unknown@example.test')
    const res = await h.app.inject({ method: 'GET', url: '/tools/does-not-exist', headers: { cookie } })
    expect(res.statusCode).toBe(404)
  })
})

describe('job ownership', () => {
  /** Run a job as one user and return its id. */
  async function jobFor(email: string) {
    const { cookie } = await signIn(h, email)
    const res = await upload(cookie, 'resize', { mode: 'pixels', width: '60' })
    const id = String(res.headers.location).replace('/jobs/', '')
    return { cookie, id }
  }

  it('shows a job to the person who ran it', async () => {
    const { cookie, id } = await jobFor('owner@example.test')
    const res = await h.app.inject({ method: 'GET', url: `/jobs/${id}`, headers: { cookie } })
    expect(res.statusCode).toBe(200)
  })

  it("hides a job from another signed-in user", async () => {
    const { id } = await jobFor('mine@example.test')
    const { cookie: intruder } = await signIn(h, 'nosy@example.test')
    const res = await h.app.inject({ method: 'GET', url: `/jobs/${id}`, headers: { cookie: intruder } })
    expect(res.statusCode).toBe(404)
  })

  it("refuses another user's zip download", async () => {
    const { id } = await jobFor('zip@example.test')
    const { cookie: intruder } = await signIn(h, 'thief@example.test')
    const res = await h.app.inject({ method: 'GET', url: `/jobs/${id}/download`, headers: { cookie: intruder } })
    expect(res.statusCode).toBe(404)
  })

  it("refuses another user's job status over the API", async () => {
    const { id } = await jobFor('api@example.test')
    const { cookie: intruder } = await signIn(h, 'peeker@example.test')
    const res = await h.app.inject({ method: 'GET', url: `/api/jobs/${id}`, headers: { cookie: intruder } })
    expect(res.statusCode).toBe(404)
  })

  it('rejects a job id that is not a uuid', async () => {
    const { cookie } = await signIn(h, 'weird@example.test')
    const res = await h.app.inject({ method: 'GET', url: '/jobs/..%2F..%2Fetc', headers: { cookie } })
    expect(res.statusCode).toBeGreaterThanOrEqual(400)
  })
})

describe('processing and download', () => {
  it('runs the job and serves a downloadable result', async () => {
    const { cookie } = await signIn(h, 'flow@example.test')
    const res = await upload(cookie, 'resize', { mode: 'pixels', width: '40' })
    const id = String(res.headers.location).replace('/jobs/', '')

    // The inline queue resolves as soon as its in-flight work settles.
    await h.ctx.queue.close()

    const status = await h.app.inject({ method: 'GET', url: `/api/jobs/${id}`, headers: { cookie } })
    const body = status.json()
    expect(body.status).toBe('done')
    expect(body.outputs).toHaveLength(1)

    const file = await h.app.inject({ method: 'GET', url: body.outputs[0].url, headers: { cookie } })
    expect(file.statusCode).toBe(200)
    expect(file.headers['content-type']).toBe('image/png')
    expect(file.headers['content-disposition']).toContain('attachment')
    expect(file.rawPayload.length).toBeGreaterThan(0)
  })
})

describe('supporting files', () => {
  it('records a second file field as an asset, not as another image to process', async () => {
    const { cookie } = await signIn(h, 'asset@example.test')
    const page = await h.app.inject({ method: 'GET', url: '/tools/watermark', headers: { cookie } })

    const res = await h.app.inject({
      method: 'POST',
      url: '/tools/watermark',
      headers: uploadHeaders(cookieJar(cookie, page)),
      payload: multipart({ mark: 'image', markScale: '30', _csrf: csrfFrom(page.body) }, [
        { name: 'files', filename: 'base.png', data: await samplePng(200, 150) },
        { name: 'markFile', filename: 'logo.png', data: await samplePng(40, 40) },
      ]),
    })
    expect(res.statusCode).toBe(302)
    const id = String(res.headers.location).replace('/jobs/', '')

    const files = await h.ctx.jobs.listFiles(id)
    expect(files.filter((f) => f.role === 'input')).toHaveLength(1)
    expect(files.filter((f) => f.role === 'asset').map((f) => f.name)).toEqual(['markFile'])

    await h.ctx.queue.close()
    expect((await h.ctx.jobs.getJob(id))?.status).toBe('done')
  })

  it('ignores an empty file input rather than failing the job', async () => {
    const { cookie } = await signIn(h, 'empty@example.test')
    const page = await h.app.inject({ method: 'GET', url: '/tools/watermark', headers: { cookie } })

    const res = await h.app.inject({
      method: 'POST',
      url: '/tools/watermark',
      headers: uploadHeaders(cookieJar(cookie, page)),
      // A file input the user never touched submits a zero-byte part.
      payload: multipart({ mark: 'text', text: 'DRAFT', _csrf: csrfFrom(page.body) }, [
        { name: 'files', filename: 'base.png', data: await samplePng(120, 90) },
        { name: 'markFile', filename: '', data: Buffer.alloc(0) },
      ]),
    })
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toMatch(/^\/jobs\//)
  })
})
