# 23andMe Relatives — Inline Notes

Adds each relative's saved note directly after their name on
`https://you.23andme.com/family/relatives/`, with no label.

- **Trigger:** fires once 25 relatives are listed *and* a "Next" control is on the page.
- **Auth:** none of its own — it reuses the session you're already logged in with.
- **Network:** relatives are fetched **one at a time** with a gap between requests
  (~10-15 s for a page of 25), then cached for 12 hours, so paging back and forth
  costs no extra requests.
- **Rate limiting:** 23andMe answers bursts with HTTP 429, which blocks your own
  browsing too, not just this extension. A 429 stops the whole batch and starts a
  3-minute cooling-off period that is shared across tabs and survives a reload. A
  failed fetch is *never* cached as "no note" — those rows show `···` and are
  retried on the next load.
- **Empty notes** show nothing at all — no text, no separator.
- **Edits keep up:** when you change a note on a relative's page and hit Save, that
  one relative's cached note is refreshed on the spot, so the list is correct next
  time it loads. The other 24 are not re-fetched. (If the list is open in another
  tab, it updates there immediately.)

## Install

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. **Load unpacked** → select this folder.
4. Open the relatives list and page through it normally.

After editing any file, hit the reload arrow on the extension card, then reload the tab.

Extensions are off in incognito windows by default. To use it there, open the
extension's **Details** page and turn on **Allow in Incognito** — note that incognito
has its own storage, so nothing is cached between the two.

## Reading the rows

| Row shows | Meaning |
| --- | --- |
| the note text | fetched successfully |
| nothing | fetched successfully, this relative has no note |
| `···` | couldn't be read — rate limited, request failed, or no notes field found. Retried on the next page load, or automatically once the cooling-off period ends. |

## If nothing appears

Set `DEBUG: true` in [config.js](config.js), reload, and open DevTools console on the
relatives page. The log tells you which of the two halves is failing:

- `waiting: entries=0 …` → the relative links aren't being found.
- `fetching 25 of 25` but no text → the note isn't being found on the linked page.
- `cooling off for 180s - HTTP 429` → rate limited; it will resume on its own.
  Raise `REQUEST_DELAY_MS` in [config.js](config.js) if this keeps happening.

On a relative's own page the same log shows the edit sync:

- `sync: cached save "…"` → the edit was picked up and the list will show it.
- `sync: no notes field yet save` → the notes field isn't being recognized; pin
  `NOTES_SELECTORS` below.

### If a wrong word shows up instead of a note

Text like `Cancel Save` means the editor's buttons were read as the note. Buttons and
other controls are stripped before reading, and anything matching `UI_NOISE` in
[config.js](config.js) is discarded — add the offending word to that pattern.

### Pinning the relative links

Right-click a relative's name → Inspect. Copy the `<a>` tag, then set either:

```js
ENTRY_LINK_SELECTOR: 'a[href^="/p/"]',      // whatever the real prefix is
ENTRY_HREF_PATTERN: /^\/p\/[^/]+\/?$/,      // or just constrain auto-detect
```

### Pinning the note

Open one relative's page, scroll to the note at the bottom, Inspect it, and add its
selector to the front of `NOTES_SELECTORS`.

If the note **doesn't** live in the fetched HTML (likely, if the page renders
client-side), find it in the network traffic instead: DevTools → Network → XHR,
reload the relative's page, and look for the JSON response containing the note text.
Then set:

```js
NOTES_API: 'https://you.23andme.com/<the endpoint>/{id}/',
NOTES_JSON_PATH: 'notes',                   // dotted path inside that JSON
ENTRY_ID_PATTERN: /\/p\/([^/]+)/,           // how {id} is read out of the href
```

## Files

| File | Purpose |
| --- | --- |
| [manifest.json](manifest.json) | MV3 manifest — `storage` permission, `you.23andme.com` host access |
| [config.js](config.js) | All tunable selectors, trigger thresholds, and rate limits |
| [content.js](content.js) | Detection, fetching, note extraction, insertion |
