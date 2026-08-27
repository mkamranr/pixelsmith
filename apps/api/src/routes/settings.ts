import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import {
  describeLlm,
  probeLlm,
  readLlmSettings,
  readRunnerLlmStatus,
  writeLlmSettings,
} from '@pixelsmith/core'
import type { AppContext } from '../context.js'
import { BadRequestError } from '../errors.js'
import { pageData } from '../render.js'

/** Where a saved form sends the operator back to, with what happened. */
const back = (note: string, kind: 'ok' | 'error') =>
  `/settings/llm?${kind}=${encodeURIComponent(note)}`

/**
 * Settings an operator changes while the server runs.
 *
 * Kept out of the environment on purpose: pointing this at a different model
 * should not mean editing a compose file and restarting containers on a machine
 * nobody can easily reach.
 */
export async function registerSettings(app: FastifyInstance, ctx: AppContext) {
  /**
   * Open access has no accounts to be an administrator of, so anyone who can
   * reach the server can configure it — the same bargain the rest of the app
   * makes. With accounts on, this is an administrator's page.
   */
  const guard = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!ctx.config.isOpenAccess) await app.requireAdmin(req, reply)
  }

  app.get('/settings/llm', { preHandler: guard }, async (req, reply) => {
    const settings = await readLlmSettings(ctx.config.dataDir)
    const query = req.query as { ok?: string; error?: string }

    return reply.view(
      'settings-llm.njk',
      pageData(ctx, req, reply, {
        llm: describeLlm(settings),
        /** What the workers found, which is what decides whether tools appear. */
        runner: await readRunnerLlmStatus(ctx.config.dataDir),
        usable: ctx.capabilities.llm,
        note: query.ok ?? null,
        problem: query.error ?? null,
      }),
    )
  })

  app.post('/settings/llm', { preHandler: [guard, app.csrfProtection] }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, string>
    const baseUrl = (body.baseUrl ?? '').trim()
    const model = (body.model ?? '').trim()

    if (!baseUrl || !model) {
      throw new BadRequestError('Give both the base URL and the model name')
    }

    const existing = await readLlmSettings(ctx.config.dataDir)
    const submittedKey = (body.apiKey ?? '').trim()
    const timeout = Number(body.timeoutMs)

    const settings = {
      baseUrl,
      model,
      // A blank key field means "leave it alone", not "remove it" — the page
      // never shows the key, so a blank box is the normal state.
      ...(submittedKey ? { apiKey: submittedKey } : existing?.apiKey ? { apiKey: existing.apiKey } : {}),
      ...(Number.isFinite(timeout) && timeout > 0 ? { timeoutMs: Math.round(timeout) } : {}),
    }

    // Written before it is checked, so a typo can be corrected on the page
    // rather than retyped from scratch.
    await writeLlmSettings(ctx.config.dataDir, settings)
    const probe = await probeLlm(settings)
    const note = probe.warning ? `${probe.detail} ${probe.warning}` : probe.detail

    await writeLlmSettings(ctx.config.dataDir, {
      ...settings,
      lastCheckedAt: Date.now(),
      lastDetail: note,
      ...(probe.ok ? { verifiedAt: Date.now(), verifiedModel: model } : {}),
    })
    await ctx.refreshCapabilities()

    await ctx.audit.record({
      userId: req.currentUser?.id ?? null,
      action: 'llm_configured',
      subject: baseUrl,
      detail: { model, reachable: probe.ok },
      ip: req.ip,
    })

    return reply.redirect(back(note, probe.ok ? 'ok' : 'error'))
  })

  /** Check again, without changing anything. */
  app.post('/settings/llm/test', { preHandler: [guard, app.csrfProtection] }, async (req, reply) => {
    const settings = await readLlmSettings(ctx.config.dataDir)
    if (!settings) return reply.redirect(back('Nothing is configured yet.', 'error'))

    const probe = await probeLlm(settings)
    const note = probe.warning ? `${probe.detail} ${probe.warning}` : probe.detail

    await writeLlmSettings(ctx.config.dataDir, {
      ...settings,
      lastCheckedAt: Date.now(),
      lastDetail: note,
      // A check that fails takes the capability away again, rather than leaving
      // tools on the strength of an old success.
      ...(probe.ok ? { verifiedAt: Date.now(), verifiedModel: settings.model } : { verifiedAt: undefined }),
    })
    await ctx.refreshCapabilities()
    return reply.redirect(back(note, probe.ok ? 'ok' : 'error'))
  })

  /** Forget the endpoint entirely, and with it the tools that needed it. */
  app.post('/settings/llm/forget', { preHandler: [guard, app.csrfProtection] }, async (req, reply) => {
    await writeLlmSettings(ctx.config.dataDir, { baseUrl: '', model: '' })
    await ctx.refreshCapabilities()
    return reply.redirect(back('The model settings were cleared.', 'ok'))
  })
}
