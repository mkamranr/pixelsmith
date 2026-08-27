import { timingSafeEqual } from 'node:crypto'

import type { FastifyRequest } from 'fastify'

import type { AppContext } from './context.js'

/**
 * Who may look at a job. One rule, two ways to prove it, used by every route
 * that resolves one.
 *
 * A browser proves it with the session or visitor cookie it was given when it
 * created the job. A script proves it with the token the create response handed
 * back, sent as `X-Job-Token`.
 *
 * Both are needed. Cookies alone broke every client that does not keep them,
 * which is most scripts: `POST` then poll `statusUrl` failed from plain curl
 * while passing in the tests, because the tests carried the cookie forward and
 * a shell script does not. Treating the id alone as proof would have fixed that
 * by making every job readable to anyone who learns its id — and one visitor's
 * uploads are deliberately not another's to read, even with no accounts.
 */
export async function jobFor(ctx: AppContext, req: FastifyRequest, id: string) {
  const job = await ctx.jobs.getJob(id)
  if (!job) return undefined
  if (req.currentUser && job.userId === req.currentUser.id) return job
  return presentsToken(req, job.readToken) ? job : undefined
}

/** Compared without leaking how much of it was right, in constant time. */
function presentsToken(req: FastifyRequest, expected: string | null): boolean {
  const offered = req.headers['x-job-token']
  if (!expected || typeof offered !== 'string' || offered.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(offered), Buffer.from(expected))
}
