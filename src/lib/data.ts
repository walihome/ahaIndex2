import { supabase } from './supabase';
import type {
  ProcessedItem,
  GlobalStats,
  MonthlyArchive,
  WeeklyArchive,
  DailyArchive,
} from './types';

const TABLE = 'display_items';

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
  const { data } = await supabase
    .from(TABLE)
    .select('snapshot_date')
    .order('snapshot_date', { ascending: false });
  if (!data) return [];
  return [...new Set(data.map((r) => r.snapshot_date))];
});

export const getItemsByDate = memoBy<ProcessedItem[]>('itemsByDate', async (date: string) => {
  const { data } = await supabase
    .from(TABLE)
    .select('*')
    .eq('snapshot_date', date)
    .order('rank', { ascending: true });
  return (data as ProcessedItem[]) ?? [];
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

export const getAllItems = memo<ProcessedItem[]>('allItems', async () => {
  const { data } = await supabase
    .from(TABLE)
    .select('*')
    .order('snapshot_date', { ascending: false })
    .order('rank', { ascending: true });
  return (data as ProcessedItem[]) ?? [];
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
