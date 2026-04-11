import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import sitemap from '@astrojs/sitemap';
import { createClient } from '@supabase/supabase-js';

const SITE = 'https://www.amazingindex.com';
const TABLE = 'display_items';

/** @returns {Promise<string[]>} */
async function loadSitemapDynamicUrls() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.warn(
      '[sitemap] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY; daily/article URLs are omitted from the sitemap.',
    );
    return [];
  }

  const supabase = createClient(url, key);
  const { data, error } = await supabase
    .from(TABLE)
    .select('snapshot_date, processed_item_id');

  if (error) {
    console.warn('[sitemap] Supabase query failed:', error.message);
    return [];
  }
  if (!data?.length) return [];

  const dates = new Set();
  const months = new Set();
  const articleIds = new Set();

  for (const row of data) {
    const d = row.snapshot_date;
    if (d) {
      dates.add(d);
      months.add(d.slice(0, 7));
    }
    if (row.processed_item_id) {
      articleIds.add(row.processed_item_id);
    }
  }

  const urls = [];
  for (const m of months) urls.push(`${SITE}/daily/${m}/`);
  for (const d of dates) urls.push(`${SITE}/daily/${d}/`);
  for (const pid of articleIds) urls.push(`${SITE}/article/${pid}/`);
  return urls;
}

export default defineConfig(async () => ({
  site: SITE,
  integrations: [
    sitemap({
      customPages: await loadSitemapDynamicUrls(),
    }),
  ],
  vite: {
    plugins: [tailwindcss()],
  },
  build: {
    format: 'directory',
  },
}));
