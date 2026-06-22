import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/database/connection.js';
import { runMigrations, MIGRATIONS_DIR } from '../src/database/migrator.js';

const RECENT_INDEX = 'ix_jira_ticket_provenance_recent';
const M10 = '007_jira_ticket_provenance_recent_index.sql';

const THROUGH_006 = [
  '001_initial_schema.sql',
  '002_authentication.sql',
  '003_jira_connections.sql',
  '004_jira_connection_tenant_wide.sql',
  '005_jira_connection_v2_credentials.sql',
  '006_jira_ticket_provenance.sql',
];
const ALL = [...THROUGH_006, M10];

interface IndexRow {
  name: string;
}

function indexNames(db: ReturnType<typeof openDatabase>): string[] {
  return (
    db
      .prepare(`PRAGMA index_list(jira_ticket_provenance)`)
      .all() as unknown as IndexRow[]
  ).map((r) => r.name);
}

function seedProvenance(db: ReturnType<typeof openDatabase>): void {
  db.exec(`
    INSERT INTO tenants (id, name, created_at) VALUES ('t1', 'T1', '2026-01-01T00:00:00.000Z');
    INSERT INTO users (id, tenant_id, email, display_name, created_at)
      VALUES ('u1', 't1', 'u1@example.com', 'U1', '2026-01-01T00:00:00.000Z');
    INSERT INTO jira_connections
      (id, tenant_id, configured_by_user_id, site_url, email, account_id, encrypted_token, created_at, updated_at)
      VALUES ('c1', 't1', 'u1', 'https://x.atlassian.net', 'u1@example.com', 'acc', 'v2.enc', 'now', 'now');
    INSERT INTO jira_ticket_provenance
      (id, tenant_id, created_by_user_id, jira_connection_id, jira_site_url,
       jira_project_id, jira_project_key, jira_issue_id, jira_issue_key, created_at)
      VALUES ('p1', 't1', 'u1', 'c1', 'https://x.atlassian.net', 'pid', 'ABC', 'i1', 'ABC-1',
              '2026-01-01T00:00:00.000Z');
  `);
}

describe('jira_ticket_provenance recent-tickets index migration (007)', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nhi-recent-mig-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function copyMigrations(files: string[]): void {
    for (const file of files) {
      fs.copyFileSync(path.join(MIGRATIONS_DIR, file), path.join(dir, file));
    }
  }

  it('applies on a fresh database and creates the recent-tickets index', () => {
    copyMigrations(ALL);
    const db = openDatabase(':memory:');
    expect(runMigrations(db, dir)).toEqual(ALL);
    expect(indexNames(db)).toContain(RECENT_INDEX);
    db.close();
  });

  it('upgrades an existing provenance schema by applying only migration 007', () => {
    copyMigrations(THROUGH_006);
    const db = openDatabase(':memory:');
    expect(runMigrations(db, dir)).toEqual(THROUGH_006);
    expect(indexNames(db)).not.toContain(RECENT_INDEX);

    // Existing provenance rows are preserved across the additive index migration.
    seedProvenance(db);
    copyMigrations([M10]);
    expect(runMigrations(db, dir)).toEqual([M10]);

    expect(indexNames(db)).toContain(RECENT_INDEX);
    expect(db.prepare('SELECT COUNT(*) AS n FROM jira_ticket_provenance').get()).toEqual({ n: 1 });
    db.close();
  });

  it('is forward-only and repeatable: a second run applies nothing', () => {
    copyMigrations(ALL);
    const db = openDatabase(':memory:');
    runMigrations(db, dir);
    expect(runMigrations(db, dir)).toEqual([]);
    db.close();
  });

  it('serves a tenant/site/project keyset query through the new index', () => {
    copyMigrations(ALL);
    const db = openDatabase(':memory:');
    runMigrations(db, dir);
    seedProvenance(db);

    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT id FROM jira_ticket_provenance
         WHERE tenant_id = ? AND jira_site_url = ? AND jira_project_key = ?
         ORDER BY created_at DESC, id DESC LIMIT 25`,
      )
      .all('t1', 'https://x.atlassian.net', 'ABC') as unknown as { detail: string }[];
    const detail = plan.map((r) => r.detail).join(' ');
    expect(detail).toContain(RECENT_INDEX);
    db.close();
  });
});
