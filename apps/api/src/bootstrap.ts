import { randomBytes } from 'node:crypto'
import type { AppContext } from './context.js'
import type { AppLogger } from './context.js'

/**
 * Create the first administrator on an empty database.
 *
 * An isolated server has no password-reset email and possibly no shell access
 * for the person setting it up, so the very first credentials have to come from
 * somewhere. Either the operator supplies them, or we mint one and print it
 * once — never a fixed default, which would ship the same password to everyone.
 */
export async function bootstrapFirstAdmin(ctx: AppContext, logger: AppLogger): Promise<void> {
  /**
   * With no accounts there is no administrator to be. The sign-in pages are
   * never registered in that mode, so the account could not be used for
   * anything — and creating one anyway printed a password into the log of every
   * open deployment for an account nobody could reach.
   */
  if (ctx.config.isOpenAccess) {
    logger.info(
      {},
      'no accounts on this deployment, so no administrator was created — set AUTH_MODE=accounts to require sign-in',
    )
    return
  }

  if ((await ctx.users.countUsers()) > 0) return

  const email = ctx.config.BOOTSTRAP_ADMIN_EMAIL ?? 'admin@pixelsmith.local'
  const supplied = ctx.config.BOOTSTRAP_ADMIN_PASSWORD
  const password = supplied ?? randomBytes(12).toString('base64url')

  await ctx.users.createUser({
    email,
    name: 'Administrator',
    password,
    role: 'admin',
    // A generated or operator-chosen password is a shared secret until replaced.
    mustChangePassword: true,
  })
  await ctx.audit.record({ action: 'admin_bootstrapped', subject: email })

  if (supplied) {
    logger.info({ email }, 'created first administrator from configuration')
  } else {
    // Printed once, to the operator's own console. Not stored anywhere else.
    logger.info(
      { email, password },
      'created first administrator with a generated password — sign in and change it now',
    )
  }
}
