import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { loadConfig } from '../../src/config.js'
import { createContext } from '../../src/context.js'
import { buildServer } from '../../src/server.js'

/**
 * A complete server against a throwaway directory. Real routes, real database,
 * real cookies — only the port is absent, since inject() bypasses the socket.
 */
export async function testApp() {
  const dir = await mkdtemp(join(tmpdir(), 'pixelsmith-http-'))
  const config = loadConfig({
    NODE_ENV: 'test',
    DATA_DIR: dir,
    COOKIE_SECRET: 'x'.repeat(48),
    QUEUE_DRIVER: 'inline',
    LOG_LEVEL: 'silent',
  } as NodeJS.ProcessEnv)

  const ctx = await createContext(config)
  const app = await buildServer(ctx)
  await app.ready()

  return {
    app,
    ctx,
    dir,
    async close() {
      await app.close()
      await ctx.shutdown()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

/** Pull the CSRF token out of a rendered form. */
export function csrfFrom(html: string): string {
  const m = html.match(/name="_csrf" value="([^"]+)"/)
  if (!m) throw new Error('no CSRF token in response')
  return m[1]!
}

/**
 * Build a Cookie request header. Accepts either responses (whose Set-Cookie
 * headers are applied in order) or an existing Cookie header string to start
 * from, so a session can be carried across several requests.
 */
export function cookieJar(...sources: ({ headers: Record<string, unknown> } | string)[]): string {
  const jar = new Map<string, string>()

  const set = (name: string, value: string) => jar.set(name.trim(), value)

  for (const source of sources) {
    if (typeof source === 'string') {
      // An existing Cookie header: "a=1; b=2".
      for (const pair of source.split(';')) {
        if (!pair.trim()) continue
        const [name, ...rest] = pair.split('=')
        set(name!, rest.join('='))
      }
      continue
    }
    const raw = source.headers['set-cookie']
    const list = Array.isArray(raw) ? raw : raw ? [String(raw)] : []
    for (const entry of list) {
      const [pair] = entry.split(';')
      const [name, ...rest] = pair!.split('=')
      set(name!, rest.join('='))
    }
  }

  return [...jar].map(([k, v]) => `${k}=${v}`).join('; ')
}

export const BOUNDARY = 'pixelsmithtestboundary'

/**
 * Build a multipart body by hand. The upload route reads the stream directly,
 * so the test has to produce a genuine multipart payload rather than an object.
 */
export function multipart(fields: Record<string, string>, files: { name: string; filename: string; data: Buffer }[]) {
  const parts: Buffer[] = []
  for (const [key, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`),
    )
  }
  for (const file of files) {
    parts.push(
      Buffer.from(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\n` +
          `Content-Type: application/octet-stream\r\n\r\n`,
      ),
      file.data,
      Buffer.from('\r\n'),
    )
  }
  parts.push(Buffer.from(`--${BOUNDARY}--\r\n`))
  return Buffer.concat(parts)
}

export async function samplePng(width = 120, height = 80): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: '#4477aa' } })
    .png()
    .toBuffer()
}

/** Create a user directly, then sign in through the real login form. */
export async function signIn(
  h: Awaited<ReturnType<typeof testApp>>,
  email: string,
  password = 'a-sufficiently-long-password',
  role: 'admin' | 'user' = 'user',
) {
  await h.ctx.users.createUser({ email, name: email.split('@')[0]!, password, role })

  const form = await h.app.inject({ method: 'GET', url: '/login' })
  const token = csrfFrom(form.body)

  const res = await h.app.inject({
    method: 'POST',
    url: '/login',
    headers: { cookie: cookieJar(form), 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ email, password, _csrf: token }).toString(),
  })

  return { cookie: cookieJar(form, res), status: res.statusCode }
}
