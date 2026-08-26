import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../context.js'
import { BadRequestError, NotFoundError } from '../errors.js'

const back = (path: string, message: string) => `${path}?error=${encodeURIComponent(message)}`

export async function registerAdmin(app: FastifyInstance, ctx: AppContext) {
  app.get('/admin/users', { preHandler: app.requireAdmin }, async (req, reply) => {
    const q = req.query as { error?: string; ok?: string }
    const { pageData } = await import('../render.js')
    return reply.view('admin-users.njk', pageData(ctx, req, reply, {
      users: await ctx.users.listUsers(),
      error: q.error,
      ok: q.ok,
    }))
  })

  app.post('/admin/users', { preHandler: [app.requireAdmin, app.csrfProtection] }, async (req, reply) => {
    const body = req.body as { email?: string; name?: string; password?: string; role?: string }
    try {
      const user = await ctx.users.createUser({
        email: body.email ?? '',
        name: body.name ?? '',
        password: body.password ?? '',
        role: body.role === 'admin' ? 'admin' : 'user',
        // An admin-chosen password is a shared secret until the owner replaces it.
        mustChangePassword: true,
      })
      await ctx.audit.record({
        userId: req.currentUser!.id,
        action: 'user_created',
        subject: user.id,
        detail: { email: user.email, role: user.role },
        ip: req.ip,
      })
      return reply.redirect('/admin/users?ok=' + encodeURIComponent(`Created ${user.email}`))
    } catch (err) {
      return reply.redirect(back('/admin/users', err instanceof Error ? err.message : 'Could not create user'))
    }
  })

  app.post('/admin/users/:id/state', { preHandler: [app.requireAdmin, app.csrfProtection] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = req.body as { active?: string }
    try {
      const target = await ctx.users.findById(id)
      if (!target) throw new NotFoundError('User')
      // Locking yourself out of the only admin account is unrecoverable
      // without shell access to the isolated box.
      if (target.id === req.currentUser!.id) throw new BadRequestError('You cannot deactivate your own account')

      const active = body.active === 'true'
      await ctx.users.setActive(id, active)
      if (!active) await ctx.sessions.destroyAllForUser(id)
      await ctx.audit.record({
        userId: req.currentUser!.id,
        action: active ? 'user_enabled' : 'user_disabled',
        subject: id,
        ip: req.ip,
      })
      return reply.redirect('/admin/users?ok=' + encodeURIComponent('Updated'))
    } catch (err) {
      return reply.redirect(back('/admin/users', err instanceof Error ? err.message : 'Could not update user'))
    }
  })

  app.post('/admin/users/:id/delete', { preHandler: [app.requireAdmin, app.csrfProtection] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    try {
      if (id === req.currentUser!.id) throw new BadRequestError('You cannot delete your own account')
      await ctx.users.deleteUser(id)
      await ctx.audit.record({ userId: req.currentUser!.id, action: 'user_deleted', subject: id, ip: req.ip })
      return reply.redirect('/admin/users?ok=' + encodeURIComponent('User deleted'))
    } catch (err) {
      return reply.redirect(back('/admin/users', err instanceof Error ? err.message : 'Could not delete user'))
    }
  })

  app.get('/admin/audit', { preHandler: app.requireAdmin }, async (req, reply) => {
    const { pageData } = await import('../render.js')
    return reply.view('admin-audit.njk', pageData(ctx, req, reply, { entries: await ctx.audit.recent(200) }))
  })
}
