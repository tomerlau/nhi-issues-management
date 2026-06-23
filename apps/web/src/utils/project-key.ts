export const MAX_PROJECT_KEY_LENGTH = 10;
export const PROJECT_KEY_PATTERN = /^[A-Z][A-Z0-9]+$/;

export function normalizeProjectKey(raw: string): string {
  return raw.trim().toUpperCase();
}

export function isValidProjectKey(normalized: string): boolean {
  return (
    normalized.length >= 2 &&
    normalized.length <= MAX_PROJECT_KEY_LENGTH &&
    PROJECT_KEY_PATTERN.test(normalized)
  );
}
