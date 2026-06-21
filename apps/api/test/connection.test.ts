import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/database/connection.js';

describe('database connection factory', () => {
  it('enables foreign-key enforcement on every connection it creates', () => {
    for (let i = 0; i < 3; i += 1) {
      const db = openDatabase(':memory:');
      const row = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
      expect(row.foreign_keys).toBe(1);
      db.close();
    }
  });
});
