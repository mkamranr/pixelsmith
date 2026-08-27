import type { FastifyReply, FastifyRequest } from 'fastify'
import type { AppContext } from './context.js'

export interface PageExtras {
  [key: string]: unknown
}

/**
 * The two workflows, each with its own groups. A tool's `family` decides which
 * menu it appears under, so adding a tool never means editing the navigation.
 */
export const TOOL_FAMILIES = [
  {
    id: 'image',
    label: 'Images',
    groups: [
      { id: 'optimize', label: 'Optimise', blurb: 'Make files smaller and faster to move.' },
      { id: 'modify', label: 'Modify', blurb: 'Change size, shape and orientation.' },
      { id: 'convert', label: 'Convert', blurb: 'Move between image formats.' },
      { id: 'create', label: 'Create', blurb: 'Compose something new.' },
      { id: 'secure', label: 'Protect', blurb: 'Watermark and redact before sharing.' },
    ],
  },
  {
    id: 'pdf',
    label: 'PDF',
    groups: [
      { id: 'organise', label: 'Organise', blurb: 'Merge, split and rearrange pages.' },
      { id: 'pdf-optimize', label: 'Optimise', blurb: 'Make documents smaller.' },
      { id: 'pdf-convert', label: 'Convert', blurb: 'To and from other formats.' },
      { id: 'pdf-edit', label: 'Edit', blurb: 'Annotate, stamp and number pages.' },
      { id: 'pdf-secure', label: 'Protect', blurb: 'Passwords, watermarks and redaction.' },
    ],
  },
] as const

/**
 * Everything every page needs. Kept in one place so a new template cannot
 * forget the navigation state or the CSRF token.
 */
export function pageData(ctx: AppContext, req: FastifyRequest, reply: FastifyReply, extras: PageExtras = {}) {
  const tools = ctx.registry.list()

  const families = TOOL_FAMILIES.map((family) => ({
    id: family.id,
    label: family.label,
    groups: family.groups
      .map((group) => ({
        ...group,
        tools: tools.filter((t) => t.family === family.id && t.ui.group === group.id),
      }))
      .filter((group) => group.tools.length > 0),
  })).filter((family) => family.groups.length > 0)

  return {
    user: req.currentUser ?? null,
    /** Open access needs no sign-in, so the tools are always usable. */
    openAccess: ctx.config.isOpenAccess,
    canUse: ctx.config.isOpenAccess || Boolean(req.currentUser),
    isAdmin: !ctx.config.isOpenAccess && req.currentUser?.role === 'admin',
    csrfToken: reply.generateCsrf(),
    families,
    /** The image groups alone, for pages that only concern pictures. */
    groups: families.find((f) => f.id === 'image')?.groups ?? [],
    retentionHours: ctx.config.RETENTION_HOURS,
    maxFiles: ctx.config.MAX_FILES_PER_JOB,
    maxUploadMb: Math.round(ctx.config.MAX_UPLOAD_BYTES / (1024 * 1024)),
    queueDriver: ctx.queue.driver,
    allowedRenderHosts: ctx.config.allowedRenderHosts,
    ...extras,
  }
}
