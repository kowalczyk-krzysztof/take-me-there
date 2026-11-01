# Privacy Policy - Take me there

Effective for version 1.0.0. This policy describes exactly what the
extension does today. If a future release adds features, this policy
will be updated before that release ships.

## Overview

"Take me there" identifies travel destinations in photos and videos
you right-click while browsing, and shows the answer in Chrome's side
panel. It talks to exactly one outside service: the Meta Muse API at
`https://api.meta.ai`, using a Muse API key you provide. There is no
analytics, no tracking, no advertising, and no data sale.

Saving a key sends only the key itself to validate it. Nothing else
is sent anywhere until you click "Agree & analyze" (a consent gate
shown before your first analysis). Declining discards the staged
request. Videos ask once more with their own confirm step before the
first video analysis.

## Data-flow table (source of truth)

Every row is one case where data leaves your browser. The Chrome Web
Store privacy-tab answers and the in-panel footer say the same thing
in shorter form.

| When                                                    | What is sent                                                                                                                                                                                                                                                                     | Where                           | Why                                                                        |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | -------------------------------------------------------------------------- |
| Key validation (on save)                                | Your Muse API key, in the Authorization header                                                                                                                                                                                                                                   | `https://api.meta.ai/v1/models` | Confirm the key works before anything else                                 |
| Image analysis (after "Agree & analyze")                | The image's web address (URL), short capped page-text snippets (page title, alt text, captions, headings, nearby text, site name, topic words from the address, image filename words, up to three JSON-LD place names), and your correction ("not X") when you re-analyze        | `https://api.meta.ai`           | Identify the place                                                         |
| Image byte-fetch retry (automatic)                      | The downloaded image pixels (JPEG data URL) instead of the image address, plus the same page context. The extension downloads the bytes itself, in the page tab without cookies when possible; otherwise it borrows a one-time host permission that is removed immediately after | `https://api.meta.ai`           | Identify images the API cannot fetch itself                                |
| Video frame analysis (after the one-time video confirm) | The captured frame's pixels (a JPEG data URL) plus the same page context                                                                                                                                                                                                         | `https://api.meta.ai`           | Identify the place in the frame                                            |
| Full-video analysis (after the one-time video confirm)  | The video's web address (Meta's servers fetch the video, including its soundtrack when the format carries one), plus the same page context                                                                                                                                       | `https://api.meta.ai`           | Identify the place from motion and audio when no frame could be captured   |
| Look again (only when you click it)                     | The image pixels for a landmark crop, then a second identify call on the cropped pixels with your previous guess marked wrong                                                                                                                                                    | `https://api.meta.ai`           | Take a harder second look at a photo with no clear place                   |
| Alternatives (only when you click an intent)            | The identified place name and country plus your chosen intent (cheaper, quieter, similar)                                                                                                                                                                                        | `https://api.meta.ai`           | Suggest alternative destinations, optionally grounded with live web search |
| Link click                                              | The destination name, embedded in the link URL you clicked                                                                                                                                                                                                                       | Google Maps or Google Hotels    | Open that site's search results                                            |

Notes:

- The extension usually sends the image's URL, not the image pixels.
  Meta's servers fetch the image from that URL, so a capability-style
  URL (presigned link, signed CDN URL) inherently grants Meta access
  to the image. This is disclosed in the consent gate.
- The full page address is never sent. Only short derived snippets
  (listed above) leave the browser, and only after consent. The photo
  source host shown under a result is computed locally for display.
- Place names returned by the API are rendered as text only. The
  extension never executes code from responses.
- Image-only mode withholds all page text. Skipping web search avoids
  the paid grounding call on alternatives.
- Per Meta's API terms, standard models are not trained on your
  content. That is Meta's commitment, not ours; see Meta's own terms.

## What is stored on your device

| Data                               | Where                                                          | Lifetime and controls                                                                                                                                                                                                              |
| ---------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Muse API key                       | `chrome.storage.local`, AES-GCM encrypted                      | Until you clear it in Settings or uninstall. Session-only mode keeps it in memory only: it is gone after a browser restart and no encrypted copy is written                                                                        |
| Consent flag (versioned)           | `chrome.storage.local`                                         | Until uninstall; asked again if the consent terms change                                                                                                                                                                           |
| Video confirm flag (versioned)     | `chrome.storage.local`                                         | Until uninstall; asked again if the video terms change                                                                                                                                                                             |
| Key-wrapping key                   | Extension-origin IndexedDB (non-extractable AES-GCM key)       | Until uninstall or profile wipe; API keys cannot be decrypted without it                                                                                                                                                           |
| Monthly cost totals                | `chrome.storage.local`                                         | Viewable on the Settings tab; months older than ~24 are pruned                                                                                                                                                                     |
| Analysis cache                     | `chrome.storage.session` (identified places only, hashed keys) | Entries expire after 7 days by default (Settings offers 1 or 30 days); at most 10 entries and 2 MB are kept, least-recently-used first. "Clear cached results" wipes it on demand, and quitting the browser wipes it automatically |
| Settings (search modes, retention) | `chrome.storage.local`                                         | Until uninstall                                                                                                                                                                                                                    |
| Short-lived tab handoff            | `chrome.storage.session`                                       | Consumed by the panel within seconds, or expired after 10 minutes                                                                                                                                                                  |

Uninstalling the extension removes all of the above.

## What is never done

- No analytics, crash reporting, tracking pixels, or fingerprinting.
- No data sale, rental, or sharing for advertising.
- Nothing is sent anywhere except `https://api.meta.ai` after
  consent, and the Google site whose link you click.
- The extension never reads pages in the background. It scrapes the
  clicked image's context once per right-click, inside that click, and
  only on the tab you clicked.

## Limited Use disclosure

Our use of information received from Google APIs is not applicable:
this extension does not use Google APIs. For the data the extension
handles (the items in the table above), we affirm the Limited Use
requirements applied by analogy to our single backend: user data is
used only to provide the place-identification feature the user asked
for, is never sold, is never used for advertising, and is never
shared with third parties except the AI provider needed to fulfill
the request, with explicit per-user consent.

## Your controls

- Settings tab (and the Options page): toggle image-only and
  web-search modes, view or clear the saved key, toggle session-only
  mode, set result retention (1, 7, or 30 days), clear cached results,
  and view the monthly cost total.
- Consent gate: decline ("Not now") to discard a staged analysis.
- Uninstall: removes every stored item listed above.

## Contact

Questions about this policy: open an issue on the project repository
or contact the developer through the Chrome Web Store listing.

## Changes

Material changes will be reflected in an updated policy shipped with
the release that makes them, and the effective version above will move
with it.
