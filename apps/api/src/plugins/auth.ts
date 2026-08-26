import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import fp from 'fastify-plugin'
import type { User } from '@pixelsmith/db'
import type { AppContext } from '../context.js'
import { randomBytes, randomUUID } from 'node:crypto'
import { ForbiddenError, NotFoundError, UnauthorizedError } from '../errors.js'

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
/** Anonymous, password-less identity used when AUTH_MODE is `open`. */
export const VISITOR_COOKIE = 'pixelsmith_visitor'
const VISITOR_TTL_SECONDS = 60 * 60 * 24 * 30

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

    const open = ctx.config.isOpenAccess

    app.addHook('onRequest', async (req) => {
      if (open) {
        // Resolve an existing visitor, but never create one here: a crawler or
        // a health check must not add a row just by looking at a page.
        const raw = req.cookies[VISITOR_COOKIE]
        if (!raw) return
        const unsigned = req.unsignCookie(raw)
        if (!unsigned.valid || !unsigned.value) return
        const visitor = await ctx.users.findById(unsigned.value)
        if (visitor?.isActive) req.currentUser = visitor
        return
      }

      const raw = req.cookies[SESSION_COOKIE]
      if (!raw) return

      const unsigned = req.unsignCookie(raw)
      if (!unsigned.valid || !unsigned.value) return

      const resolved = await ctx.sessions.resolveSession(unsigned.value)
      if (!resolved) return

      req.currentUser = resolved.user
      req.sessionToken = unsigned.value
    })

    /**
     * Mint an anonymous visitor on first use. A real row is created so job
     * ownership, foreign keys and the audit trail all keep working unchanged;
     * the password is random and never used for anything.
     */
    const ensureVisitor = async (req: FastifyRequest, reply: FastifyReply) => {
      if (req.currentUser) return
      const visitor = await ctx.users.createUser({
        email: `visitor-${randomUUID()}@local`,
        name: 'Guest',
        password: randomBytes(24).toString('base64url'),
      })
      req.currentUser = visitor
      reply.setCookie(VISITOR_COOKIE, visitor.id, {
        path: '/',
        httpOnly: true,
        sameSite: 'strict',
        signed: true,
        secure: ctx.config.isProduction,
        maxAge: VISITOR_TTL_SECONDS,
      })
    }

    app.decorate('requireUser', async (req: FastifyRequest, reply: FastifyReply) => {
      if (open) return ensureVisitor(req, reply)
      if (!req.currentUser) throw new UnauthorizedError()
    })

    app.decorate('requireAdmin', async (req: FastifyRequest) => {
      // With no accounts there is no administrator, so these routes simply do
      // not exist rather than reporting that access was denied.
      if (open) throw new NotFoundError('Page')
      if (!req.currentUser) throw new UnauthorizedError()
      if (req.currentUser.role !== 'admin') throw new ForbiddenError('Administrator access required')
    })
  },
  { name: 'pixelsmith-auth' },
)
