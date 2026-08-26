import type { FastifyReply, FastifyRequest } from 'fastify'
import type { AppContext } from './context.js'

export interface PageExtras {
  [key: string]: unknown
}

/** Groups shown on the home page, in the order they appear. */
export const TOOL_GROUPS = [
  { id: 'optimize', label: 'Optimise', blurb: 'Make files smaller and faster to move.' },
  { id: 'modify', label: 'Modify', blurb: 'Change size, shape and orientation.' },
  { id: 'convert', label: 'Convert', blurb: 'Move between image formats.' },
  { id: 'create', label: 'Create', blurb: 'Compose something new.' },
  { id: 'secure', label: 'Protect', blurb: 'Watermark and redact before sharing.' },
] as const

/**
 * Everything every page needs. Kept in one place so a new template cannot
 * forget the navigation state or the CSRF token.
 */
export function pageData(ctx: AppContext, req: FastifyRequest, reply: FastifyReply, extras: PageExtras = {}) {
  const tools = ctx.registry.list()
  return {
    user: req.currentUser ?? null,
    /** Open access needs no sign-in, so the tools are always usable. */
    openAccess: ctx.config.isOpenAccess,
    canUse: ctx.config.isOpenAccess || Boolean(req.currentUser),
    isAdmin: !ctx.config.isOpenAccess && req.currentUser?.role === 'admin',
    csrfToken: reply.generateCsrf(),
    groups: TOOL_GROUPS.map((g) => ({ ...g, tools: tools.filter((t) => t.ui.group === g.id) })).filter(
      (g) => g.tools.length > 0,
    ),
    retentionHours: ctx.config.RETENTION_HOURS,
    maxFiles: ctx.config.MAX_FILES_PER_JOB,
    maxUploadMb: Math.round(ctx.config.MAX_UPLOAD_BYTES / (1024 * 1024)),
    queueDriver: ctx.queue.driver,
    allowedRenderHosts: ctx.config.allowedRenderHosts,
    ...extras,
  }
}
