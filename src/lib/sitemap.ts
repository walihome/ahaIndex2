import {
  getAllArticleRouteItems,
  getAllDates,
  getPublicDirectorySubjects,
} from './data';
import type { ArticleRouteItem } from './data';

const SITE_URL = 'https://www.amazingindex.com';
const STATIC_PATHS = ['/', '/about', '/contact', '/history', '/privacy', '/terms'];

export type SitemapEntry = {
  url: string;
  lastmod?: string;
};

export type SitemapIndexEntry = {
  url: string;
  lastmod?: string;
};

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

export function absoluteUrl(path: string): string {
  return stripTrailingSlash(new URL(path, SITE_URL).toString());
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function renderUrl(entry: SitemapEntry): string {
  const lastmod = entry.lastmod ? `<lastmod>${escapeXml(entry.lastmod)}</lastmod>` : '';
  return `<url><loc>${escapeXml(entry.url)}</loc>${lastmod}</url>`;
}

export function renderUrlset(entries: SitemapEntry[]): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...entries.map(renderUrl),
    '</urlset>',
  ].join('');
}

function renderSitemap(entry: SitemapIndexEntry): string {
  const lastmod = entry.lastmod ? `<lastmod>${escapeXml(entry.lastmod)}</lastmod>` : '';
  return `<sitemap><loc>${escapeXml(entry.url)}</loc>${lastmod}</sitemap>`;
}

export function renderSitemapIndex(entries: SitemapIndexEntry[]): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...entries.map(renderSitemap),
    '</sitemapindex>',
  ].join('');
}

export function sitemapResponse(xml: string): Response {
  return new Response(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
    },
  });
}

export function getStaticSitemapEntries(): SitemapEntry[] {
  return STATIC_PATHS.map((path) => ({ url: absoluteUrl(path) }));
}

function getDailySitemapEntries(dates: string[]): SitemapEntry[] {
  const sortedDates = [...dates].sort();
  const months = [...new Set(sortedDates.map((date) => date.slice(0, 7)))].sort();

  return [
    ...months.map((month) => ({ url: absoluteUrl(`/daily/${month}`) })),
    ...sortedDates.map((date) => ({
      url: absoluteUrl(`/daily/${date}`),
      lastmod: date,
    })),
  ];
}

function normalizeSitemapDate(value: string | null | undefined): string | undefined {
  return value ? value.slice(0, 10) : undefined;
}

function getLatestSubjectDate(subjects: Awaited<ReturnType<typeof getPublicDirectorySubjects>>): string | undefined {
  let latest: string | undefined;

  for (const subject of subjects) {
    const candidate = normalizeSitemapDate(subject.last_seen_at) ?? normalizeSitemapDate(subject.first_seen_at);
    if (candidate && (!latest || candidate > latest)) {
      latest = candidate;
    }
  }

  return latest;
}

function getSubjectSitemapEntries(subjects: Awaited<ReturnType<typeof getPublicDirectorySubjects>>): SitemapEntry[] {
  return subjects.map((subject) => ({
    url: absoluteUrl(`/subjects/${subject.slug}`),
    lastmod: normalizeSitemapDate(subject.last_seen_at) ?? normalizeSitemapDate(subject.first_seen_at),
  }));
}

export async function getPagesSitemapEntries(): Promise<SitemapEntry[]> {
  const dates = await getAllDates();
  const subjects = await getPublicDirectorySubjects();

  return [
    ...getStaticSitemapEntries(),
    { url: absoluteUrl('/daily') },
    { url: absoluteUrl('/subjects'), lastmod: getLatestSubjectDate(subjects) },
    ...getDailySitemapEntries(dates),
    ...getSubjectSitemapEntries(subjects),
  ];
}

export function getArticleSitemapPath(year: string): string {
  return `/sitemap-articles-${year}.xml`;
}

export async function getSitemapIndexEntries(): Promise<SitemapIndexEntry[]> {
  const dates = await getAllDates();
  const years = await getArticleSitemapYears();
  const latestDate = dates[0];

  return [
    { url: absoluteUrl('/sitemap-pages.xml'), lastmod: latestDate },
    ...years.map((year) => ({
      url: absoluteUrl(getArticleSitemapPath(year)),
      lastmod: dates.find((date) => date.startsWith(`${year}-`)),
    })),
  ];
}

function getUniqueArticleItems(items: ArticleRouteItem[]): ArticleRouteItem[] {
  const seen = new Map<string, ArticleRouteItem>();

  for (const item of items) {
    if (!item.processed_item_id) continue;
    const existing = seen.get(item.processed_item_id);
    if (!existing || item.snapshot_date > existing.snapshot_date) {
      seen.set(item.processed_item_id, item);
    }
  }

  return [...seen.values()];
}

export function getArticleSitemapEntriesForYear(
  items: ArticleRouteItem[],
  year: string,
): SitemapEntry[] {
  const entries: SitemapEntry[] = [];

  for (const item of items) {
    if (!item.snapshot_date?.startsWith(`${year}-`)) continue;

    entries.push({
      url: absoluteUrl(`/article/${item.processed_item_id}`),
      lastmod: item.snapshot_date,
    });
  }

  return entries.sort((a, b) => a.url.localeCompare(b.url));
}

export async function getArticleSitemapYears(): Promise<string[]> {
  const items = getUniqueArticleItems(await getAllArticleRouteItems());
  const years = new Set<string>();

  for (const item of items) {
    if (item.snapshot_date) {
      years.add(item.snapshot_date.slice(0, 4));
    }
  }

  return [...years].sort();
}

export async function getArticleSitemapEntriesByYear(
  year: string,
): Promise<SitemapEntry[]> {
  const items = getUniqueArticleItems(await getAllArticleRouteItems());
  return getArticleSitemapEntriesForYear(items, year);
}
