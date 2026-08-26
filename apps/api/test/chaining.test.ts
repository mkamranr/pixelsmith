import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BOUNDARY, cookieJar, csrfFrom, multipart, samplePng, signIn, testApp } from './helpers/app.js'

let h: Awaited<ReturnType<typeof testApp>>

beforeEach(async () => {
  h = await testApp()
})
afterEach(() => h.close())

/** Run a resize job and return its finished id. */
async function completedJob(cookie: string, tool = 'resize', fields: Record<string, string> = { mode: 'pixels', width: '60' }) {
  const page = await h.app.inject({ method: 'GET', url: `/tools/${tool}`, headers: { cookie } })
  const res = await h.app.inject({
    method: 'POST',
    url: `/tools/${tool}`,
    headers: {
      cookie: cookieJar(cookie, page),
      'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
    },
    payload: multipart({ ...fields, _csrf: csrfFrom(page.body) }, [
      { name: 'files', filename: 'start.png', data: await samplePng(200, 150) },
    ]),
  })
  const id = String(res.headers.location).replace('/jobs/', '')
  await h.ctx.queue.close()
  return id
}

describe('carrying results into another tool', () => {
  it('offers the results of a finished job as the input to another tool', async () => {
    const { cookie } = await signIn(h, 'chain@example.test')
    const first = await completedJob(cookie)

    const page = await h.app.inject({ method: 'GET', url: `/tools/rotate?from=${first}`, headers: { cookie } })
    expect(page.statusCode).toBe(200)
    // The carried file is named on the page, so the user can see what will be used.
    expect(page.body).toContain('start.png')
    expect(page.body).toContain(`value="${first}"`)
  })

  it('runs the second tool on those results without a re-upload', async () => {
    const { cookie } = await signIn(h, 'chain2@example.test')
    const first = await completedJob(cookie)

    const page = await h.app.inject({ method: 'GET', url: `/tools/rotate?from=${first}`, headers: { cookie } })
    const res = await h.app.inject({
      method: 'POST',
      url: '/tools/rotate',
      headers: {
        cookie: cookieJar(cookie, page),
        'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
      },
      // No file parts at all: the source job is the input.
      payload: multipart({ angle: '90', fromJob: first, _csrf: csrfFrom(page.body) }, []),
    })

    expect(res.statusCode).toBe(302)
    const second = String(res.headers.location).replace('/jobs/', '')
    expect(second).not.toBe(first)

    await h.ctx.queue.close()
    const status = await h.app.inject({ method: 'GET', url: `/api/jobs/${second}`, headers: { cookie } })
    const body = status.json()
    expect(body.status).toBe('done')
    expect(body.outputs).toHaveLength(1)
  })

  it('refuses to carry results from a job belonging to someone else', async () => {
    const owner = await signIn(h, 'owner2@example.test')
    const first = await completedJob(owner.cookie)

    const intruder = await signIn(h, 'intruder2@example.test')
    const page = await h.app.inject({
      method: 'GET',
      url: `/tools/rotate?from=${first}`,
      headers: { cookie: intruder.cookie },
    })
    expect(page.statusCode).toBe(404)
  })

  it('refuses a submitted fromJob that the user does not own', async () => {
    const owner = await signIn(h, 'owner3@example.test')
    const first = await completedJob(owner.cookie)

    const intruder = await signIn(h, 'intruder3@example.test')
    const page = await h.app.inject({ method: 'GET', url: '/tools/rotate', headers: { cookie: intruder.cookie } })
    const res = await h.app.inject({
      method: 'POST',
      url: '/tools/rotate',
      headers: {
        cookie: cookieJar(intruder.cookie, page),
        'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
      },
      payload: multipart({ angle: '90', fromJob: first, _csrf: csrfFrom(page.body) }, []),
    })
    // Sent back with an explanation rather than silently processing nothing.
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toContain('error=')
  })

  it('ignores a fromJob whose files have already been purged', async () => {
    const { cookie } = await signIn(h, 'expired@example.test')
    const first = await completedJob(cookie)
    // Simulate the retention sweeper having run.
    await h.ctx.storage.remove(first)
    await h.ctx.jobs.markExpired(first)

    const page = await h.app.inject({ method: 'GET', url: `/tools/rotate?from=${first}`, headers: { cookie } })
    expect(page.statusCode).toBe(200)
    expect(page.body).not.toContain('start.png')
  })

  it('links onward from the results page', async () => {
    const { cookie } = await signIn(h, 'links@example.test')
    const first = await completedJob(cookie)
    const jobPage = await h.app.inject({ method: 'GET', url: `/jobs/${first}`, headers: { cookie } })
    expect(jobPage.body).toContain(`/tools/rotate?from=${first}`)
  })
})
