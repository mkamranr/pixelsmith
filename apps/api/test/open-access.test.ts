import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BOUNDARY, cookieJar, csrfFrom, multipart, openApp, samplePng } from './helpers/app.js'

let h: Awaited<ReturnType<typeof openApp>>
beforeEach(async () => { h = await openApp() })
afterEach(() => h.close())

const uploadHeaders = (cookie: string) => ({
  cookie,
  'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
})

describe('open access is the default', () => {
  it('reports which mode it is in', () => {
    expect(h.ctx.config.AUTH_MODE).toBe('open')
  })

  it('lets an anonymous visitor reach a tool page', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/tools/resize' })
    expect(res.statusCode).toBe(200)
    // No sign-in prompt anywhere on it.
    expect(res.body).not.toContain('Sign in')
    expect(res.body).toContain('Choose images')
  })

  it('lets an anonymous visitor reach their job list', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/jobs' })
    expect(res.statusCode).toBe(200)
  })

  it('processes an upload with no sign-in at all', async () => {
    const page = await h.app.inject({ method: 'GET', url: '/tools/resize' })
    const res = await h.app.inject({
      method: 'POST',
      url: '/tools/resize',
      headers: uploadHeaders(cookieJar(page)),
      payload: multipart({ mode: 'pixels', width: '60', _csrf: csrfFrom(page.body) }, [
        { name: 'files', filename: 'x.png', data: await samplePng(200, 150) },
      ]),
    })
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toMatch(/^\/jobs\/[0-9a-f-]{36}$/)

    await h.ctx.queue.close()
    const id = String(res.headers.location).replace('/jobs/', '')
    const status = await h.app.inject({
      method: 'GET',
      url: `/api/jobs/${id}`,
      headers: { cookie: cookieJar(page, res) },
    })
    expect(status.json().status).toBe('done')
  })

  it('still keeps one visitor’s work out of another’s view', async () => {
    // Not authentication — just identity, so a shared machine does not turn
    // into a shared folder of everyone's uploads.
    const page = await h.app.inject({ method: 'GET', url: '/tools/resize' })
    const created = await h.app.inject({
      method: 'POST',
      url: '/tools/resize',
      headers: uploadHeaders(cookieJar(page)),
      payload: multipart({ mode: 'pixels', width: '60', _csrf: csrfFrom(page.body) }, [
        { name: 'files', filename: 'mine.png', data: await samplePng(120, 90) },
      ]),
    })
    const id = String(created.headers.location).replace('/jobs/', '')

    // A different browser, with no cookie of its own.
    const stranger = await h.app.inject({ method: 'GET', url: `/jobs/${id}` })
    expect(stranger.statusCode).toBe(404)
  })

  it('keeps a visitor’s identity across requests', async () => {
    const first = await h.app.inject({ method: 'GET', url: '/tools/resize' })
    const created = await h.app.inject({
      method: 'POST',
      url: '/tools/resize',
      headers: uploadHeaders(cookieJar(first)),
      payload: multipart({ mode: 'pixels', width: '40', _csrf: csrfFrom(first.body) }, [
        { name: 'files', filename: 'a.png', data: await samplePng(80, 60) },
      ]),
    })
    const cookie = cookieJar(first, created)

    const list = await h.app.inject({ method: 'GET', url: '/jobs', headers: { cookie } })
    expect(list.body).toContain('resize')
  })

  it('does not create a visitor record for someone merely browsing', async () => {
    await h.app.inject({ method: 'GET', url: '/' })
    await h.app.inject({ method: 'GET', url: '/api/docs' })
    // A crawler or health check must not add rows.
    expect(await h.ctx.users.countUsers()).toBe(0)
  })

  it('hides the sign-in and account links from the header', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/' })
    expect(res.body).not.toContain('href="/login"')
    expect(res.body).not.toContain('href="/account"')
  })

  it('serves no sign-in page', async () => {
    expect((await h.app.inject({ method: 'GET', url: '/login' })).statusCode).toBe(404)
  })

  it('serves no user administration', async () => {
    expect((await h.app.inject({ method: 'GET', url: '/admin/users' })).statusCode).toBe(404)
  })

  it('still refuses a forged upload without a CSRF token', async () => {
    // Open access is not the same as no protection.
    const res = await h.app.inject({
      method: 'POST',
      url: '/tools/resize',
      headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
      payload: multipart({ mode: 'pixels', width: '60' }, [
        { name: 'files', filename: 'x.png', data: await samplePng() },
      ]),
    })
    expect(res.statusCode).toBe(403)
  })

  it('still refuses a path-traversal job id', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/jobs/..%2F..%2Fetc' })
    expect(res.statusCode).toBeGreaterThanOrEqual(400)
  })
})
