function initModal() {
  let injectedBackdrop: HTMLElement | null = null;
  let previousUrl = '';
  let previousTitle = '';

  function lockScroll() {
    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
    document.body.style.overflow = 'hidden';
    document.body.style.paddingRight = `${scrollbarWidth}px`;
  }

  function unlockScroll() {
    document.body.style.overflow = '';
    document.body.style.paddingRight = '';
  }

  function closeModal() {
    if (!injectedBackdrop) return;
    injectedBackdrop.remove();
    injectedBackdrop = null;
    unlockScroll();

    if (previousUrl) {
      history.replaceState({ modal: false }, '', previousUrl);
      document.title = previousTitle;
      previousUrl = '';
      previousTitle = '';
    }
  }

  function openModal(html: string, articleUrl: string) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    const backdrop = doc.querySelector('.backdrop');
    if (!backdrop) {
      window.location.href = articleUrl;
      return;
    }

    const newTitle = doc.querySelector('title')?.textContent || document.title;

    previousUrl = location.href;
    previousTitle = document.title;

    injectedBackdrop = backdrop.cloneNode(true) as HTMLElement;
    document.body.appendChild(injectedBackdrop);

    lockScroll();

    history.pushState({ modal: true, articleUrl }, '', articleUrl);
    document.title = newTitle;

    injectedBackdrop.addEventListener('click', (e) => {
      if (e.target === injectedBackdrop) closeModal();
    });

    injectedBackdrop.querySelectorAll('.close-btn, .close-footer-btn').forEach((btn) => {
      btn.addEventListener('click', closeModal);
    });

    document.addEventListener('keydown', onEscape);
  }

  function onEscape(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      closeModal();
      document.removeEventListener('keydown', onEscape);
    }
  }

  document.addEventListener('click', async (e) => {
    const link = (e.target as HTMLElement).closest<HTMLAnchorElement>('a[href^="/article/"]');
    if (!link) return;
    if (document.querySelector('.backdrop')) return;

    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    const articleUrl = link.getAttribute('href')!;

    const itemId = link.dataset.itemId;
    const snapshotDate = link.dataset.snapshotDate;

    try {
      const resp = await fetch(articleUrl);
      if (!resp.ok) {
        window.location.href = articleUrl;
        return;
      }
      const html = await resp.text();
      openModal(html, articleUrl);

      if (itemId && snapshotDate) {
        document.dispatchEvent(new CustomEvent('aha:modal-opened', {
          detail: { item_id: itemId, snapshot_date: snapshotDate },
        }));
      }
    } catch {
      window.location.href = articleUrl;
    }
  }, true);

  window.addEventListener('popstate', () => {
    if (injectedBackdrop) {
      injectedBackdrop.remove();
      injectedBackdrop = null;
      unlockScroll();
      document.title = previousTitle || document.title;
      previousUrl = '';
      previousTitle = '';
    }
  });
}

document.addEventListener('astro:page-load', initModal);
