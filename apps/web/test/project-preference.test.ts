import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getProjectPreferenceStorageKey,
  loadLastProject,
  saveLastProject,
} from '../src/utils/project-preference';

const aliceAcme = {
  id: 'user-acme-alice',
  tenantId: 'tenant-acme',
  email: 'alice@example.com',
  displayName: 'Alice Anderson',
};

const bobAcme = {
  id: 'user-acme-bob',
  tenantId: 'tenant-acme',
  email: 'bob@example.com',
  displayName: 'Bob Brown',
};

const aliceGlobex = {
  id: 'user-globex-alice',
  tenantId: 'tenant-globex',
  email: 'alice@globex.example.com',
  displayName: 'Alice Globex',
};

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('getProjectPreferenceStorageKey', () => {
  it('scopes the storage key by tenant and user', () => {
    expect(getProjectPreferenceStorageKey(aliceAcme)).toBe(
      'nhi:last-project:tenant-acme:user-acme-alice',
    );
  });

  it('produces a different key for a different user in the same tenant', () => {
    expect(getProjectPreferenceStorageKey(aliceAcme)).not.toBe(
      getProjectPreferenceStorageKey(bobAcme),
    );
  });

  it('produces a different key for users in different tenants', () => {
    expect(getProjectPreferenceStorageKey(aliceAcme)).not.toBe(
      getProjectPreferenceStorageKey(aliceGlobex),
    );
  });
});

describe('loadLastProject', () => {
  it('returns an empty string when nothing is stored', () => {
    expect(loadLastProject(aliceAcme)).toBe('');
  });

  it('returns a valid uppercase project key unchanged', () => {
    window.localStorage.setItem(getProjectPreferenceStorageKey(aliceAcme), 'SCRUM');
    expect(loadLastProject(aliceAcme)).toBe('SCRUM');
  });

  it('normalizes a lowercase stored value to uppercase', () => {
    window.localStorage.setItem(getProjectPreferenceStorageKey(aliceAcme), 'scrum');
    expect(loadLastProject(aliceAcme)).toBe('SCRUM');
  });

  it('returns an empty string for a malformed/invalid stored value', () => {
    window.localStorage.setItem(getProjectPreferenceStorageKey(aliceAcme), '!!!');
    expect(loadLastProject(aliceAcme)).toBe('');
  });

  it('returns an empty string for a too-short stored value', () => {
    window.localStorage.setItem(getProjectPreferenceStorageKey(aliceAcme), 'A');
    expect(loadLastProject(aliceAcme)).toBe('');
  });

  it('returns an empty string for a too-long stored value', () => {
    window.localStorage.setItem(
      getProjectPreferenceStorageKey(aliceAcme),
      'TOOLONGKEY1',
    );
    expect(loadLastProject(aliceAcme)).toBe('');
  });

  it('safely returns an empty string when getItem throws', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage denied');
    });
    expect(() => loadLastProject(aliceAcme)).not.toThrow();
    expect(loadLastProject(aliceAcme)).toBe('');
    spy.mockRestore();
  });

  it('safely returns an empty string when localStorage access throws on probe', () => {
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });
    // Even if a previously-set value would parse cleanly, a denied probe path
    // means we cannot trust the storage and must return empty.
    expect(() => loadLastProject(aliceAcme)).not.toThrow();
    expect(loadLastProject(aliceAcme)).toBe('');
    setItemSpy.mockRestore();
  });
});

describe('saveLastProject', () => {
  it('persists a normalized valid project key', () => {
    saveLastProject(aliceAcme, 'scrum');
    expect(window.localStorage.getItem(getProjectPreferenceStorageKey(aliceAcme))).toBe(
      'SCRUM',
    );
  });

  it('does not persist an empty value', () => {
    window.localStorage.setItem(getProjectPreferenceStorageKey(aliceAcme), 'SCRUM');
    saveLastProject(aliceAcme, '');
    expect(window.localStorage.getItem(getProjectPreferenceStorageKey(aliceAcme))).toBe(
      'SCRUM',
    );
  });

  it('does not persist partial input shorter than the minimum length', () => {
    window.localStorage.setItem(getProjectPreferenceStorageKey(aliceAcme), 'SCRUM');
    saveLastProject(aliceAcme, 'S');
    expect(window.localStorage.getItem(getProjectPreferenceStorageKey(aliceAcme))).toBe(
      'SCRUM',
    );
  });

  it('does not persist a value that does not match the project-key pattern', () => {
    window.localStorage.setItem(getProjectPreferenceStorageKey(aliceAcme), 'SCRUM');
    saveLastProject(aliceAcme, '1AB');
    expect(window.localStorage.getItem(getProjectPreferenceStorageKey(aliceAcme))).toBe(
      'SCRUM',
    );
  });

  it('does not persist a value that exceeds the maximum length', () => {
    window.localStorage.setItem(getProjectPreferenceStorageKey(aliceAcme), 'SCRUM');
    saveLastProject(aliceAcme, 'TOOLONGKEY1');
    expect(window.localStorage.getItem(getProjectPreferenceStorageKey(aliceAcme))).toBe(
      'SCRUM',
    );
  });

  it('replaces a previously saved value with a new valid one', () => {
    saveLastProject(aliceAcme, 'SCRUM');
    saveLastProject(aliceAcme, 'platform');
    expect(window.localStorage.getItem(getProjectPreferenceStorageKey(aliceAcme))).toBe(
      'PLATFORM',
    );
  });

  it('safely ignores a storage write that throws', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    expect(() => saveLastProject(aliceAcme, 'SCRUM')).not.toThrow();
    spy.mockRestore();
  });

  it('uses different storage entries for different users in the same tenant', () => {
    saveLastProject(aliceAcme, 'SCRUM');
    saveLastProject(bobAcme, 'PLATFORM');
    expect(window.localStorage.getItem(getProjectPreferenceStorageKey(aliceAcme))).toBe(
      'SCRUM',
    );
    expect(window.localStorage.getItem(getProjectPreferenceStorageKey(bobAcme))).toBe(
      'PLATFORM',
    );
  });

  it('uses different storage entries for users in different tenants', () => {
    saveLastProject(aliceAcme, 'SCRUM');
    saveLastProject(aliceGlobex, 'GLOBEX');
    expect(window.localStorage.getItem(getProjectPreferenceStorageKey(aliceAcme))).toBe(
      'SCRUM',
    );
    expect(
      window.localStorage.getItem(getProjectPreferenceStorageKey(aliceGlobex)),
    ).toBe('GLOBEX');
  });
});
