import path from 'node:path';

/**
 * Default on-disk location for the local development database. Resolved
 * relative to this module so it is stable regardless of the process working
 * directory, and identical when running from `src` (tsx) or `dist` (built).
 */
export const DEFAULT_DATABASE_PATH = path.resolve(
  import.meta.dirname,
  '..',
  '..',
  'data',
  'app.db',
);

/**
 * Resolve the database location. `DATABASE_PATH` overrides the default when set
 * to a non-empty value; the literal `:memory:` selects an in-memory database.
 */
export function resolveDatabasePath(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.DATABASE_PATH?.trim();
  return fromEnv ? fromEnv : DEFAULT_DATABASE_PATH;
}
