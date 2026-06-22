import { existsSync } from 'node:fs';

/**
 * Load environment variables from a local `.env` file when one exists, using the
 * built-in Node.js loader (no `dotenv` dependency). Missing files are ignored so
 * a clean checkout starts without any configuration. Existing `process.env`
 * values are not overridden by Node's loader.
 */
export function loadLocalEnv(path = '.env'): void {
  if (existsSync(path)) {
    process.loadEnvFile(path);
  }
}
