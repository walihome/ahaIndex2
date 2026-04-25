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

function trackEvent(
  itemId: string,
  snapshotDate: string,
  eventType: 'impression' | 'click' | 'click_original',
) {
  const userId = getUserId();
  if (!userId || !itemId || !snapshotDate) return;
  fetch('/api/track-event', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
        }, 1000);
      });
    },
    { threshold: 0.5 },
  );

  cards.forEach((card) => observer.observe(card));
}

function initClickTracking() {
  document.querySelectorAll<HTMLElement>('[data-event="click_original"]').forEach((el) => {
    el.addEventListener('click', () => {
      const itemId = el.dataset.itemId;
      const snapshotDate = el.dataset.snapshotDate;
      if (itemId && snapshotDate) {
        trackEvent(itemId, snapshotDate, 'click_original');
      }
    });
  });
}

document.addEventListener('astro:page-load', () => {
  initImpressionTracking();
  initClickTracking();
});
