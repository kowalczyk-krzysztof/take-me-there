# Chrome Web Store declarations

Paste-ready answers for the store listing, derived from the actual
code paths. Update this file when a flow changes.

## Single purpose

Identify travel places in photos, videos, and page images.

## Data sent off the device

Only after the user clicks "Agree & analyze" (or "Scan page",
alternatives for those runs), to `https://api.meta.ai` by default,
or to a user-configured custom server instead:

- The API key, to authenticate each call. Saving a key also sends
  the key alone to `GET /v1/models` to validate it.
- The clicked image address, or its bytes when the page blocks
  remote fetch. Image bytes are fetched without cookies.
- Page hints: page title, image caption or alt text, nearest
  heading and paragraph, site name, topic words from the page
  address, image filename words, and up to three JSON-LD place
  names. Never the full page address. An image-only setting
  withholds all page text.
- Video frame captures (data URLs) for video identify runs.
- The user's own inputs for that run: corrections ("not X") and
  alternative intents.

The custom server receives the same payloads. The options page
warns that a custom server has its own data handling.

## Data stored on the device only

AES-GCM encrypted API key in this browser profile (or memory
only in session-only mode), wrapping key in IndexedDB, settings,
consent flags, monthly cost totals, the recent result cache
(session storage: 7-day default expiry with a 1/7/30 day setting,
at most 10 entries and 2 MB, least-recently-used eviction, plus
a Clear control), and the short-lived tab handoff (session
storage, consumed or expired). Nothing here is uploaded anywhere.

## Data never touched

No browsing history, no cookies, no credentials, no page content
beyond the hints above, no analytics, no ads, no accounts. Page
addresses are hashed locally for cache keys and never sent.

## Permission justifications

- `contextMenus`: the right-click "Take me there" entry point.
- `sidePanel`: renders results next to the page.
- `scripting` + `activeTab`: run the page readers (signals,
  images, video frame) in the clicked tab only, after the
  gesture. No standing access to browsing.
- `storage`: local key, settings, spend, and cache; session
  handoff between worker and panel.
- Host `https://api.meta.ai/*`: the Muse API.
- Optional host `https://*/*`: a one-time per-run grant to
  download the clicked image when bytes are needed. The fetch runs
  in the page without cookies; the grant is removed right after the
  fetch, with a startup sweep for strays.

## Account deletion

Not applicable: there are no accounts. Removing the key in the UI
plus uninstalling removes all stored data (Chrome clears extension
storage on uninstall).
