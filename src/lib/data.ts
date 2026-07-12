import { supabase } from './supabase';
import type {
  ProcessedItem,
  GlobalStats,
  MonthlyArchive,
  WeeklyArchive,
  DailyArchive,
  ProjectHeatmapRow,
  ProjectEntry,
  TimelineEntry,
  TrackInfo,
  SubjectStatsRow,
  SubjectSignal,
  SubjectSignalStats,
  SubjectCatalogEntry,
  SubjectDirectorySection,
  SubjectInsight,
} from './types';

const TABLE = 'display_items';
const PAGE_SIZE = 1000;
const MAX_QUERY_ATTEMPTS = 3;
const DAILY_ARCHIVE_COLUMNS = 'snapshot_date, aha_score, aha_delta, item_count, top_story_title, top_story_source, top_tags, rarity_score, timeliness_score, impact_score, percentile_90d, percentile_tier, sample_size_90d';

// ─── Build-time memo cache ──────────────────────────
const _cache = new Map<string, Promise<unknown>>();

function memo<T>(key: string, fn: () => Promise<T>): () => Promise<T> {
  return async () => {
    const cached = _cache.get(key);
    if (cached) return cached as Promise<T>;

    const pending = fn().catch((error) => {
      _cache.delete(key);
      throw error;
    });
    _cache.set(key, pending);
    return pending;
  };
}

function memoBy<T>(prefix: string, fn: (arg: string) => Promise<T>): (arg: string) => Promise<T> {
  return async (arg: string) => {
    const key = `${prefix}:${arg}`;
    const cached = _cache.get(key);
    if (cached) return cached as Promise<T>;

    const pending = fn(arg).catch((error) => {
      _cache.delete(key);
      throw error;
    });
    _cache.set(key, pending);
    return pending;
  };
}

function chunkValues<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < values.length; i += size) {
    chunks.push(values.slice(i, i + size));
  }
  return chunks;
}

function isMissingRelationError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;

  const err = error as { code?: string; message?: string; hint?: string };
  return Boolean(
    err.code === '42P01' ||
    err.code === 'PGRST205' ||
    err.message?.includes('schema cache') ||
    err.message?.includes('Could not find the table') ||
    err.hint?.includes('Perhaps you meant the table')
  );
}

function isTransientQueryError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const err = error as { code?: string; message?: string };
  return Boolean(
    err.code === '57014' ||
    err.code === 'PGRST000' ||
    err.code === 'PGRST001' ||
    err.message?.includes('statement timeout') ||
    err.message?.includes('fetch failed'),
  );
}

async function runQuery<T>(
  createQuery: () => PromiseLike<{ data: T[] | null; error: any }>,
  label: string,
): Promise<T[]> {
  for (let attempt = 1; attempt <= MAX_QUERY_ATTEMPTS; attempt++) {
    let response: { data: T[] | null; error: any };
    try {
      response = await createQuery();
    } catch (error) {
      if (!isTransientQueryError(error) || attempt === MAX_QUERY_ATTEMPTS) throw error;
      console.warn(`${label} failed on attempt ${attempt}; retrying a compact page.`);
      await new Promise(resolve => setTimeout(resolve, attempt * 500));
      continue;
    }

    const { data, error } = response;
    if (!error) return data ?? [];
    if (!isTransientQueryError(error) || attempt === MAX_QUERY_ATTEMPTS) throw error;

    console.warn(`${label} failed on attempt ${attempt}; retrying a compact page.`);
    await new Promise(resolve => setTimeout(resolve, attempt * 500));
  }
  return [];
}

async function fetchAllRows<T>(
  createQuery: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: any }>,
  label = 'Supabase range query',
): Promise<T[]> {
  const rows: T[] = [];
  let offset = 0;

  while (true) {
    const data = await runQuery(
      () => createQuery(offset, offset + PAGE_SIZE - 1),
      `${label} at offset ${offset}`,
    );
    if (!data || data.length === 0) break;

    rows.push(...data);
    if (data.length < PAGE_SIZE) break;

    offset += PAGE_SIZE;
  }

  return rows;
}

async function fetchAllRowsById<T extends { id: string }>(
  createQuery: (lastId: string | null) => PromiseLike<{ data: T[] | null; error: any }>,
  label: string,
): Promise<T[]> {
  const rows: T[] = [];
  let lastId: string | null = null;

  while (true) {
    const data: T[] = await runQuery<T>(
      () => createQuery(lastId),
      `${label} after ${lastId ?? 'start'}`,
    );
    if (data.length === 0) break;

    rows.push(...data);
    if (data.length < PAGE_SIZE) break;

    const nextId: string | undefined = data.at(-1)?.id;
    if (!nextId || nextId === lastId) {
      throw new Error(`${label} cursor did not advance.`);
    }
    lastId = nextId;
  }

  return rows;
}

// ─── Core queries (memoized) ────────────────────────

export const getLatestDate = memo<string | null>('latestDate', async () => {
  const data = await runQuery<{ snapshot_date: string }>(
    () => supabase
      .from(TABLE)
      .select('snapshot_date')
      .order('snapshot_date', { ascending: false })
      .limit(1),
    'latest display date',
  );
  return data?.[0]?.snapshot_date ?? null;
});

export const getItemsByDate = memoBy<ProcessedItem[]>('itemsByDate', async (date: string) => {
  return fetchAllRows<ProcessedItem>(
    (from, to) => supabase
        .from(TABLE)
        .select('*')
        .eq('snapshot_date', date)
        .order('rank', { ascending: true })
        .order('processed_item_id', { ascending: true })
        .range(from, to),
    `display items for ${date}`,
  );
});

export async function getItemById(
  date: string,
  pid: string,
): Promise<ProcessedItem | null> {
  const items = await getItemsByDate(date);
  return items.find(i => i.processed_item_id === pid) ?? null;
}

export async function getItemByPid(
  pid: string,
): Promise<ProcessedItem | null> {
  const data = await runQuery<ProcessedItem>(
    () => supabase
      .from(TABLE)
      .select('*')
      .eq('processed_item_id', pid)
      .order('snapshot_date', { ascending: false })
      .limit(1),
    `display item ${pid}`,
  );
  return (data?.[0] as ProcessedItem) ?? null;
}

interface ArticleRouteRow {
  id: string;
  processed_item_id: string;
  snapshot_date: string;
}

export interface ArticleRouteItem {
  processed_item_id: string;
  snapshot_date: string;
}

function stripArticleRouteIds(rows: ArticleRouteRow[]): ArticleRouteItem[] {
  return rows.map(({ processed_item_id, snapshot_date }) => ({
    processed_item_id,
    snapshot_date,
  }));
}

export const getAllArticleRouteItems = memo<ArticleRouteItem[]>('allArticleRoutes', async () => {
  const rows = await fetchAllRowsById<ArticleRouteRow>((lastId) => {
    const query = supabase
      .from(TABLE)
      .select('id, processed_item_id, snapshot_date')
      .order('id', { ascending: true })
      .limit(PAGE_SIZE);
    return lastId ? query.gt('id', lastId) : query;
  }, 'article route rows');
  return stripArticleRouteIds(rows);
});

export const getAllDates = memo<string[]>('allDates', async () => {
  const items = await getAllArticleRouteItems();
  return [...new Set(items.map((item) => item.snapshot_date))].sort().reverse();
});

function getWeekNumber(d: Date) {
  const dt = new Date(
    Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()),
  );
  dt.setUTCDate(dt.getUTCDate() + 4 - (dt.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  return Math.ceil(
    ((dt.getTime() - yearStart.getTime()) / 86400000 + 1) / 7,
  );
}

export const getGlobalStats = memo<GlobalStats>('globalStats', async () => {
  const dates = await getAllDates();
  if (dates.length === 0) {
    return { total_editions: 0, total_items: 0, avg_aha_score: 0, peak_aha_score: 0 };
  }

  let totalItems = 0;
  let totalScore = 0;
  let peakScore = 0;

  for (const date of dates) {
    const items = await getItemsByDate(date);
    totalItems += items.length;
    if (items.length > 0) {
      const dayScore =
        items.reduce((sum, item) => sum + (item.aha_index || 0), 0) / items.length * 100;
      totalScore += dayScore;
      if (dayScore > peakScore) peakScore = dayScore;
    }
  }

  return {
    total_editions: dates.length,
    total_items: totalItems,
    avg_aha_score: totalScore / dates.length,
    peak_aha_score: peakScore,
  };
});

export async function getMonthlyArchives(year: number): Promise<MonthlyArchive[]> {
  const dates = await getAllDates();
  const yearPrefix = `${year}-`;
  const yearDates = dates.filter((date) => date.startsWith(yearPrefix));

  const monthsMap: Record<string, string[]> = {};
  for (const date of yearDates) {
    const month = date.slice(0, 7);
    if (!monthsMap[month]) monthsMap[month] = [];
    monthsMap[month].push(date);
  }

  const result: MonthlyArchive[] = [];
  for (const [monthStr, monthDates] of Object.entries(monthsMap)) {
    let itemCount = 0;
    let totalScore = 0;
    let peakScore = 0;
    let peakDate = '';
    let topItem: ProcessedItem | null = null;

    for (const date of monthDates) {
      const items = await getItemsByDate(date);
      itemCount += items.length;
      if (items.length > 0) {
        const dayScore =
          items.reduce((sum, item) => sum + (item.aha_index || 0), 0) / items.length * 100;
        totalScore += dayScore;
        if (dayScore > peakScore) {
          peakScore = dayScore;
          peakDate = date;
        }
        for (const item of items) {
          if (!topItem || (item.aha_index || 0) > (topItem.aha_index || 0)) {
            topItem = item;
          }
        }
      }
    }

    result.push({
      month: `${monthStr}-01`,
      edition_count: monthDates.length,
      item_count: itemCount,
      avg_aha_score: monthDates.length > 0 ? totalScore / monthDates.length : 0,
      peak_aha_score: peakScore,
      peak_date: peakDate,
      summary: '',
      meta_description: '',
      top_story_title: topItem ? (topItem.processed_title || topItem.title || '') : '',
    });
  }

  return result.sort((a, b) => b.month.localeCompare(a.month));
}

export async function getWeeklyArchives(
  year: number,
  month: number,
): Promise<WeeklyArchive[]> {
  const dates = await getAllDates();
  const monthPrefix = `${year}-${String(month).padStart(2, '0')}-`;
  const monthDates = dates.filter((date) => date.startsWith(monthPrefix));

  const weeksMap: Record<number, string[]> = {};
  for (const date of monthDates) {
    const weekNo = getWeekNumber(new Date(date));
    if (!weeksMap[weekNo]) weeksMap[weekNo] = [];
    weeksMap[weekNo].push(date);
  }

  const result: WeeklyArchive[] = [];
  for (const [weekNoString, weekDates] of Object.entries(weeksMap)) {
    const weekNo = parseInt(weekNoString, 10);
    let itemCount = 0;
    let totalScore = 0;
    let peakScore = 0;
    let peakDate = '';
    for (const date of weekDates) {
      const items = await getItemsByDate(date);
      itemCount += items.length;
      if (items.length > 0) {
        const dayScore =
          items.reduce((sum, item) => sum + (item.aha_index || 0), 0) / items.length * 100;
        totalScore += dayScore;
        if (dayScore > peakScore) {
          peakScore = dayScore;
          peakDate = date;
        }
      }
    }
    const sorted = [...weekDates].sort();
    result.push({
      year,
      week_number: weekNo,
      start_date: sorted[0],
      end_date: sorted[sorted.length - 1],
      edition_count: weekDates.length,
      item_count: itemCount,
      avg_aha_score: weekDates.length > 0 ? totalScore / weekDates.length : 0,
      peak_aha_score: peakScore,
      peak_date: peakDate,
    });
  }

  return result.sort((a, b) => b.week_number - a.week_number);
}

export const getLatestDailyArchive = memo<DailyArchive | null>('latestDailyArchive', async () => {
  const data = await runQuery<DailyArchive>(
    () => supabase
      .from('daily_archives')
      .select(DAILY_ARCHIVE_COLUMNS)
      .order('snapshot_date', { ascending: false })
      .limit(1),
    'latest daily archive',
  );
  return data[0] ?? null;
});

export async function getDailyArchiveByDate(date: string): Promise<DailyArchive | null> {
  const data = await runQuery<DailyArchive>(
    () => supabase
      .from('daily_archives')
      .select(DAILY_ARCHIVE_COLUMNS)
      .eq('snapshot_date', date)
      .limit(1),
    `daily archive for ${date}`,
  );
  return data[0] ?? null;
}

export async function getDailyArchives(
  year: number,
  month: number,
): Promise<DailyArchive[]> {
  const dates = await getAllDates();
  const monthPrefix = `${year}-${String(month).padStart(2, '0')}-`;
  const monthDates = dates.filter((date) => date.startsWith(monthPrefix)).sort();

  const result: DailyArchive[] = [];
  for (const date of monthDates) {
    const items = await getItemsByDate(date);
    const dayScore = items.length > 0
      ? items.reduce((sum, item) => sum + (item.aha_index || 0), 0) / items.length * 100
      : 0;
    const top = [...items].sort(
      (a, b) => (b.aha_index || 0) - (a.aha_index || 0),
    )[0];

    result.push({
      snapshot_date: date,
      aha_score: dayScore,
      aha_delta: '',
      item_count: items.length,
      top_story_title: top ? (top.processed_title || top.title || '') : '',
      top_story_source: top?.source_name ?? '',
      top_tags: top?.tags?.slice(0, 3) ?? [],
      rarity_score: 0,
      timeliness_score: 0,
      impact_score: 0,
    });
  }

  for (let index = 1; index < result.length; index++) {
    const delta = result[index].aha_score - result[index - 1].aha_score;
    result[index].aha_delta = `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}`;
  }

  return result.reverse();
}

export async function getHistoryItems(): Promise<ProcessedItem[]> {
  const dates = await getAllDates();
  const latest5 = dates.slice(0, 5);

  let allItems: ProcessedItem[] = [];
  for (const d of latest5) {
    const items = await getItemsByDate(d);
    allItems = allItems.concat(items);
  }

  allItems.sort((a, b) => (b.aha_index || 0) - (a.aha_index || 0));
  return allItems.slice(0, 100);
}

// ─── Project Heatmap queries (memoized) ────────────────

interface ProjectTimelineRow {
  id: string;
  subject_id: string;
  snapshot_date: string;
  score_100: number | null;
  role: string | null;
  source_name: string | null;
}

interface ProjectSnapshotRow extends ProjectHeatmapRow {
  id: string;
}

const PROJECT_SNAPSHOT_COLUMNS = 'id, subject_id, subject_slug, subject_name, subject_type, track_id, track_name, track_group, snapshot_date, score, score_100, role, source_name, tags, summary, first_seen_at, last_seen_at, mention_count, related_data';

const getLatestProjectDate = memo<string | null>('latestProjectDate', async () => {
  const data = await runQuery<{ snapshot_date: string }>(
    () => supabase
      .from('project_heatmap_data')
      .select('snapshot_date')
      .order('snapshot_date', { ascending: false })
      .limit(1),
    'latest project date',
  );
  return data[0]?.snapshot_date ?? null;
});

const getProjectTimelineRows = memo<ProjectTimelineRow[]>('projectTimelineRows', async () => {
  return fetchAllRowsById<ProjectTimelineRow>((lastId) => {
    const query = supabase
      .from('project_heatmap_data')
      .select('id, subject_id, snapshot_date, score_100, role, source_name')
      .order('id', { ascending: true })
      .limit(PAGE_SIZE);
    return lastId ? query.gt('id', lastId) : query;
  }, 'project timeline rows');
});

const getProjectSnapshotsByDate = memoBy<ProjectSnapshotRow[]>('projectSnapshotsByDate', async (date) => {
  return fetchAllRowsById<ProjectSnapshotRow>((lastId) => {
    const query = supabase
      .from('project_heatmap_data')
      .select(PROJECT_SNAPSHOT_COLUMNS)
      .eq('snapshot_date', date)
      .order('id', { ascending: true })
      .limit(PAGE_SIZE);
    return lastId ? query.gt('id', lastId) : query;
  }, `project snapshots for ${date}`);
});

async function getFallbackProjectSnapshots(subjectIds: string[]): Promise<ProjectSnapshotRow[]> {
  const rows: ProjectSnapshotRow[] = [];
  for (const batch of chunkValues(subjectIds, 100)) {
    const batchRows = await fetchAllRows<ProjectSnapshotRow>(
      (from, to) => supabase
        .from('project_heatmap_data')
        .select(PROJECT_SNAPSHOT_COLUMNS)
        .in('subject_id', batch)
        .order('snapshot_date', { ascending: false })
        .order('subject_id', { ascending: true })
        .range(from, to),
      'fallback project snapshots',
    );
    rows.push(...batchRows);
  }
  return rows;
}

function assembleProjects(
  rows: ProjectTimelineRow[],
  snapshotsBySubject: Map<string, ProjectSnapshotRow>,
): ProjectEntry[] {
  const grouped = new Map<string, ProjectTimelineRow[]>();
  for (const row of rows) {
    const existing = grouped.get(row.subject_id) || [];
    existing.push(row);
    grouped.set(row.subject_id, existing);
  }

  const projects: ProjectEntry[] = [];
  for (const [subjectId, subjectRows] of grouped) {
    subjectRows.sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date));

    const snapshot = snapshotsBySubject.get(subjectId);
    if (!snapshot) continue;
    const related_data = snapshot.related_data;

    const timeline: TimelineEntry[] = subjectRows
      .filter(r => r.score_100 !== null && r.score_100 !== undefined)
      .map(r => ({
        date: r.snapshot_date,
        aha: r.score_100!,
        role: r.role || undefined,
        source_name: r.source_name || undefined,
      }));
    const scoresWithDate = timeline.map(({ date, aha }) => ({ date, score: aha }));
    const aha_current = scoresWithDate.at(-1)?.score ?? 0;
    const aha_peak = scoresWithDate.length > 0 ? Math.max(...scoresWithDate.map(s => s.score)) : 0;

    let delta = '';
    if (scoresWithDate.length >= 2) {
      const diff = scoresWithDate.at(-1)!.score - scoresWithDate.at(-2)!.score;
      delta = `${diff >= 0 ? '+' : ''}${diff.toFixed(1)}`;
    }

    projects.push({
      subject_id: subjectId,
      slug: snapshot.subject_slug,
      display_name: snapshot.subject_name,
      type: snapshot.subject_type,
      tags: snapshot.tags || [],
      summary: snapshot.summary,
      first_seen_at: snapshot.first_seen_at,
      last_seen_at: snapshot.last_seen_at,
      mention_count: snapshot.mention_count || 0,
      track_id: snapshot.track_id,
      track_name: snapshot.track_name,
      track_group: snapshot.track_group,
      aha_current,
      aha_peak,
      delta,
      appearances: subjectRows.length,
      rank: 0,
      timeline,
      related: related_data?.related || [],
      competitors: related_data?.competitors || [],
    });
  }

  projects.sort((a, b) => b.aha_current - a.aha_current);
  projects.forEach((project, index) => { project.rank = index + 1; });
  return projects;
}

export const getTracks = memo<TrackInfo[]>('tracks', async () => {
  const { data, error } = await supabase
    .from('tracks')
    .select('id, slug, display_name, display_name_en, group_name, description, cover_color, display_order')
    .eq('status', 'active')
    .order('display_order');
  if (error) throw error;
  return (data as TrackInfo[]) ?? [];
});

export const getProjects = memo<ProjectEntry[]>('projects', async () => {
  const [rows, latestDate] = await Promise.all([
    getProjectTimelineRows(),
    getLatestProjectDate(),
  ]);
  if (rows.length === 0 || !latestDate) return [];

  const latestSnapshots = await getProjectSnapshotsByDate(latestDate);
  const snapshotsBySubject = new Map(latestSnapshots.map((row) => [row.subject_id, row]));
  const allSubjectIds = [...new Set(rows.map((row) => row.subject_id))];
  const missingSubjectIds = allSubjectIds.filter((subjectId) => !snapshotsBySubject.has(subjectId));

  if (missingSubjectIds.length > 0) {
    const fallbackSnapshots = await getFallbackProjectSnapshots(missingSubjectIds);
    for (const row of fallbackSnapshots) {
      if (!snapshotsBySubject.has(row.subject_id)) {
        snapshotsBySubject.set(row.subject_id, row);
      }
    }
  }

  return assembleProjects(rows, snapshotsBySubject);
});

export const getProjectBySlug = memoBy<ProjectEntry | null>('projectBySlug', async (slug: string) => {
  const projects = await getProjects();
  return projects.find(p => p.slug === slug) ?? null;
});

export const getProjectById = memoBy<ProjectEntry | null>('projectById', async (id: string) => {
  const projects = await getProjects();
  return projects.find(p => p.subject_id === id) ?? null;
});

export const getProjectDates = memo<string[]>('projectDates', async () => {
  const rows = await getProjectTimelineRows();
  const dates = new Set<string>();
  for (const r of rows) {
    if (r.score_100 !== null && r.score_100 !== undefined) {
      dates.add(r.snapshot_date);
    }
  }
  return [...dates].sort();
});

// ─── Subject V2 directory queries ─────────────────────

export const getSubjectStats = memo<SubjectStatsRow[]>('subjectStats', async () => {
  const { data, error } = await supabase
    .from('subject_stats')
    .select('subject_id, mention_count, first_seen_at, last_seen_at, item_count');
  if (error) {
    if (isMissingRelationError(error)) return [];
    throw error;
  }
  return (data as SubjectStatsRow[]) ?? [];
});

function subjectSectionLabel(slug: string): string {
  const labels: Record<string, string> = {
    agent: 'Agent',
    agents: 'Agent',
    company: '公司',
    org: '组织',
    person: '人物',
    task: '任务',
    model: '模型',
    paper: '论文',
    package: 'Package',
    product: '产品',
    project: '项目',
    concept: '概念',
    research: '研究',
    infrastructure: '基础设施',
  };
  return labels[slug] || slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

const DIRECTORY_SECTION_LIMIT = 20;

function compareSubjectCatalogEntries(a: SubjectCatalogEntry, b: SubjectCatalogEntry): number {
  const priorityA = a.curation_priority || 0;
  const priorityB = b.curation_priority || 0;
  if (priorityA !== priorityB) return priorityB - priorityA;

  const lastSeenA = a.last_seen_at ? new Date(a.last_seen_at).getTime() : 0;
  const lastSeenB = b.last_seen_at ? new Date(b.last_seen_at).getTime() : 0;
  if (lastSeenA !== lastSeenB) return lastSeenB - lastSeenA;

  const mentionA = a.mention_count || 0;
  const mentionB = b.mention_count || 0;
  if (mentionA !== mentionB) return mentionB - mentionA;

  return a.display_name.localeCompare(b.display_name);
}

function mergeSubjectStats(
  subjects: SubjectCatalogEntry[],
  stats: SubjectStatsRow[],
): SubjectCatalogEntry[] {
  if (stats.length === 0) return [...subjects];

  const statsBySubject = new Map(stats.map(stat => [stat.subject_id, stat]));
  return subjects.map(subject => {
    const stat = statsBySubject.get(subject.id);
    if (!stat) return subject;
    return {
      ...subject,
      mention_count: stat.mention_count ?? subject.mention_count,
      first_seen_at: stat.first_seen_at ?? subject.first_seen_at,
      last_seen_at: stat.last_seen_at ?? subject.last_seen_at,
    };
  });
}

export const getDirectorySubjects = memo<SubjectCatalogEntry[]>('directorySubjects', async () => {
  const { data, error } = await supabase
    .from('subjects')
    .select('id, slug, type, display_name, aliases, description, definition, homepage_url, metadata, first_seen_at, last_seen_at, mention_count, status, directory_visible, section_slug, curation_priority, created_by')
    .eq('status', 'active')
    .eq('directory_visible', true)
    .neq('type', 'project')
    .order('curation_priority', { ascending: false })
    .order('display_name', { ascending: true });
  if (error) {
    if (isMissingRelationError(error)) return [];
    throw error;
  }
  const subjects = (data as SubjectCatalogEntry[]) ?? [];
  const stats = await getSubjectStats();
  return mergeSubjectStats(subjects, stats).sort(compareSubjectCatalogEntries);
});

export const getSubjectDirectorySections = memo<SubjectDirectorySection[]>('subjectDirectorySections', async () => {
  const subjects = await getDirectorySubjects();
  const sections = new Map<string, SubjectCatalogEntry[]>();

  for (const subject of subjects) {
    const key = subject.section_slug || subject.type || 'other';
    const existing = sections.get(key) || [];
    existing.push(subject);
    sections.set(key, existing);
  }

  return [...sections.entries()]
    .map(([slug, sectionSubjects]) => ({
      slug,
      label: subjectSectionLabel(slug),
      subjects: [...sectionSubjects].sort(compareSubjectCatalogEntries).slice(0, DIRECTORY_SECTION_LIMIT),
    }))
    .filter(section => section.subjects.length > 0)
    .sort((a, b) => {
      const priorityA = Math.max(...a.subjects.map(s => s.curation_priority || 0), 0);
      const priorityB = Math.max(...b.subjects.map(s => s.curation_priority || 0), 0);
      if (priorityA !== priorityB) return priorityB - priorityA;
      if (a.subjects.length !== b.subjects.length) return b.subjects.length - a.subjects.length;
      return a.label.localeCompare(b.label);
    });
});

export const getPublicDirectorySubjects = memo<SubjectCatalogEntry[]>('publicDirectorySubjects', async () => {
  const sections = await getSubjectDirectorySections();
  return sections.flatMap(section => section.subjects);
});

export async function getSubjectBySlug(slug: string): Promise<SubjectCatalogEntry | null> {
  const subjects = await getPublicDirectorySubjects();
  return subjects.find(subject => subject.slug === slug) ?? null;
}

export async function getSubjectInsights(subjectId: string): Promise<SubjectInsight[]> {
  const { data, error } = await supabase
    .from('subject_insights')
    .select('id, subject_id, snapshot_date, module_type, insight_key, title, summary, analysis, event_date, comparison_subject_ids, dimensions_json, importance_score, confidence, evidence_item_ids, evidence_refs_json, related_subject_ids, generated_by, generator_version, status, published_at')
    .eq('subject_id', subjectId)
    .eq('status', 'published')
    .order('module_type', { ascending: true })
    .order('event_date', { ascending: false, nullsFirst: false })
    .order('importance_score', { ascending: false, nullsFirst: false });
  if (error) {
    if (isMissingRelationError(error)) return [];
    throw error;
  }
  return (data as SubjectInsight[]) ?? [];
}

interface SubjectMentionRow {
  subject_id: string;
  item_id: string;
  snapshot_date: string;
  source_name: string | null;
  score: number | null;
  context: string | null;
  created_at: string | null;
  detected_by?: string | null;
  confidence?: number | null;
  evidence?: Record<string, any> | null;
}

interface DisplaySignalItem {
  processed_item_id: string;
  snapshot_date: string;
  source_name: string | null;
  processed_title: string | null;
  summary: string | null;
  original_url: string | null;
  aha_index: number | null;
  rank: number | null;
}

interface RawSnapshotSignalItem {
  id: string;
  snapshot_date: string;
  sub_source_type: string | null;
  title: string | null;
  content: string | null;
  url: string | null;
}

function dateOnly(value: string | null | undefined): string {
  return String(value || '').slice(0, 10);
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function mentionDate(row: SubjectMentionRow): string {
  return dateOnly(row.snapshot_date);
}

function evidenceTitle(row: SubjectMentionRow): string {
  const evidence = row.evidence || {};
  return String(evidence.title || evidence.item_title || row.context || row.item_id);
}

function evidenceSummary(row: SubjectMentionRow): string | null {
  const evidence = row.evidence || {};
  return (evidence.summary || row.context || null) as string | null;
}

function evidenceUrl(row: SubjectMentionRow): string | null {
  const evidence = row.evidence || {};
  return (evidence.source_url || null) as string | null;
}

async function fetchSubjectMentions(subjectIds: string[]): Promise<SubjectMentionRow[]> {
  const ids = [...new Set(subjectIds.filter(Boolean))];
  if (ids.length === 0) return [];

  const rows: SubjectMentionRow[] = [];
  for (const batch of chunkValues(ids, 100)) {
    const { data, error } = await supabase
      .from('subject_mentions')
      .select('subject_id, item_id, snapshot_date, source_name, score, context, created_at, detected_by, confidence, evidence')
      .in('subject_id', batch)
      .order('snapshot_date', { ascending: false })
      .order('created_at', { ascending: false });
    if (error) {
      if (isMissingRelationError(error)) return [];
      throw error;
    }
    rows.push(...((data as SubjectMentionRow[]) ?? []));
  }

  return rows;
}

export async function getSubjectSignalStatsBySubject(
  subjectIds: string[],
): Promise<Map<string, SubjectSignalStats>> {
  const mentions = await fetchSubjectMentions(subjectIds);
  const fallbackDate = await getLatestDate();
  const latestDate = mentions
    .map(mentionDate)
    .filter(Boolean)
    .sort()
    .at(-1) || fallbackDate || new Date().toISOString().slice(0, 10);

  const currentStart = addDays(latestDate, -29);
  const previousStart = addDays(latestDate, -59);
  const previousEnd = addDays(currentStart, -1);
  const sparkDates = Array.from({ length: 14 }, (_, i) => addDays(latestDate, i - 13));

  const bySubject = new Map<string, SubjectMentionRow[]>();
  for (const mention of mentions) {
    const existing = bySubject.get(mention.subject_id) || [];
    existing.push(mention);
    bySubject.set(mention.subject_id, existing);
  }

  const stats = new Map<string, SubjectSignalStats>();
  for (const subjectId of subjectIds) {
    const rows = bySubject.get(subjectId) || [];
    const currentRows = rows.filter(row => {
      const d = mentionDate(row);
      return d >= currentStart && d <= latestDate;
    });
    const previousRows = rows.filter(row => {
      const d = mentionDate(row);
      return d >= previousStart && d <= previousEnd;
    });

    const currentCount = currentRows.length;
    const previousCount = previousRows.length;
    const trendPct = previousCount > 0
      ? Math.round(((currentCount - previousCount) / previousCount) * 100)
      : currentCount > 0
        ? 100
        : 0;

    const latestSignal = [...rows].sort((a, b) => {
      const ad = a.created_at || a.snapshot_date;
      const bd = b.created_at || b.snapshot_date;
      return String(bd).localeCompare(String(ad));
    })[0];

    stats.set(subjectId, {
      subject_id: subjectId,
      signal_count_30d: currentCount,
      previous_signal_count_30d: previousCount,
      trend_pct_30d: trendPct,
      latest_signal_at: latestSignal?.created_at || latestSignal?.snapshot_date || null,
      sparkline: sparkDates.map(date => rows.filter(row => mentionDate(row) === date).length),
    });
  }

  return stats;
}

async function loadDisplaySignalItems(itemIds: string[]): Promise<Map<string, DisplaySignalItem>> {
  const map = new Map<string, DisplaySignalItem>();
  for (const batch of chunkValues([...new Set(itemIds)], 100)) {
    const { data, error } = await supabase
      .from('display_items')
      .select('processed_item_id, snapshot_date, source_name, processed_title, summary, original_url, aha_index, rank')
      .in('processed_item_id', batch);
    if (error) {
      if (isMissingRelationError(error)) return map;
      throw error;
    }
    for (const item of (data as DisplaySignalItem[]) ?? []) {
      map.set(`${item.processed_item_id}:${dateOnly(item.snapshot_date)}`, item);
    }
  }
  return map;
}

async function loadRawSnapshotSignalItems(itemIds: string[]): Promise<Map<string, RawSnapshotSignalItem>> {
  const map = new Map<string, RawSnapshotSignalItem>();
  for (const batch of chunkValues([...new Set(itemIds)], 100)) {
    const { data, error } = await supabase
      .from('octp_snapshot_raw_items')
      .select('id, snapshot_date, sub_source_type, title, content, url')
      .in('id', batch);
    if (error) {
      if (isMissingRelationError(error)) return map;
      throw error;
    }
    for (const item of (data as RawSnapshotSignalItem[]) ?? []) {
      map.set(`${item.id}:${dateOnly(item.snapshot_date)}`, item);
    }
  }
  return map;
}

export async function getSubjectSignals(
  subjectId: string,
  limit = 20,
): Promise<SubjectSignal[]> {
  const mentions = await fetchSubjectMentions([subjectId]);
  const sorted = mentions.sort((a, b) => {
    const dateDiff = mentionDate(b).localeCompare(mentionDate(a));
    if (dateDiff !== 0) return dateDiff;
    return Number(b.score || 0) - Number(a.score || 0);
  });
  const itemIds = sorted.map(row => row.item_id).filter(Boolean);
  const displayItems = await loadDisplaySignalItems(itemIds);
  const rawItems = await loadRawSnapshotSignalItems(itemIds);

  return sorted.slice(0, limit).map(row => {
    const key = `${row.item_id}:${mentionDate(row)}`;
    const displayItem = displayItems.get(key);
    const rawItem = rawItems.get(key);
    const evidence = row.evidence || {};

    return {
      subject_id: row.subject_id,
      item_id: row.item_id,
      snapshot_date: mentionDate(row),
      source_name: displayItem?.source_name || rawItem?.sub_source_type || row.source_name || (evidence.source_name as string) || null,
      title: displayItem?.processed_title || rawItem?.title || evidenceTitle(row),
      summary: displayItem?.summary || rawItem?.content || evidenceSummary(row),
      url: displayItem?.original_url || rawItem?.url || evidenceUrl(row),
      score: displayItem?.aha_index ?? row.score ?? null,
      rank: displayItem?.rank ?? (typeof evidence.rank === 'number' ? evidence.rank : null),
      confidence: row.confidence ?? null,
      detected_by: row.detected_by ?? null,
      external: Boolean(evidence.external || evidence.source_table === 'web_research'),
    };
  });
}

export async function getRelatedSubjects(
  subject: SubjectCatalogEntry,
  limit = 6,
): Promise<SubjectCatalogEntry[]> {
  const subjects = await getDirectorySubjects();
  const siblings = subjects.filter(candidate =>
    candidate.id !== subject.id &&
    (candidate.section_slug === subject.section_slug || candidate.type === subject.type)
  );
  return siblings.sort(compareSubjectCatalogEntries).slice(0, limit);
}
