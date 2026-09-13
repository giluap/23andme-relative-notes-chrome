/**
 * Tuning knobs for the inline-notes content script.
 *
 * Everything here has a working default that relies on auto-detection. If the
 * page changes, or auto-detection picks the wrong thing, pin the exact values
 * below and reload the extension - no other file needs to change.
 */
var RELNOTES_CONFIG = {
  /* Log what the script is doing to the page console. Turn on while tuning. */
  DEBUG: false,

  /* ---- Where the script is allowed to run ------------------------------- */
  PATH_PREFIX: '/family/relatives',

  /* ---- Trigger ---------------------------------------------------------- */
  /* Wait until a full page of relatives is listed AND paging is available. */
  MIN_ENTRIES: 25,
  REQUIRE_NEXT: true,
  NEXT_TEXT: /^\s*next\s*(?:page)?\s*[»>→]?\s*$/i,
  /* If the trigger never fires, run anyway after this many ms (0 = never). */
  FALLBACK_AFTER_MS: 0,

  /* ---- Finding each relative's row -------------------------------------- */
  /* CSS selector for the link on each relative's name. Empty = auto-detect
     (largest group of same-shaped, unique, same-origin links on the page). */
  ENTRY_LINK_SELECTOR: '',
  /* Optional guard: only links whose href matches are treated as relatives. */
  ENTRY_HREF_PATTERN: null, // e.g. /^\/p\/[a-z0-9]+\/?$/i

  /* ---- Finding the note on a relative's page ----------------------------- */
  /* Tried in order, first non-empty wins. Add the real one once known. */
  NOTES_SELECTORS: [
    '[data-testid*="note" i]',
    '[class*="note" i] textarea',
    'textarea[name*="note" i]',
    'textarea[id*="note" i]',
    '[aria-label*="note" i]'
  ],
  /* Optional JSON endpoint that returns the note, if the profile page is a
     client-rendered shell. {id} is replaced with the relative's id.
     e.g. 'https://you.23andme.com/api/profile/{id}/notes/' */
  NOTES_API: '',
  /* Dotted path to the note text inside that JSON, e.g. 'data.notes'. */
  NOTES_JSON_PATH: 'notes',
  /* How the relative's id is pulled out of the href for {id} above.
     null = last non-empty path segment. */
  ENTRY_ID_PATTERN: null, // e.g. /\/p\/([^/]+)/
  /* Editor chrome that must never be mistaken for note text. Matched against
     the whole extracted value, so a note that merely contains the word "save"
     is unaffected. */
  UI_NOISE: /^(?:\s*(?:cancel|save|saving\.{0,3}|edit|done|delete|remove|add(?:\s+a)?\s+note)\s*[,.·|/-]?\s*)+$/i,

  /* ---- Keeping the list in step with edits -------------------------------- */
  /* On a relative's own page, refresh that relative's cached note so the list
     is current next time it loads. Costs no extra requests. */
  SYNC_ON_PROFILE_PAGES: true,
  /* The button that commits an edit. */
  SAVE_BUTTON_TEXT: /^\s*save\s*$/i,
  /* Read the note back this long after Save is clicked, to let the site settle. */
  SAVE_READBACK_MS: [900, 2500],

  /* ---- Rendering --------------------------------------------------------- */
  /* Inserted unlabeled, immediately after the name. */
  NOTE_PREFIX: ' ',
  /* Collapse a multi-line note onto one line. */
  SINGLE_LINE: true,
  /* Inline styles win over most host CSS. Set to '' for fully unstyled text. */
  NOTE_STYLE: 'opacity:0.75;font-weight:400;white-space:pre-wrap;',
  /* Shown when a note could not be retrieved, so "couldn't load" is not
     mistaken for "no note". Set to '' to leave such rows blank. */
  FAILED_MARKER: '···',
  FAILED_TITLE: 'Note not loaded - will retry',

  /* ---- Network ------------------------------------------------------------
     23andMe rate-limits bursts with HTTP 429, and getting throttled affects
     your own browsing too, not just this extension. These defaults fetch one
     relative at a time, roughly 25 of them over 10-15 seconds. */
  MAX_CONCURRENT: 1,
  REQUEST_DELAY_MS: 800,
  REQUEST_TIMEOUT_MS: 15000,
  /* Per-relative retries for transient failures (not for 429s, which stop the
     whole batch instead). */
  RETRY_ATTEMPTS: 2,
  RETRY_BACKOFF_MS: [1500, 4000],
  /* After a 429, stop fetching entirely for this long. Shared across tabs and
     across page reloads, so refreshing does not immediately re-trigger it.
     A Retry-After header, when the server sends one, wins over this. */
  COOLDOWN_MS: 3 * 60 * 1000,
  /* Notes are cached so paging back and forth costs no requests. */
  CACHE_TTL_MS: 12 * 60 * 60 * 1000,
  /* A page that loaded but had no notes field is remembered only briefly.
     Requests that outright failed are never cached - they retry next load. */
  FAIL_TTL_MS: 15 * 60 * 1000
};
