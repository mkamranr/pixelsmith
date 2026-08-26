import { loadConfig } from './config.js'
import { createContext } from './context.js'
import { bootstrapFirstAdmin } from './bootstrap.js'
import { buildServer } from './server.js'

/**
 * Process entry point: configure, migrate, bootstrap, serve, and sweep.
 * Kept separate from buildServer so tests can build an app without binding a
 * port or starting timers.
 */
async function main() {
  const config = loadConfig()
  const ctx = await createContext(config)
  const app = await buildServer(ctx)

  await bootstrapFirstAdmin(ctx, app.log)

  // The purge sweeper. unref() so a pending timer never holds the process open
  // during shutdown.
  const sweep = setInterval(() => {
    ctx.sweeper.sweep().catch((err) => app.log.error({ err }, 'sweep failed'))
  }, config.sweepIntervalMs)
  sweep.unref()
  await ctx.sweeper.sweep()

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down')
    clearInterval(sweep)
    await app.close()
    await ctx.shutdown()
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))

  await app.listen({ host: config.HOST, port: config.PORT })
  app.log.info(
    { queue: ctx.queue.driver, dataDir: config.dataDir, retentionHours: config.RETENTION_HOURS },
    `Pixelsmith listening on http://localhost:${config.PORT}`,
  )
}

main().catch((err) => {
  console.error('Pixelsmith failed to start:', err)
  process.exit(1)
})
