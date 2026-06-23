/**
 * Local setup command (npm run setup).
 *
 * Steps:
 *  1. Ensure apps/api/.env exists, copying apps/api/.env.example when needed.
 *  2. Ensure JIRA_CREDENTIAL_ENCRYPTION_KEY is a valid 32-byte canonical
 *     standard base64 value; generate and persist one when missing or empty.
 *  3. Run `npm run seed` to apply migrations and insert demo data.
 *
 * The script never prints the generated key value. An existing valid key is
 * preserved unchanged. An existing non-empty but invalid key is a hard
 * failure; the .env file is not modified in that case.
 *
 * Pure env logic lives in setup-env.mjs so tests can exercise it directly.
 */

import { execSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureEncryptionKey, KEY_NAME } from './setup-env.mjs';

const moduleDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(moduleDir, '..');
const DEFAULT_ENV_PATH = resolve(repoRoot, 'apps/api/.env');
const DEFAULT_EXAMPLE_PATH = resolve(repoRoot, 'apps/api/.env.example');

/**
 * Programmatic entry point. The CLI wrapper at the bottom invokes this with
 * the default paths and `runSeed: true`. Tests inject temporary paths,
 * `runSeed: false`, and a capturing logger.
 */
export function runSetup({
  envPath = DEFAULT_ENV_PATH,
  examplePath = DEFAULT_EXAMPLE_PATH,
  runSeed = true,
  cwd = repoRoot,
  log = console.log,
  logError = console.error,
} = {}) {
  const result = ensureEncryptionKey({ envPath, examplePath });

  if (result.created) {
    log(`[setup] created ${envPath} from ${examplePath}`);
  }
  if (result.keyStatus === 'generated') {
    log(`[setup] generated ${KEY_NAME} (value not printed; stored only in ${envPath})`);
  } else {
    log(`[setup] existing ${KEY_NAME} left unchanged`);
  }

  if (runSeed) {
    log('[setup] applying migrations and seeding demo data');
    try {
      execSync('npm run seed', { cwd, stdio: 'inherit' });
    } catch (err) {
      logError('[setup] npm run seed failed');
      throw err;
    }
  }

  return result;
}

// Run only when this file is the direct entry point, not when imported.
if (resolve(process.argv[1] ?? '') === resolve(fileURLToPath(import.meta.url))) {
  try {
    runSetup();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // The error message intentionally never includes the key value; see
    // setup-env.mjs.
    console.error(`[setup] ${message}`);
    process.exit(1);
  }
}
