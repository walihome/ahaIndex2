export interface DisplayMetric {
  label: string;
  value: string;
}

export interface DisplayMetrics {
  items: DisplayMetric[];
}

export interface ProcessedItem {
  id: string;
  processed_item_id: string;
  snapshot_date: string;
  source_name: string;
  content_type: string;
  title?: string;
  url?: string;
  original_url?: string;
  author: string | null;
  processed_title?: string | null;
  summary: string | null;
  category: string | null;
  tags: string[] | null;
  keywords: string[] | null;
  aha_index: number;
  expert_insight: string | null;
  display_metrics: DisplayMetrics | null;
  raw_metrics: any | null;
  extra?: any | null;
  rank: number;
  model: string | null;
  created_at: string | null;
}

export interface MonthlyArchive {
  month: string;
  edition_count: number;
  item_count: number;
  avg_aha_score: number;
  peak_aha_score: number;
  peak_date: string;
  summary: string;
  meta_description: string;
  top_story_title?: string;
}

export interface WeeklyArchive {
  year: number;
  week_number: number;
  start_date: string;
  end_date: string;
  edition_count: number;
  item_count: number;
  avg_aha_score: number;
  peak_aha_score: number;
  peak_date: string;
}

export interface DailyArchive {
  snapshot_date: string;
  aha_score: number;
  aha_delta: string;
  item_count: number;
  top_story_title: string;
  top_story_source: string;
  top_tags: string[];
  rarity_score: number;
  timeliness_score: number;
  impact_score: number;
  percentile_90d?: number | null;
  percentile_tier?: string | null;
  sample_size_90d?: number | null;
}

export interface GlobalStats {
  total_editions: number;
  total_items: number;
  avg_aha_score: number;
  peak_aha_score: number;
}
