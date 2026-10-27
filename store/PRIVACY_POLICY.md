# Privacy Policy - Plan a trip there

Effective for version 1.0.0. This policy describes exactly what the
extension does today. If a future release adds features (video analysis,
trip boards, page scanning, on-device AI), this policy will be updated
before that release ships.

## Overview

"Plan a trip there" identifies travel destinations in photos you
right-click while browsing, then streams a trip guide into Chrome's side
panel. It talks to exactly one outside service: the Meta Muse API at
`https://api.meta.ai`, using an API key you provide. There is no
analytics, no tracking, no advertising, and no data sale.

Nothing is sent anywhere until you click "Agree & analyze" (a one-time
consent gate shown after you save your key). Declining discards the
staged request.

## Data-flow table (source of truth)

Every row is one case where data leaves your browser. The Chrome Web
Store privacy-tab answers and the in-panel footer are generated from
this same table.

| When | What is sent | Where | Why |
| ---- | ------------ | ----- | --- |
| Key validation (on save) | Your API key, in the Authorization header | `https://api.meta.ai/v1/models` | Confirm the key works before anything else |
| Image analysis (after "Agree & analyze") | The image's web address (URL), the page URL and title, and short capped page-text snippets (alt text, captions, headings, nearby text, at most a few KB total) | `https://api.meta.ai` | Identify the place and write the guide |
| Grounded guide | The same request, plus Meta may run web searches on the place topic to ground facts | `https://api.meta.ai` | Current facts with cited sources |
| Video frame analysis (after the one-time video confirm) | The captured frame's pixels (a JPEG data URL), the page URL and title, and short capped page-text snippets | `https://api.meta.ai` | Identify the place in the frame |
| Full-video analysis (after the one-time video confirm) | The video's web address (Meta's servers fetch the video, including its soundtrack), plus the same page context | `https://api.meta.ai` | Identify the place from motion and audio |
| Booking-link click | The destination name, embedded in the link URL you clicked | The booking site you chose (Google, Airbnb, Booking.com, GetYourGuide, TripAdvisor, Expedia) | Open that site's search results |
| Manual-destination mode | Nothing leaves the browser | Nowhere | Links are built locally with no AI call |

Notes:

- The extension sends the image's URL, not the image pixels. Meta's
  servers fetch the image from that URL, so a capability-style URL
  (presigned link, signed CDN URL) inherently grants Meta access to the
  image. This is disclosed in the consent gate.
- Guide answers, source URLs, and place names returned by the API are
  rendered as text only. The extension never executes code from
  responses.
- Per Meta's API terms, standard models are not trained on your
  content. That is Meta's commitment, not ours; see Meta's own terms.

## What is stored on your device

| Data | Where | Lifetime and controls |
| ---- | ----- | --------------------- |
| API key | `chrome.storage.local`, AES-GCM encrypted (authentication information) | Until you clear it in Options or uninstall. Session-only mode keeps it in memory only: it is gone after a browser restart and no encrypted copy is written |
| Consent flag | `chrome.storage.local` | Until uninstall; consent is asked once |
| Monthly cost totals | `chrome.storage.local` | Viewable and resettable in Options; months older than ~24 are pruned |
| Analysis cache | `chrome.storage.session` (text only, hashed keys) | Wiped automatically when the browser exits; minimized while running |
| Settings (provider and model choice) | `chrome.storage.local` | Until uninstall |

Uninstalling the extension removes all of the above.

## What is never done

- No analytics, crash reporting, tracking pixels, or fingerprinting.
- No data sale, rental, or sharing for advertising.
- Nothing is sent anywhere except `https://api.meta.ai` (after consent)
  and the booking site whose link you click.
- The extension never reads pages in the background. It scrapes the
  clicked image's context once per right-click, inside that click, and
  only on the tab you clicked.

## Limited Use disclosure

Our use of information received from Google APIs is not applicable:
this extension does not use Google APIs. For the data the extension
handles (the items in the table above), we affirm the Limited Use
requirements applied by analogy to our single backend: user data is
used only to provide the trip-planning feature the user asked for, is
never sold, is never used for advertising, and is never shared with
third parties except the AI provider needed to fulfill the request,
with explicit per-user consent.

## Your controls

- Options page: view or clear the saved key, toggle session-only mode,
  view or reset the monthly cost total.
- Consent gate: decline ("Not now") to discard a staged analysis.
- Keyless baseline: without any key, the manual-destination input still
  builds booking links locally, sending nothing anywhere.
- Uninstall: removes every stored item listed above.

## Contact

Questions about this policy: open an issue on the project repository
or contact the developer through the Chrome Web Store listing.

## Changes

Material changes will be reflected in an updated policy shipped with
the release that makes them, and the effective version above will move
with it.
