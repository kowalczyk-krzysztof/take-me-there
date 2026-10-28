# Take me there

![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)

See a photo of a place you love? Right-click it, choose "Take me
there", and the extension identifies the place and plans the trip,
right in Chrome's side panel.

## Features

- **Place identification.** Right-click any image (or a video frame)
  and Meta's Muse AI tells you where it is, with a confidence score.
- **Trip guides with sources.** Press "Plan a trip" for a written
  guide backed by live web results, each with a link you can check.
- **Page scan.** Right-click any page to find every place pictured
  on it, then guide or pin them one by one.
- **Compare and alternatives.** Put two places head to head, or ask
  for cheaper, quieter, or similar options.
- **Trip board.** Pin places from anywhere and turn them into a
  day-by-day route with booking links.
- **Honest pricing.** Every analysis shows exactly what it cost.
  Repeat views load from a local cache and cost nothing.

## Install

1. `npm ci --ignore-scripts`
2. `npm run build`
3. Open `chrome://extensions`, enable Developer mode, choose Load
   unpacked, and select the `dist/` folder.

## Use

1. Right-click a photo and choose "Take me there". The side panel
   opens and asks for your Meta Muse API key.
2. Paste the key, click "Agree & analyze". The place is identified.
3. Press "Plan a trip" to load the full guide, or pin the place to
   your trip board for later.

Your key is stored encrypted on your own machine (see Privacy),
but anyone with full access to your computer account could still
recover it, so only save it on a trusted device. A session-only
mode keeps it in memory and forgets it when the browser closes.

## Privacy

- Saving a key sends only the key itself to validate it. Nothing
  else leaves your machine until you click "Agree & analyze".
- Analysis requests go to Meta's Muse API, or to your custom server
  if you configured one on the Options page. Your key, images, and
  page text are used only to produce the result you asked for.
- Page images are downloaded only when needed, without your cookies,
  and the one-time permission is removed right after.
- No analytics, no tracking, no ads.

Stored on your machine, never uploaded anywhere except the API
calls above:

- API key: AES-GCM encrypted in this browser profile (or memory
  only, in session-only mode).
- Trip board: pinned places with page addresses and thumbnails.
- Cost totals: monthly spend per provider.
- Result cache: recent results keyed by image and page.
- Settings and consent flags: provider choice, toggles, Agree state.

## Architecture

```mermaid
flowchart TB
    user(["You right-click a photo, video, or page"]) --> worker["Service worker"]
    worker -->|"1. opens the panel at once"| panel["Side panel"]
    worker -->|"2. reads the page"| readers["Page readers<br/>(captions, headings, video frame)"]
    readers --> handoff[("Request handoff<br/>(short-lived tab storage)")]
    handoff --> panel

    subgraph Panel ["Side panel - three tabs"]
        direction TB
        main["Main<br/>identify, guide, compare, alternatives, scan"]
        board["Trip board<br/>pinned places and planned routes"]
        settingsTab["Settings<br/>API key setup"]
    end

    panel --> providers["Provider layer (one interface)"]
    providers --> muse["Meta Muse<br/>(muse-spark-1.3)"]
    providers --> compat["Custom server<br/>(any OpenAI-style API)"]
    muse --> identify["chat/completions<br/>names the place as strict JSON"]
    muse --> guide["responses + web search<br/>writes the guide with cited sources"]
    board --> pins[("Pin store<br/>(this device only)")]
    settingsTab --> vault["Key vault<br/>(AES-GCM encrypted)"]
```

## How Muse is used

All Muse calls go to `https://api.meta.ai`, model `muse-spark-1.3`.
It is the only website the extension talks to by default.

| Call                        | What it does                                                               | What is sent                                 |
| --------------------------- | -------------------------------------------------------------------------- | -------------------------------------------- |
| `GET /v1/models`            | Checks your key when you save it                                           | Key only, nothing else                       |
| `POST /v1/chat/completions` | Identifies the place, compares places, suggests alternatives, plans routes | Image plus page text (never without consent) |
| `POST /v1/responses`        | Writes the trip guide with live web search                                 | Place name plus your question                |

A typical analysis costs a few cents: tokens plus about $0.0025 per
web search. The panel shows the exact figure after every run, and a
monthly total on the options page. Prefer another backend? Point the
custom server option at any OpenAI-style endpoint instead.

## Develop

- `npm run dev` - rebuild on change.
- `npm test` - the full suite (happy-dom, no browser needed).
- `npm run typecheck` - strict TypeScript, unused code flagged.
- `npm run format` - Prettier across the repo.
- `node scripts/verify-bundle.mjs` - confirms the bundles carry no
  `eval`-style code (Manifest V3 forbids it) and that the page
  readers ship inside the worker bundle.

## License

MIT, Copyright (c) 2026 Krzysztof Kowalczyk. See `LICENSE`.
Bundled open-source libraries are attributed in
`THIRD_PARTY_NOTICES`.
