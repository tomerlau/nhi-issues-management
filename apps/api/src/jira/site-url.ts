/**
 * Validation and normalization for a Jira Cloud site URL. Only direct
 * `https://<site>.atlassian.net` URLs are accepted. The result is an HTTPS
 * origin with no trailing slash, used to build the outbound Jira request.
 *
 * This is the SSRF boundary: no network request is made until a URL passes
 * here, and the request target is constructed solely from the normalized origin
 * returned by this function — never from the raw user input.
 */

export type SiteUrlResult =
  | { ok: true; origin: string }
  | { ok: false; message: string };

/**
 * A single Jira Cloud site label followed by the fixed `.atlassian.net` suffix.
 * The label is one DNS label (letters, digits, hyphens; not starting/ending
 * with a hyphen) with no additional dots, so multi-label hosts, a bare
 * `atlassian.net`, deceptive suffixes (`x.atlassian.net.attacker.com`), and
 * lookalikes (`evil-atlassian.net`) are all rejected.
 */
const JIRA_HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.atlassian\.net$/;

const MAX_SITE_URL_LENGTH = 255;

function fail(message: string): SiteUrlResult {
  return { ok: false, message };
}

export function validateJiraSiteUrl(input: unknown): SiteUrlResult {
  if (typeof input !== 'string') {
    return fail('siteUrl must be a string.');
  }
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return fail('siteUrl must not be empty.');
  }
  if (trimmed.length > MAX_SITE_URL_LENGTH) {
    return fail('siteUrl exceeds the allowed length.');
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return fail('siteUrl is not a valid URL.');
  }

  if (url.protocol !== 'https:') {
    return fail('siteUrl must use https.');
  }
  if (url.username !== '' || url.password !== '') {
    return fail('siteUrl must not contain credentials.');
  }
  if (url.port !== '') {
    return fail('siteUrl must not specify a port.');
  }
  if (url.search !== '') {
    return fail('siteUrl must not contain a query string.');
  }
  if (url.hash !== '') {
    return fail('siteUrl must not contain a fragment.');
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    return fail('siteUrl must not contain a path.');
  }

  const host = url.hostname.toLowerCase();
  if (!JIRA_HOST.test(host)) {
    return fail('siteUrl must be a direct https://<site>.atlassian.net URL.');
  }

  return { ok: true, origin: `https://${host}` };
}
