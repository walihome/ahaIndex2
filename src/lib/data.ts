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

// ─── Build-time memo cache ──────────────────────────
const _cache = new Map<string, any>();

function memo<T>(key: string, fn: () => Promise<T>): () => Promise<T> {
  return async () => {
    if (_cache.has(key)) return _cache.get(key) as T;
    const result = await fn();
    _cache.set(key, result);
    return result;
  };
}

function memoBy<T>(prefix: string, fn: (arg: string) => Promise<T>): (arg: string) => Promise<T> {
  return async (arg: string) => {
    const key = `${prefix}:${arg}`;
    if (_cache.has(key)) return _cache.get(key) as T;
    const result = await fn(arg);
    _cache.set(key, result);
    return result;
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

async function fetchAllRows<T>(
  createQuery: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: any }>,
): Promise<T[]> {
  const rows: T[] = [];
  let offset = 0;

  while (true) {
    const { data, error } = await createQuery(offset, offset + PAGE_SIZE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;

    rows.push(...data);
    if (data.length < PAGE_SIZE) break;

    offset += PAGE_SIZE;
  }

  return rows;
}

// ─── Core queries (memoized) ────────────────────────

export const getLatestDate = memo<string | null>('latestDate', async () => {
  const { data } = await supabase
    .from(TABLE)
    .select('snapshot_date')
    .order('snapshot_date', { ascending: false })
    .limit(1);
  return data?.[0]?.snapshot_date ?? null;
});

export const getAllDates = memo<string[]>('allDates', async () => {
  const data = await fetchAllRows<{ snapshot_date: string; processed_item_id: string }>((from, to) =>
    supabase
      .from(TABLE)
      .select('snapshot_date, processed_item_id')
      .order('snapshot_date', { ascending: false })
      .order('processed_item_id', { ascending: true })
      .range(from, to),
  );
  return [...new Set(data.map((r) => r.snapshot_date))];
});

export const getItemsByDate = memoBy<ProcessedItem[]>('itemsByDate', async (date: string) => {
  return fetchAllRows<ProcessedItem>((from, to) =>
    supabase
      .from(TABLE)
      .select('*')
      .eq('snapshot_date', date)
      .order('rank', { ascending: true })
      .order('processed_item_id', { ascending: true })
      .range(from, to),
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
  const { data } = await supabase
    .from(TABLE)
    .select('*')
    .eq('processed_item_id', pid)
    .limit(1);
  return (data?.[0] as ProcessedItem) ?? null;
}

export interface ArticleRouteItem {
  id: string;
  processed_item_id: string;
  snapshot_date: string;
}

export const getAllArticleRouteItems = memo<ArticleRouteItem[]>('allArticleRouteItems', async () => {
  return fetchAllRows<ArticleRouteItem>((from, to) =>
    supabase
      .from(TABLE)
      .select('id, processed_item_id, snapshot_date')
      .order('snapshot_date', { ascending: false })
      .order('processed_item_id', { ascending: true })
      .range(from, to),
  );
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
        items.reduce((s, i) => s + (i.aha_index || 0), 0) / items.length * 100;
      totalScore += dayScore;
      if (dayScore > peakScore) peakScore = dayScore;
    }
  }

  return {
    total_editions: dates.length,
    total_items: totalItems,
    avg_aha_score: dates.length > 0 ? totalScore / dates.length : 0,
    peak_aha_score: peakScore,
  };
});

export async function getMonthlyArchives(year: number): Promise<MonthlyArchive[]> {
  const dates = await getAllDates();
  const yearPrefix = `${year}-`;
  const yearDates = dates.filter((d) => d.startsWith(yearPrefix));

  const monthsMap: Record<string, string[]> = {};
  for (const d of yearDates) {
    const month = d.slice(0, 7);
    if (!monthsMap[month]) monthsMap[month] = [];
    monthsMap[month].push(d);
  }

  const result: MonthlyArchive[] = [];
  for (const [monthStr, monthDates] of Object.entries(monthsMap)) {
    let itemCount = 0;
    let totalScore = 0;
    let peakScore = 0;
    let peakDate = '';
    let topItem: ProcessedItem | null = null;

    for (const d of monthDates) {
      const items = await getItemsByDate(d);
      itemCount += items.length;
      if (items.length > 0) {
        const dayScore =
          items.reduce((s, i) => s + (i.aha_index || 0), 0) / items.length * 100;
        totalScore += dayScore;
        if (dayScore > peakScore) {
          peakScore = dayScore;
          peakDate = d;
        }
        for (const item of items) {
          if (
            !topItem ||
            (item.aha_index || 0) > (topItem.aha_index || 0)
          ) {
            topItem = item;
          }
        }
      }
    }

    result.push({
      month: `${monthStr}-01`,
      edition_count: monthDates.length,
      item_count: itemCount,
      avg_aha_score:
        monthDates.length > 0 ? totalScore / monthDates.length : 0,
      peak_aha_score: peakScore,
      peak_date: peakDate,
      summary: '',
      meta_description: '',
      top_story_title: topItem
        ? (topItem.processed_title || topItem.title || '')
        : '',
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
  const monthDates = dates.filter((d) => d.startsWith(monthPrefix));

  const weeksMap: Record<number, string[]> = {};
  for (const d of monthDates) {
    const weekNo = getWeekNumber(new Date(d));
    if (!weeksMap[weekNo]) weeksMap[weekNo] = [];
    weeksMap[weekNo].push(d);
  }

  const result: WeeklyArchive[] = [];
  for (const [weekNoStr, weekDates] of Object.entries(weeksMap)) {
    const weekNo = parseInt(weekNoStr, 10);
    let itemCount = 0;
    let totalScore = 0;
    let peakScore = 0;
    let peakDate = '';

    for (const d of weekDates) {
      const items = await getItemsByDate(d);
      itemCount += items.length;
      if (items.length > 0) {
        const dayScore =
          items.reduce((s, i) => s + (i.aha_index || 0), 0) / items.length * 100;
        totalScore += dayScore;
        if (dayScore > peakScore) {
          peakScore = dayScore;
          peakDate = d;
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
      avg_aha_score:
        weekDates.length > 0 ? totalScore / weekDates.length : 0,
      peak_aha_score: peakScore,
      peak_date: peakDate,
    });
  }

  return result.sort((a, b) => b.week_number - a.week_number);
}

export const getLatestDailyArchive = memo<DailyArchive | null>('latestDailyArchive', async () => {
  const { data } = await supabase
    .from('daily_archives')
    .select('snapshot_date, aha_score, aha_delta, item_count, top_story_title, top_story_source, top_tags, rarity_score, timeliness_score, impact_score, percentile_90d, percentile_tier, sample_size_90d')
    .order('snapshot_date', { ascending: false })
    .limit(1);
  return (data?.[0] as DailyArchive) ?? null;
});

export async function getDailyArchiveByDate(date: string): Promise<DailyArchive | null> {
  const { data } = await supabase
    .from('daily_archives')
    .select('snapshot_date, aha_score, aha_delta, item_count, top_story_title, top_story_source, top_tags, rarity_score, timeliness_score, impact_score, percentile_90d, percentile_tier, sample_size_90d')
    .eq('snapshot_date', date)
    .limit(1);
  return (data?.[0] as DailyArchive) ?? null;
}

export async function getDailyArchives(
  year: number,
  month: number,
): Promise<DailyArchive[]> {
  const dates = await getAllDates();
  const monthPrefix = `${year}-${String(month).padStart(2, '0')}-`;
  const monthDates = dates.filter((d) => d.startsWith(monthPrefix));

  const result: DailyArchive[] = [];
  const sortedDates = [...monthDates].sort();
  for (const d of sortedDates) {
    const items = await getItemsByDate(d);
    const dayScore =
      items.length > 0
        ? items.reduce((s, i) => s + (i.aha_index || 0), 0) / items.length * 100
        : 0;
    const sorted = [...items].sort(
      (a, b) => (b.aha_index || 0) - (a.aha_index || 0),
    );
    const top = sorted[0];

    result.push({
      snapshot_date: d,
      aha_score: dayScore,
      aha_delta: '',
      item_count: items.length,
      top_story_title: top
        ? (top.processed_title || top.title || '')
        : '',
      top_story_source: top ? top.source_name : '',
      top_tags: top?.tags?.slice(0, 3) ?? [],
      rarity_score: 0,
      timeliness_score: 0,
      impact_score: 0,
    });
  }

  // Compute aha_delta between consecutive days
  for (let i = 0; i < result.length; i++) {
    if (i === 0) {
      result[i].aha_delta = '';
    } else {
      const delta = result[i].aha_score - result[i - 1].aha_score;
      const sign = delta >= 0 ? '+' : '';
      result[i].aha_delta = `${sign}${delta.toFixed(1)}`;
    }
  }

  return result.sort((a, b) => b.snapshot_date.localeCompare(a.snapshot_date));
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

export const getProjectHeatmapData = memo<ProjectHeatmapRow[]>('phmData', async () => {
  const rows: ProjectHeatmapRow[] = [];
  const page_size = 1000;
  let offset = 0;
  while (true) {
    const { data, error } = await supabase
      .from('project_heatmap_data')
      .select('*')
      .range(offset, offset + page_size - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    rows.push(...(data as ProjectHeatmapRow[]));
    if (data.length < page_size) break;
    offset += page_size;
  }
  return rows;
});

export const getTracks = memo<TrackInfo[]>('tracks', async () => {
  const { data, error } = await supabase
    .from('tracks')
    .select('*')
    .eq('status', 'active')
    .order('display_order');
  if (error) throw error;
  return (data as TrackInfo[]) ?? [];
});

export const getProjects = memo<ProjectEntry[]>('projects', async () => {
  const rows = await getProjectHeatmapData();
  if (rows.length === 0) return [];

  // 按 subject_id 分组
  const grouped = new Map<string, ProjectHeatmapRow[]>();
  for (const row of rows) {
    const existing = grouped.get(row.subject_id) || [];
    existing.push(row);
    grouped.set(row.subject_id, existing);
  }

  const projects: ProjectEntry[] = [];

  for (const [subjectId, subjectRows] of grouped) {
    // 按日期排序
    subjectRows.sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date));

    const first = subjectRows[0];
    const related_data = first.related_data;

    // 构建 timeline
    const timeline: TimelineEntry[] = subjectRows
      .filter(r => r.score_100 !== null && r.score_100 !== undefined)
      .map(r => ({
        date: r.snapshot_date,
        aha: r.score_100!,
        role: r.role || undefined,
        source_name: r.source_name || undefined,
      }));

    // 计算 aha_current (最新日期) 和 aha_peak
    const scoresWithDate = subjectRows
      .filter(r => r.score_100 !== null && r.score_100 !== undefined)
      .map(r => ({ date: r.snapshot_date, score: r.score_100! }));

    const aha_current = scoresWithDate.length > 0 ? scoresWithDate[scoresWithDate.length - 1].score : 0;
    const aha_peak = scoresWithDate.length > 0 ? Math.max(...scoresWithDate.map(s => s.score)) : 0;

    // 计算 delta（最近两天的变化）
    let delta = '';
    if (scoresWithDate.length >= 2) {
      const diff = scoresWithDate[scoresWithDate.length - 1].score - scoresWithDate[scoresWithDate.length - 2].score;
      delta = `${diff >= 0 ? '+' : ''}${diff.toFixed(1)}`;
    }

    projects.push({
      subject_id: subjectId,
      slug: first.subject_slug,
      display_name: first.subject_name,
      type: first.subject_type,
      tags: first.tags || [],
      summary: first.summary,
      first_seen_at: first.first_seen_at,
      last_seen_at: first.last_seen_at,
      mention_count: first.mention_count || 0,
      track_id: first.track_id,
      track_name: first.track_name,
      track_group: first.track_group,
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

  // 按 aha_current 降序排序并赋予 rank
  projects.sort((a, b) => b.aha_current - a.aha_current);
  projects.forEach((p, i) => { p.rank = i + 1; });

  return projects;
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
  const rows = await getProjectHeatmapData();
  const dates = new Set<string>();
  for (const r of rows) {
    if (r.score_100 !== null && r.score_100 !== undefined) {
      dates.add(r.snapshot_date);
    }
  }
  return [...dates].sort();
});

// ─── Subject V2 directory queries ─────────────────────

export async function getSubjectStats(): Promise<SubjectStatsRow[]> {
  const { data, error } = await supabase
    .from('subject_stats')
    .select('subject_id, mention_count, first_seen_at, last_seen_at, item_count');
  if (error) {
    if (isMissingRelationError(error)) return [];
    throw error;
  }
  return (data as SubjectStatsRow[]) ?? [];
}

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

export async function getDirectorySubjects(): Promise<SubjectCatalogEntry[]> {
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
}

export async function getSubjectDirectorySections(): Promise<SubjectDirectorySection[]> {
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
}

export async function getPublicDirectorySubjects(): Promise<SubjectCatalogEntry[]> {
  const sections = await getSubjectDirectorySections();
  return sections.flatMap(section => section.subjects);
}

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
