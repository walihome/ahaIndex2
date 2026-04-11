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
const pendingTimers = new Map<string, number>();

function trackEvent(
  itemId: string,
  snapshotDate: string,
  eventType: 'impression' | 'click' | 'click_original',
) {
  const userId = getUserId();
  if (!userId || !itemId || !snapshotDate) return;
  // Future: send to Supabase user_events table
  console.log(`[tracking] ${eventType}`, { item_id: itemId, snapshot_date: snapshotDate, user_id: userId });
}

function initImpressionTracking() {
  const cards = document.querySelectorAll<HTMLElement>('[data-item-id][data-snapshot-date]');

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        const el = entry.target as HTMLElement;
        const itemId = el.dataset.itemId!;
        const snapshotDate = el.dataset.snapshotDate!;
        const key = `${itemId}-${snapshotDate}`;

        if (trackedImpressions.has(key)) return;

        if (entry.isIntersecting) {
          const timer = window.setTimeout(() => {
            pendingTimers.delete(key);
            if (!trackedImpressions.has(key)) {
              trackedImpressions.add(key);
              trackEvent(itemId, snapshotDate, 'impression');
              observer.unobserve(el);
            }
          }, 5000);
          pendingTimers.set(key, timer);
        } else {
          const timer = pendingTimers.get(key);
          if (timer !== undefined) {
            clearTimeout(timer);
            pendingTimers.delete(key);
          }
        }
      });
    },
    { threshold: 0.5 },
  );

  cards.forEach((card) => observer.observe(card));
}

function initClickTracking() {
  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;

    const articleLink = target.closest<HTMLAnchorElement>('a[href^="/article/"]');
    if (articleLink) {
      const itemId = articleLink.dataset.itemId;
      const snapshotDate = articleLink.dataset.snapshotDate;
      if (itemId && snapshotDate) {
        trackEvent(itemId, snapshotDate, 'click');
      }
      return;
    }

    const originalBtn = target.closest<HTMLElement>('[data-event="click_original"]');
    if (originalBtn) {
      const itemId = originalBtn.dataset.itemId;
      const snapshotDate = originalBtn.dataset.snapshotDate;
      if (itemId && snapshotDate) {
        trackEvent(itemId, snapshotDate, 'click_original');
      }
    }
  });
}

document.addEventListener('astro:page-load', () => {
  initImpressionTracking();
  initClickTracking();
});
