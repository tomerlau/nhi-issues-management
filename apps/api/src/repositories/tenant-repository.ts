import type { DatabaseSync } from 'node:sqlite';

export interface Tenant {
  id: string;
  name: string;
  createdAt: string;
}

interface TenantRow {
  id: string;
  name: string;
  created_at: string;
}

function toTenant(row: TenantRow): Tenant {
  return { id: row.id, name: row.name, createdAt: row.created_at };
}

export interface CreateTenantInput {
  id: string;
  name: string;
  createdAt?: string;
}

export class TenantRepository {
  constructor(private readonly db: DatabaseSync) {}

  create(input: CreateTenantInput): Tenant {
    const createdAt = input.createdAt ?? new Date().toISOString();
    this.db
      .prepare('INSERT INTO tenants (id, name, created_at) VALUES (?, ?, ?)')
      .run(input.id, input.name, createdAt);
    return { id: input.id, name: input.name, createdAt };
  }

  findById(id: string): Tenant | null {
    const row = this.db
      .prepare('SELECT id, name, created_at FROM tenants WHERE id = ?')
      .get(id) as TenantRow | undefined;
    return row ? toTenant(row) : null;
  }

  list(): Tenant[] {
    const rows = this.db
      .prepare('SELECT id, name, created_at FROM tenants ORDER BY id')
      .all() as unknown as TenantRow[];
    return rows.map(toTenant);
  }
}
