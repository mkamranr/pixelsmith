import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import fp from 'fastify-plugin'
import type { User } from '@pixelsmith/db'
import type { AppContext } from '../context.js'
import { ForbiddenError, UnauthorizedError } from '../errors.js'

declare module 'fastify' {
  interface FastifyRequest {
    /** The signed-in user, or undefined for an anonymous request. */
    currentUser?: User
    sessionToken?: string
  }
  interface FastifyInstance {
    requireUser: (req: FastifyRequest, reply: FastifyReply) => Promise<void>
    requireAdmin: (req: FastifyRequest, reply: FastifyReply) => Promise<void>
  }
}

export const SESSION_COOKIE = 'pixelsmith_session'

/**
 * Resolves the session on every request and exposes two guards.
 *
 * Guards are per-route rather than global. That is a deliberate trade: a route
 * that forgets its guard is anonymous, but the requirement is stated where the
 * route is defined, which is where a reviewer will look for it.
 */
export interface AuthPluginOptions {
  ctx: AppContext
}

// The generic is given to fp() explicitly: without it the inner callback's
// parameters infer as `any`, which silently drops type checking on every hook.
export const authPlugin = fp<AuthPluginOptions>(
  async (app: FastifyInstance, opts: AuthPluginOptions) => {
    const { ctx } = opts

    app.addHook('onRequest', async (req) => {
      const raw = req.cookies[SESSION_COOKIE]
      if (!raw) return

      const unsigned = req.unsignCookie(raw)
      if (!unsigned.valid || !unsigned.value) return

      const resolved = await ctx.sessions.resolveSession(unsigned.value)
      if (!resolved) return

      req.currentUser = resolved.user
      req.sessionToken = unsigned.value
    })

    app.decorate('requireUser', async (req: FastifyRequest) => {
      if (!req.currentUser) throw new UnauthorizedError()
    })

    app.decorate('requireAdmin', async (req: FastifyRequest) => {
      if (!req.currentUser) throw new UnauthorizedError()
      if (req.currentUser.role !== 'admin') throw new ForbiddenError('Administrator access required')
    })
  },
  { name: 'pixelsmith-auth' },
)
