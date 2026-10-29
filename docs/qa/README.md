# Visual QA (section 8)

## What is verified in CI

- Text contrast: `src/components/shared_styles.test.ts` asserts 4.5:1 or
  better for body, muted, action labels (both themes), and error text,
  plus 3:1 or better for action fills and focus indicators against card
  and background.
- Saved states use text plus color: pin buttons switch to the Saved label
  when pressed (trip-card and sidepanel tests).
- Board order, undo, export, and itinerary states are covered by unit and
  panel tests; styling cannot change their assertions.

## Screenshot matrix

`node docs/qa/harness.mjs` builds file:// pages from `dist/` with a
minimal chrome-API stub, drives headless Chrome over CDP, and writes one
PNG per row into this directory. Every shot audits itself: exact
viewport width, emulated color scheme, no horizontal overflow, and no
visible button clipped or collapsed. The command exits nonzero on any
audit failure.

| Shot                        | Page                            | Width       | Theme | Notes                                   |
| --------------------------- | ------------------------------- | ----------- | ----- | --------------------------------------- |
| sidepanel-idle-320/400/520  | sidepanel, no key               | 320/400/520 | light | idle hint, preview placeholder          |
| sidepanel-board-320/400/520 | sidepanel, 2 seeded pins        | 320/400/520 | light | monograms, Up/Down/Remove, Plan, export |
| sidepanel-board-stale-400   | sidepanel, mismatched itinerary | 400         | light | outdated-plan note                      |
| sidepanel-settings-400      | sidepanel settings tab          | 400         | light | key form, sections                      |
| options-520                 | options page                    | 520         | light |                                         |
| onboarding-400              | onboarding page                 | 400         | light |                                         |
| sidepanel-board-400-dark    | board                           | 400         | dark  | `#6eadff` action, `#1d1e24` label       |
| sidepanel-idle-400-dark     | idle                            | 400         | dark  |                                         |
| sidepanel-board-400-zoom200 | board, 2x scale factor          | 400 CSS     | light | 200% zoom equivalent                    |
| sidepanel-idle-400-motion   | idle, reduced motion            | 400         | light | transitions/animations off              |
| sidepanel-board-400-focus   | board, Plan focused             | 400         | light | visible focus ring                      |
| sidepanel-guide-rtl-400     | guide region, `lang=ar`         | 400         | light | harness-injected sample content, RTL    |

## Environment-limited checks

- These screenshots were not captured in the sandboxed agent
  environment: browser subprocesses abort there, so run the harness on a
  workstation with Chrome (`CHROME_BIN` override supported) after
  `npm run build`.
- Key-saved states are not pictured: the vault needs a real wrapping
  key, which the stub cannot mint. Layout is identical apart from the
  key status line and management buttons.
- The RTL shot injects sample guide HTML through the harness (labeled
  in-content); the region, `dir`, and `lang` handling are production
  code paths.
- Keyboard reachability beyond the focus-ring shot (roving tabs, guide
  region tab stop) is covered by unit tests, not pictures.
