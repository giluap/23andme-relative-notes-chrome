/**
 * Inline notes for the 23andMe DNA Relatives list.
 *
 * On the list: once a full page of relatives is showing and "Next" appears,
 * each relative's linked page is fetched in the background (same origin, using
 * the session you are already logged in with), the note is pulled out of it,
 * and the text is dropped in right after the name - unlabeled. An empty note
 * inserts nothing at all.
 *
 * On a relative's own page: the note is read at load, and again whenever you
 * click Save, so the list shows the edited text next time it loads without
 * re-fetching the other relatives.
 *
 * The site rate-limits bursts with HTTP 429 - and being throttled breaks your
 * own browsing, not just this extension - so relatives are fetched one at a
 * time, a 429 stops the whole batch for a cooling-off period shared across
 * tabs and reloads, and a failed fetch is never cached as "no note".
 */
(() => {
  'use strict';

  const CFG = globalThis.RELNOTES_CONFIG;
  if (!CFG) return;

  const CLASS = 'relnotes-inline';
  const MARK = 'data-relnotes';
  const COOLDOWN_KEY = 'cooldownUntil';
  const SCHEMA_KEY = 'schema';
  const SCHEMA = 2;
  /* Editor furniture that is never part of a note. */
  const STRIP = 'button,[role="button"],input[type="button"],input[type="submit"],' +
                'input[type="reset"],select,option,svg,script,style,noscript,template';

  const log = (...a) => { if (CFG.DEBUG) console.log('[relnotes]', ...a); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const memCache = new Map();   // cacheKey -> {v, t, f?}
  const inflight = new Set();   // cacheKey
  let running = false;
  let firstSeenAt = Date.now();
  let lastWritten;              // profile pages: note text already cached for this URL
  let cooldownUntil = 0;        // no requests at all before this timestamp
  let resumeTimer = null;

  /* ---------------------------------------------------------------- page */

  const onRelativesPage = () => location.pathname.startsWith(CFG.PATH_PREFIX);

  /* Collapse id-looking path segments so links to different relatives share
     one shape: /p/ab12cd34/ and /p/ff99ee88/ both become /p/*. */
  function pathShape(pathname) {
    return pathname
      .split('/')
      .map((seg) => (/^[0-9]+$/.test(seg) || /^(?=.*[0-9])[A-Za-z0-9_-]{6,}$/.test(seg) ? '*' : seg))
      .join('/');
  }

  function uniqueByHref(anchors) {
    const seen = new Set();
    const out = [];
    for (const a of anchors) {
      if (seen.has(a.href)) continue;
      seen.add(a.href);
      out.push(a);
    }
    return out;
  }

  /* The links on each relative's name. Auto-detected as the largest family of
     same-shaped, unique, same-origin links that carry visible text. */
  function findEntryLinks() {
    if (CFG.ENTRY_LINK_SELECTOR) {
      try {
        return uniqueByHref([...document.querySelectorAll(CFG.ENTRY_LINK_SELECTOR)]);
      } catch (e) {
        log('bad ENTRY_LINK_SELECTOR', e);
        return [];
      }
    }

    const groups = new Map();
    for (const a of document.querySelectorAll('a[href]')) {
      let u;
      try { u = new URL(a.getAttribute('href'), location.href); } catch { continue; }
      if (u.origin !== location.origin) continue;
      if (u.pathname === location.pathname) continue;
      if (CFG.ENTRY_HREF_PATTERN && !CFG.ENTRY_HREF_PATTERN.test(u.pathname)) continue;
      if (!(a.textContent || '').trim()) continue;

      const key = pathShape(u.pathname);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(a);
    }

    let best = [];
    let bestKey = '';
    for (const [key, list] of groups) {
      const uniq = uniqueByHref(list);
      if (uniq.length > best.length) { best = uniq; bestKey = key; }
    }
    log('entry links', best.length, bestKey);
    return best;
  }

  function hasNext() {
    const els = document.querySelectorAll('a,button,[role="button"],li,span');
    for (const el of els) {
      const t = (el.textContent || '').trim();
      if (!t || t.length > 20) continue;
      if (CFG.NEXT_TEXT.test(t)) return true;
    }
    return false;
  }

  function triggerMet(links) {
    if (links.length < CFG.MIN_ENTRIES) {
      return CFG.FALLBACK_AFTER_MS > 0 &&
             links.length > 0 &&
             Date.now() - firstSeenAt > CFG.FALLBACK_AFTER_MS;
    }
    if (!CFG.REQUIRE_NEXT) return true;
    if (hasNext()) return true;
    return CFG.FALLBACK_AFTER_MS > 0 && Date.now() - firstSeenAt > CFG.FALLBACK_AFTER_MS;
  }

  /* --------------------------------------------------------------- notes */

  const normalize = (s) =>
    String(s == null ? '' : s).replace(/\r/g, '').replace(/[^\S\n]+/g, ' ')
      .split('\n').map((l) => l.trim()).join('\n').trim();

  const isNoise = (s) => !s || (CFG.UI_NOISE ? CFG.UI_NOISE.test(s) : false);

  /* Text of an element with its buttons and other controls removed, so an
     empty note never comes back as its editor's "Cancel Save". */
  function cleanText(el) {
    if (!el) return '';
    let node = el;
    try {
      node = el.cloneNode(true);
      node.querySelectorAll(STRIP).forEach((n) => n.remove());
    } catch { node = el; }
    return normalize(node.textContent);
  }

  const isEditable = (el) =>
    !!el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' ||
             el.getAttribute('contenteditable') === 'true' ||
             el.getAttribute('contenteditable') === '');

  /**
   * Read a note out of one element.
   * Returns null when this element tells us nothing, so the caller keeps
   * looking - but returns {text: ''} when it holds a genuinely empty editor,
   * which is a real answer and stops the search.
   */
  function noteFromElement(el) {
    if (!el) return null;

    const ctl = isEditable(el)
      ? el
      : el.querySelector('textarea, input[type="text"], [contenteditable="true"], [contenteditable=""]');

    if (ctl) {
      const raw = typeof ctl.value === 'string' ? ctl.value : cleanText(ctl);
      const text = normalize(raw);
      return { text: isNoise(text) ? '' : text, found: true };
    }

    const text = cleanText(el);
    if (isNoise(text)) return null;
    return { text, found: true };
  }

  function findNotesControl(root) {
    for (const sel of CFG.NOTES_SELECTORS) {
      let el;
      try { el = root.querySelector(sel); } catch { continue; }
      if (el) return el;
    }
    return null;
  }

  /* A "Notes" label with the note somewhere after it. */
  function findByLabel(root) {
    const cands = root.querySelectorAll('h1,h2,h3,h4,h5,h6,label,legend,dt,strong,b,span,div,p');
    for (const el of cands) {
      const label = normalize(el.textContent);
      if (!/^(my\s+)?notes?\s*:?\s*$/i.test(label)) continue;

      const forId = el.getAttribute && el.getAttribute('for');
      if (forId && root.getElementById) {
        const hit = noteFromElement(root.getElementById(forId));
        if (hit) return hit;
      }
      let sib = el.nextElementSibling;
      for (let i = 0; sib && i < 3; i++, sib = sib.nextElementSibling) {
        const hit = noteFromElement(sib);
        if (hit) return hit;
      }
      const parentText = cleanText(el.parentElement);
      if (parentText.length > label.length && parentText.startsWith(label)) {
        const text = normalize(parentText.slice(label.length).replace(/^\s*:?\s*/, ''));
        if (!isNoise(text)) return { text, found: true };
      }
    }
    return null;
  }

  /* Client-rendered page: the note usually still ships inside embedded JSON. */
  function findInEmbeddedJson(html) {
    const re = /"(?:notes?|note_text|noteText|relative_note|relativeNote)"\s*:\s*("(?:[^"\\]|\\.)*")/gi;
    let m, best = '';
    while ((m = re.exec(html))) {
      try {
        const v = normalize(JSON.parse(m[1]));
        if (v.length > best.length) best = v;
      } catch { /* not a plain string value */ }
    }
    return isNoise(best) ? '' : best;
  }

  /**
   * @returns {{text: string, found: boolean}} - found:false means no notes
   * field was located at all, which is a different thing from finding an
   * empty one.
   */
  function extractNote(root, rawHtml) {
    const direct = noteFromElement(findNotesControl(root));
    if (direct) return direct;

    const labelled = findByLabel(root);
    if (labelled) return labelled;

    if (rawHtml) {
      const json = findInEmbeddedJson(rawHtml);
      if (json) return { text: json, found: true };
    }
    return { text: '', found: false };
  }

  /* ------------------------------------------------------------ cooldown */

  const inCooldown = () => Date.now() < cooldownUntil;

  async function loadCooldown() {
    try {
      const until = (await chrome.storage.local.get(COOLDOWN_KEY))[COOLDOWN_KEY];
      if (typeof until === 'number' && until > cooldownUntil) cooldownUntil = until;
    } catch { /* storage unavailable */ }
  }

  /* A 429 means we are already asking too often - stop everything, including
     in other tabs and after a reload. */
  async function beginCooldown(ms, why) {
    const until = Date.now() + Math.max(1000, ms);
    if (until <= cooldownUntil) return;
    cooldownUntil = until;
    try { await chrome.storage.local.set({ [COOLDOWN_KEY]: until }); } catch { /* ignore */ }
    log('cooling off for', Math.round(ms / 1000) + 's', '-', why);
    scheduleResume();
  }

  function scheduleResume() {
    clearTimeout(resumeTimer);
    const wait = cooldownUntil - Date.now();
    if (wait <= 0) return;
    resumeTimer = setTimeout(() => { if (onRelativesPage()) run(); }, wait + 500);
  }

  /* --------------------------------------------------------------- fetch */

  /** @returns {{body?: any, url?: string, error?: string}} */
  async function request(url, asJson) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), CFG.REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        credentials: 'same-origin',
        signal: ctl.signal,
        headers: asJson ? { Accept: 'application/json' } : { Accept: 'text/html' }
      });

      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get('Retry-After') || '', 10);
        await beginCooldown(retryAfter > 0 ? retryAfter * 1000 : CFG.COOLDOWN_MS, 'HTTP 429');
        return { error: 'throttled' };
      }
      if (!res.ok) { log('HTTP', res.status, url); return { error: 'http ' + res.status }; }

      return { body: asJson ? await res.json() : await res.text(), url: res.url || url };
    } catch (e) {
      log('request failed', url, e && e.message);
      return { error: 'network' };
    } finally {
      clearTimeout(timer);
    }
  }

  function idFromHref(href) {
    const path = pathOf(href);
    if (CFG.ENTRY_ID_PATTERN) {
      const m = path.match(CFG.ENTRY_ID_PATTERN);
      if (m) return m[1] || m[0];
    }
    const segs = path.split('/').filter(Boolean);
    return segs[segs.length - 1] || '';
  }

  const getByPath = (obj, path) =>
    String(path || '').split('.').filter(Boolean)
      .reduce((o, k) => (o == null ? undefined : o[k]), obj);

  /**
   * @returns {{status: 'ok'|'notfound'|'fail', text: string, finalUrl: string}}
   *   ok       - the page was read and this is the note ('' means no note)
   *   notfound - the page was read but held no notes field
   *   fail     - the request itself failed; nothing is known, do not cache
   */
  async function fetchNote(href) {
    if (CFG.NOTES_API) {
      const res = await request(CFG.NOTES_API.replace('{id}', encodeURIComponent(idFromHref(href))), true);
      if (res.error) return { status: 'fail', text: '', finalUrl: href };
      const v = getByPath(res.body, CFG.NOTES_JSON_PATH);
      if (typeof v === 'string') {
        const text = normalize(v);
        return { status: 'ok', text: isNoise(text) ? '' : text, finalUrl: href };
      }
      return { status: 'notfound', text: '', finalUrl: href };
    }

    const res = await request(href, false);
    if (res.error) return { status: 'fail', text: '', finalUrl: href };

    const doc = new DOMParser().parseFromString(res.body, 'text/html');
    const { text, found } = extractNote(doc, res.body);
    return { status: found ? 'ok' : 'notfound', text, finalUrl: res.url };
  }

  async function fetchNoteWithRetry(href) {
    const attempts = 1 + Math.max(0, CFG.RETRY_ATTEMPTS);
    for (let i = 0; i < attempts; i++) {
      if (inCooldown()) return { status: 'fail', text: '', finalUrl: href };

      const res = await fetchNote(href);
      if (res.status !== 'fail') return res;
      if (i < attempts - 1) {
        await sleep(CFG.RETRY_BACKOFF_MS[Math.min(i, CFG.RETRY_BACKOFF_MS.length - 1)]);
      }
    }
    return { status: 'fail', text: '', finalUrl: href };
  }

  /* --------------------------------------------------------------- cache */

  const pathOf = (href) => {
    try { return new URL(href, location.href).pathname; } catch { return String(href || ''); }
  };
  const cacheKey = (href) => 'n:' + pathOf(href);
  /* A relative's page may sit at a different path than the link that led to
     it; this maps the landed-on path back to the key the list reads. */
  const aliasKey = (href) => 'a:' + pathOf(href);

  /** @returns {{text: string, ok: boolean}|undefined} */
  async function getCached(key) {
    let rec = memCache.get(key);
    if (rec === undefined) {
      try { rec = (await chrome.storage.local.get(key))[key]; } catch { rec = undefined; }
      if (rec) memCache.set(key, rec);
    }
    if (!rec) return undefined;

    const ttl = rec.f ? CFG.FAIL_TTL_MS : CFG.CACHE_TTL_MS;
    if (Date.now() - rec.t >= ttl) { memCache.delete(key); return undefined; }
    return { text: rec.v || '', ok: !rec.f };
  }

  /* `unresolved` records a page that loaded but held no notes field. A request
     that failed outright is never cached - it retries on the next load. */
  async function setCached(key, text, unresolved) {
    const rec = { v: text, t: Date.now() };
    if (unresolved) rec.f = true;
    memCache.set(key, rec);
    try { await chrome.storage.local.set({ [key]: rec }); } catch { /* ignore */ }
  }

  async function getRaw(key) {
    try { return (await chrome.storage.local.get(key))[key]; } catch { return undefined; }
  }

  /* --------------------------------------------------------------- render */

  const renderText = (text) =>
    CFG.NOTE_PREFIX + (CFG.SINGLE_LINE ? text.replace(/\s+/g, ' ').trim() : text);

  /**
   * state 'ok'      - show the note, or nothing at all when it is empty
   * state 'unknown' - show the marker, so "couldn't load" reads differently
   *                   from "no note"
   */
  function applyNote(href, text, state) {
    const body = text ? renderText(text)
      : (state === 'unknown' && CFG.FAILED_MARKER ? CFG.NOTE_PREFIX + CFG.FAILED_MARKER : '');
    const path = pathOf(href);

    for (const a of document.querySelectorAll('a[href]')) {
      if (pathOf(a.href) !== path) continue;
      const next = a.nextElementSibling;
      const existing = next && next.classList && next.classList.contains(CLASS) ? next : null;

      if (!body) { if (existing) existing.remove(); continue; }
      if (existing) {
        if (existing.textContent === body) continue;
        existing.remove();
      }
      const span = document.createElement('span');
      span.className = CLASS;
      span.setAttribute(MARK, state === 'unknown' ? 'unknown' : '1');
      if (CFG.NOTE_STYLE) span.setAttribute('style', CFG.NOTE_STYLE);
      if (state === 'unknown' && CFG.FAILED_TITLE) span.title = CFG.FAILED_TITLE;
      span.textContent = body;
      a.insertAdjacentElement('afterend', span);
    }
  }

  /* Re-insert what is already known, without touching the network. Cheap
     enough to run on every re-render of the list. */
  function reapplyFromMemory() {
    for (const a of findEntryLinks()) {
      const rec = memCache.get(cacheKey(a.href));
      if (rec) applyNote(a.href, rec.v, rec.f ? 'unknown' : 'ok');
    }
  }

  /* ---------------------------------------------------------------- queue */

  async function runQueue(tasks) {
    const workers = Array.from({ length: Math.max(1, CFG.MAX_CONCURRENT) }, async () => {
      while (tasks.length) {
        if (inCooldown()) return;          // abandon the rest of the batch
        const task = tasks.shift();
        try { await task(); } catch (e) { log('task failed', e); }
        if (CFG.REQUEST_DELAY_MS) await sleep(CFG.REQUEST_DELAY_MS);
      }
    });
    await Promise.all(workers);
  }

  async function run() {
    if (!onRelativesPage()) return;
    if (running) { reapplyFromMemory(); return; }

    const links = findEntryLinks();
    if (!triggerMet(links)) { log('waiting: entries=' + links.length + ' next=' + hasNext()); return; }

    running = true;
    try {
      await loadCooldown();

      const pending = [];
      for (const a of links) {
        const href = a.href;
        const cached = await getCached(cacheKey(href));
        if (cached) { applyNote(href, cached.text, cached.ok ? 'ok' : 'unknown'); continue; }
        pending.push(href);
      }
      if (!pending.length) return;

      if (inCooldown()) {
        log('still cooling off,', pending.length, 'relatives deferred');
        pending.forEach((href) => applyNote(href, '', 'unknown'));
        scheduleResume();
        return;
      }

      const done = new Set();
      const tasks = pending.map((href) => async () => {
        const key = cacheKey(href);
        if (inflight.has(key)) return;
        inflight.add(key);
        try {
          const { status, text, finalUrl } = await fetchNoteWithRetry(href);
          if (status === 'fail') { applyNote(href, '', 'unknown'); return; }

          await setCached(key, text, status === 'notfound');
          /* Remember where it landed, so an edit made there updates this row. */
          if (pathOf(finalUrl) !== pathOf(href)) {
            try { await chrome.storage.local.set({ [aliasKey(finalUrl)]: pathOf(href) }); } catch { /* ignore */ }
          }
          applyNote(href, text, status === 'notfound' ? 'unknown' : 'ok');
          done.add(href);
        } finally {
          inflight.delete(key);
        }
      });

      log('fetching', tasks.length, 'of', links.length);
      await runQueue(tasks);

      /* Whatever the batch could not settle stays visibly unknown and is left
         uncached, so the next page load tries it again. */
      for (const href of pending) if (!done.has(href)) applyNote(href, '', 'unknown');
      if (inCooldown()) scheduleResume();
    } finally {
      running = false;
    }
  }

  /* ------------------------------------------- a relative's own page sync */

  /**
   * Cache the note shown on this relative's page: once when the page settles,
   * and again after each Save, so the list is current next time it loads.
   * Typing alone never writes - only a committed value does. Never writes when
   * no notes field was found, which would clobber a good value with an empty
   * one.
   */
  async function syncProfileNote(reason, force) {
    if (!CFG.SYNC_ON_PROFILE_PAGES || onRelativesPage()) return;
    if (!force && lastWritten !== undefined) return;

    const { text, found } = extractNote(document, null);
    if (!found) { log('sync: no notes field yet', reason); return; }
    if (text === lastWritten) return;

    lastWritten = text;
    await setCached(cacheKey(location.href), text);

    const alias = await getRaw(aliasKey(location.href));
    if (typeof alias === 'string' && alias !== pathOf(location.href)) {
      await setCached('n:' + alias, text);
    }
    log('sync: cached', reason, JSON.stringify(text).slice(0, 80));
  }

  document.addEventListener('click', (ev) => {
    if (!CFG.SYNC_ON_PROFILE_PAGES || onRelativesPage()) return;
    const t = ev.target;
    const el = t && t.closest && t.closest('button,[role="button"],a,input[type="submit"]');
    if (!el) return;
    const label = normalize(el.textContent) ||
                  el.getAttribute('value') || el.getAttribute('aria-label') || '';
    if (!CFG.SAVE_BUTTON_TEXT.test(label)) return;
    for (const ms of CFG.SAVE_READBACK_MS) setTimeout(() => syncProfileNote('save', true), ms);
  }, true);

  /* -------------------------------------------------------------- observe */

  let timer = null;
  function schedule(delay = 350) {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (onRelativesPage()) run();
      else syncProfileNote('render', false);
    }, delay);
  }

  const observer = new MutationObserver((muts) => {
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n.nodeType === 1 && n.getAttribute && n.getAttribute(MARK)) continue;
        schedule();
        return;
      }
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  /* The site is a single-page app, so watch for route changes too. */
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    firstSeenAt = Date.now();
    lastWritten = undefined;
    log('navigated', lastUrl);
    schedule(600);
  }, 800);
  window.addEventListener('popstate', () => schedule(600));

  /* Edits and cooldowns from other tabs arrive here as storage changes. */
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;

      const cool = changes[COOLDOWN_KEY];
      if (cool && typeof cool.newValue === 'number' && cool.newValue > cooldownUntil) {
        cooldownUntil = cool.newValue;
        scheduleResume();
      }
      if (!onRelativesPage()) return;

      for (const [key, change] of Object.entries(changes)) {
        if (!key.startsWith('n:') || !change || !change.newValue) continue;
        memCache.set(key, change.newValue);
        applyNote(location.origin + key.slice(2), change.newValue.v,
                  change.newValue.f ? 'unknown' : 'ok');
      }
    });
  } catch { /* storage events unavailable */ }

  /* Earlier versions cached a failed fetch as "no note", so those entries have
     to go once - otherwise rows blanked by a 429 stay blank for 12 hours. */
  async function migrateCache() {
    try {
      if ((await chrome.storage.local.get(SCHEMA_KEY))[SCHEMA_KEY] === SCHEMA) return;
      const all = await chrome.storage.local.get(null);
      const stale = Object.keys(all).filter((k) => k.startsWith('n:'));
      if (stale.length) await chrome.storage.local.remove(stale);
      await chrome.storage.local.set({ [SCHEMA_KEY]: SCHEMA });
      log('dropped', stale.length, 'notes cached by an older version');
    } catch { /* storage unavailable */ }
  }

  migrateCache().then(loadCooldown).then(() => schedule(600));
  log('ready on', location.href);
})();
