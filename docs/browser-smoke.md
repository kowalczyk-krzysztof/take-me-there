# Browser smoke checklist

`npm run smoke:chrome` covers the keyless boundary (both pages boot
without errors, settings renders, 320px layout, dark theme, reduced
motion). Everything below needs a real key and a human; run it before
each release against a production `dist/`.

## Setup

1. `npm run build`, load `dist/` unpacked in Chrome.
2. Open the side panel on any photo page.

## First use

- [ ] Right-click a photo, choose Take me there: the panel asks for
      a key and names the staged image and page.
- [ ] Saving a bad key shows the rejection inline; saving a good key
      validates it without analyzing.
- [ ] The consent card names the image, the page, and the preview;
      Agree runs the analysis, Decline returns to idle.
- [ ] The result shows Maps and stays links, an estimated cost, and
      the paid-actions note before correction controls.

## Recovery

- [ ] Cancel during loading returns to idle with focus kept in the
      panel; no paid work lands afterwards.
- [ ] A failing alternative shows an inline error with Retry; the
      destination stays put.
- [ ] Revoke the key mid-session: the next run surfaces auth recovery.
- [ ] Reload the panel mid-run and reopen it: no ghost results, no
      replayed handoffs.

## Permissions

- [ ] An image that 400s shows the explicit Allow card naming the host;
      allowing downloads the bytes once and the grant is removed after.
- [ ] Denying keeps the destination card with a working retry.

## Layout and access

- [ ] 320px wide panel: tabs, result actions, and recovery buttons are
      reachable without sideways scrolling.
- [ ] 200% zoom and a very long destination name: no clipped actions.
- [ ] Light and dark themes: text stays readable, focus stays visible.
- [ ] Reduced motion: no overlay dwell delays the look-again crop.
- [ ] Keyboard only: photo, key entry, consent, result, and the Maps
      link are all reachable in a sensible order.
- [ ] A screen reader announces run status, errors, and the cached
      result without duplicate chatter.
