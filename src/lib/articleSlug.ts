import { createHash } from 'node:crypto';
import type { ProcessedItem } from './types';

const SITE_ORIGIN = 'https://www.amazingindex.com';

/** Normalized source identity for grouping + hashing (stable across snapshots). */
export function getStableArticleKey(item: ProcessedItem): string | null {
  const raw = (item.original_url || item.url || '').trim();
  if (raw) {
    try {
      const u = new URL(raw);
      u.hash = '';
      // Keep query: same article can move with ?id=; strip only hash.
      return u.href;
    } catch {
      /* ignore */
    }
  }
  const title = (item.processed_title || item.title || '').trim();
  if (title) return `title:${title}`;
  return null;
}

function slugifyReadable(input: string, maxLen: number): string {
  const s = input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-')
    .slice(0, maxLen)
    .replace(/-+$/g, '');
  return s || 'item';
}

function readablePrefixFromKey(key: string): string {
  if (key.startsWith('title:')) {
    return slugifyReadable(key.slice(5), 56);
  }
  try {
    const u = new URL(key);
    const host = u.hostname.replace(/^www\./i, '');
    const path = (u.pathname || '/').replace(/\/+/g, '/').replace(/\/$/, '') || '';
    const joined = path ? `${host}-${path.slice(1).replace(/\//g, '-')}` : host;
    return slugifyReadable(joined, 56);
  } catch {
    return slugifyReadable(key, 56);
  }
}

/** URL path segment under `/article/` (no slashes). Deterministic for a stable key. */
export function getArticlePathSegmentForKey(stableKey: string): string {
  const hash16 = createHash('sha256').update(stableKey).digest('hex').slice(0, 16);
  const readable = readablePrefixFromKey(stableKey);
  return `${readable}-${hash16}`;
}

export function getArticlePathSegment(item: ProcessedItem): string {
  const key = getStableArticleKey(item);
  if (!key) return item.processed_item_id;
  return getArticlePathSegmentForKey(key);
}

export function articlePagePath(item: ProcessedItem): string {
  return `/article/${getArticlePathSegment(item)}`;
}

export function articleCanonicalUrl(item: ProcessedItem): string {
  return new URL(articlePagePath(item), SITE_ORIGIN).href;
}
