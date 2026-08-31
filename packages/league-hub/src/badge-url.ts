export type BadgeUrlKind = 'root-relative' | 'absolute-http';

const forbiddenCharacters = /[\p{Cc}\\]/u;

function repeatedlyDecode(value: string): string | null {
  let decoded = value;
  for (let pass = 0; pass < 16; pass += 1) {
    let invalidUtf8 = false;
    const next = decoded.replace(/(?:%[0-9a-f]{2})+/giu, (sequence: string) => {
      try {
        return decodeURIComponent(sequence);
      } catch {
        invalidUtf8 = true;
        return '';
      }
    });
    if (invalidUtf8) return null;
    if (next === decoded) return decoded;
    decoded = next;
  }
  return null;
}

function safePath(value: string): boolean {
  const decoded = repeatedlyDecode(value);
  if (decoded === null || forbiddenCharacters.test(decoded) || decoded.includes('//')) return false;
  return !decoded.split('/').some((segment) => segment === '..');
}

export function badgeUrlKind(value: string): BadgeUrlKind | null {
  const decoded = repeatedlyDecode(value);
  if (value.length < 1 || value.length > 2_048 || decoded === null || forbiddenCharacters.test(decoded)) return null;
  if (value.startsWith('/')) {
    if (value.startsWith('//')) return null;
    return safePath(value.split(/[?#]/u, 1)[0]!) ? 'root-relative' : null;
  }
  const match = value.match(/^https?:\/\/([^/?#]+)(\/[^?#]*)?(?:[?#].*)?$/iu);
  if (!match || match[1]!.includes('@') || !safePath(match[2] ?? '/')) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) return null;
  return 'absolute-http';
}
