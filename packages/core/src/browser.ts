import type { Browser } from 'playwright-core'

let instance: Browser | null = null
let pending: Promise<Browser> | null = null

/**
 * One shared Chromium per process.
 *
 * Launching a browser costs the better part of a second and a few hundred
 * megabytes; doing it per job would make rendering the slowest tool by an order
 * of magnitude. The render worker is a separate queue precisely so this cost is
 * paid once, in one process.
 *
 * playwright-core is imported lazily so the image worker — which never renders
 * HTML — does not load it at all.
 */
export async function getBrowser(executablePath?: string): Promise<Browser> {
  if (instance?.isConnected()) return instance

  pending ??= (async () => {
    const { chromium } = await import('playwright-core')
    return chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
      args: [
        // Containers give /dev/shm only 64MB by default, which Chromium
        // outgrows and then crashes on.
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--hide-scrollbars',
        '--mute-audio',
        // The OS sandbox stays ON. Disabling it is the usual shortcut for
        // getting Chromium running in Docker, and it is exactly the wrong
        // trade when the thing being rendered is untrusted input.
      ],
    })
  })()
    .then((b) => {
      instance = b
      pending = null
      return b
    })
    .catch((err) => {
      pending = null
      throw err
    })

  return pending
}

export async function closeBrowser(): Promise<void> {
  const b = instance
  instance = null
  if (b?.isConnected()) await b.close()
}
