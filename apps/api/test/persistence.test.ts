import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initializeDatabase } from '../src/database/lifecycle.js';
import { seedDemoData } from '../src/database/seed-data.js';
import { runMigrations } from '../src/database/migrator.js';
import { TenantRepository } from '../src/repositories/tenant-repository.js';

describe('file-backed database persistence', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nhi-db-'));
    dbPath = path.join(dir, 'app.db');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('retains migrated and seeded data after close and reopen', () => {
    const first = initializeDatabase(dbPath);
    seedDemoData(first);
    first.close();

    const second = initializeDatabase(dbPath);

    // Re-running migrations against the existing file applies nothing new.
    expect(runMigrations(second)).toEqual([]);

    const tenants = new TenantRepository(second).list();
    expect(tenants.map((t) => t.id)).toEqual(['tenant-acme', 'tenant-globex']);
    second.close();
  });
});
