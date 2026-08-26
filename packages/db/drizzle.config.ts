import { defineConfig } from 'drizzle-kit'

// Paths are relative to the repo root, since this config is invoked from there
// via `npm run db:generate`.
export default defineConfig({
  schema: './packages/db/src/schema.ts',
  out: './packages/db/migrations',
  dialect: 'sqlite',
  strict: true,
  verbose: false,
})
