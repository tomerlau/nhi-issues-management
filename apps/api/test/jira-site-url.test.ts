import { describe, expect, it } from 'vitest';
import { validateJiraSiteUrl } from '../src/jira/site-url.js';

describe('jira site url validation', () => {
  it('accepts a valid Jira Cloud URL and normalizes to an origin', () => {
    const result = validateJiraSiteUrl('https://example.atlassian.net');
    expect(result).toEqual({ ok: true, origin: 'https://example.atlassian.net' });
  });

  it('normalizes a trailing slash away', () => {
    const result = validateJiraSiteUrl('https://example.atlassian.net/');
    expect(result).toEqual({ ok: true, origin: 'https://example.atlassian.net' });
  });

  it('lowercases the host and trims surrounding whitespace', () => {
    const result = validateJiraSiteUrl('  https://Example.Atlassian.NET/  ');
    expect(result).toEqual({ ok: true, origin: 'https://example.atlassian.net' });
  });

  it('rejects all unsafe and non-Atlassian forms', () => {
    const rejected = [
      'http://example.atlassian.net', // not https
      'https://example.com', // non-Atlassian host
      'https://example.atlassian.net.attacker.com', // deceptive suffix
      'https://atlassian.net', // bare apex
      'https://evil-atlassian.net', // lookalike host
      'https://user:pass@example.atlassian.net', // credentials in URL
      'https://example.atlassian.net:8443', // explicit port
      'https://example.atlassian.net/wiki', // extra path
      'https://example.atlassian.net/?q=1', // query string
      'https://example.atlassian.net/#frag', // fragment
      'https://127.0.0.1', // IP address
      'https://localhost', // localhost
      'https://sub.example.atlassian.net', // multi-label host
      'not a url', // malformed
      'ftp://example.atlassian.net', // wrong scheme
    ];
    for (const input of rejected) {
      const result = validateJiraSiteUrl(input);
      expect(result.ok, `expected rejection for ${input}`).toBe(false);
    }
  });

  it('rejects non-string input', () => {
    expect(validateJiraSiteUrl(123).ok).toBe(false);
    expect(validateJiraSiteUrl(null).ok).toBe(false);
    expect(validateJiraSiteUrl(undefined).ok).toBe(false);
  });

  it('rejects empty and excessively long input', () => {
    expect(validateJiraSiteUrl('   ').ok).toBe(false);
    expect(validateJiraSiteUrl(`https://${'a'.repeat(300)}.atlassian.net`).ok).toBe(false);
  });
});
