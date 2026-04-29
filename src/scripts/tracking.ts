const SUPABASE_URL = 'https://wyhpcfjtmtitorinkevj.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Ind5aHBjZmp0bXRpdG9yaW5rZXZqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI2ODQ5MzAsImV4cCI6MjA4ODI2MDkzMH0.wjhLn9RUriD5GWRm7yho-Ke6RpsvhJWseKaQUsIrJOw';

const UID_KEY = 'aha_briefing_uid';

function setCookie(name: string, value: string, days: number) {
  const expires = new Date();
  expires.setTime(expires.getTime() + days * 24 * 60 * 60 * 1000);
  document.cookie = `${name}=${value};expires=${expires.toUTCString()};path=/;SameSite=None;Secure`;
}

function getCookie(name: string) {
  const nameEQ = name + '=';
  const ca = document.cookie.split(';');
  for (let c of ca) {
    c = c.trim();
    if (c.indexOf(nameEQ) === 0) return c.substring(nameEQ.length);
  }
  return null;
}

function getUserId() {
  let uid = getCookie(UID_KEY);
  if (!uid) {
    uid = crypto.randomUUID();
    setCookie(UID_KEY, uid, 365);
  }
  return uid;
}

const trackedImpressions = new Set<string>();
let globalListenersAttached = false;

function trackEvent(
  itemId: string,
  snapshotDate: string,
  eventType: 'impression' | 'click' | 'click_original',
) {
  const userId = getUserId();
  if (!userId || !itemId || !snapshotDate) return;
  fetch(`${SUPABASE_URL}/rest/v1/user_events`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify({ item_id: itemId, snapshot_date: snapshotDate, event_type: eventType, user_id: userId }),
  }).catch(() => {});
}

function initImpressionTracking() {
  const cards = document.querySelectorAll<HTMLElement>('[data-item-id][data-snapshot-date]');

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const el = entry.target as HTMLElement;
        const itemId = el.dataset.itemId!;
        const snapshotDate = el.dataset.snapshotDate!;
        const key = `${itemId}-${snapshotDate}`;
        if (trackedImpressions.has(key)) return;

        setTimeout(() => {
          if (!trackedImpressions.has(key)) {
            trackedImpressions.add(key);
            trackEvent(itemId, snapshotDate, 'impression');
          }
          observer.unobserve(el);
        }, 5000);
      });
    },
    { threshold: 0.5 },
  );

  cards.forEach((card) => observer.observe(card));
}

function initClickOriginalTracking() {
  document.addEventListener('click', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-event="click_original"]');
    if (!el) return;
    const itemId = el.dataset.itemId;
    const snapshotDate = el.dataset.snapshotDate;
    if (itemId && snapshotDate) {
      trackEvent(itemId, snapshotDate, 'click_original');
    }
  });
}

function initClickTracking() {
  document.addEventListener('aha:modal-opened', ((e: CustomEvent) => {
    const { item_id, snapshot_date } = e.detail;
    if (item_id && snapshot_date) {
      trackEvent(item_id, snapshot_date, 'click');
    }
  }) as EventListener);
}

document.addEventListener('astro:page-load', () => {
  initImpressionTracking();
  if (!globalListenersAttached) {
    globalListenersAttached = true;
    initClickOriginalTracking();
    initClickTracking();
  }
});
