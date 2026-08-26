import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
  // Resolve workspace packages to source, so the test loop never needs a build step.
  resolve: {
    alias: {
      '@pixelsmith/contracts': r('./packages/contracts/src/index.ts'),
      '@pixelsmith/core': r('./packages/core/src/index.ts'),
      '@pixelsmith/db': r('./packages/db/src/index.ts'),
      '@pixelsmith/jobs': r('./packages/jobs/src/index.ts'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts', 'workers/*/test/**/*.test.ts'],
    // Image ops are CPU-bound and libvips runs its own thread pool; cap
    // parallelism so the suite doesn't thrash on smaller machines.
    pool: 'forks',
    poolOptions: { forks: { minForks: 1, maxForks: 4 } },
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**', 'apps/*/src/**', 'workers/*/src/**'],
      exclude: ['**/*.d.ts', '**/index.ts'],
    },
  },
})
