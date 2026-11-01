# Chrome Web Store declarations

Paste-ready answers for the store listing, derived from the actual
code paths. Update this file when a flow changes.

## Single purpose

Identify travel places in photos and videos.

## Data sent off the device

Only after the user clicks "Agree & analyze" (alternatives for
those runs reuse it), to `https://api.meta.ai`:

- The Muse API key, to authenticate each call. Saving a key also sends
  the key alone to `GET /v1/models` to validate it.
- The clicked image address, or its pixels for inline images and
  on-demand retries. Image bytes are fetched without cookies.
  Unparsable addresses fall back to page text only.
- After agreement, the panel loads a small preview of the image
  from its host without cookies. Remote previews never load
  before consent.
- Page hints: page title, image caption or alt text, nearest
  heading and paragraph, site name, topic words from the page
  address, image filename words, and up to three JSON-LD place
  names. Never the full page address. An image-only setting
  withholds all page text.
- Video frame captures (data URLs) for video identify runs.
- The user's own inputs for that run: corrections ("not X") and
  alternative intents.

## Data stored on the device only

AES-GCM encrypted Muse API key in this browser profile (or memory
only in session-only mode), wrapping key in IndexedDB, settings,
consent flags, the temporary host-grant journal, monthly cost totals, the recent result cache
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
  video frame) in the clicked tab only, after the gesture. No
  standing access to browsing.
- `storage`: local key, settings, spend, and cache; session
  handoff between worker and panel.
- Host `https://api.meta.ai/*`: the Muse API.
- Optional host `https://*/*`: only after the user clicks
  "Allow access to <host> and retry" on an explicit card, and
  only when the page itself cannot supply the bytes, a one-time
  grant downloads the clicked image. The grant covers the
  download only, is removed and verified removed right after,
  and a persistent journal plus a startup sweep retries strays.
  Local `http://127.0.0.1/*` and `http://localhost/*` test
  servers need no grant.

## Account deletion

Not applicable: there are no accounts. Removing the key in the UI
plus uninstalling removes all stored data (Chrome clears extension
storage on uninstall).
