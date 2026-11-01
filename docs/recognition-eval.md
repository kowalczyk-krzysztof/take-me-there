# Recognition evaluation

Small repeatable set for judging identification quality and the
confidence language. Run it with a real key:

```
MUSE_EVAL_KEY=LLM_... npm run eval:recognition
```

The harness (`scripts/recognition-eval.mjs`, corpus in
`scripts/recognition-eval-cases.json`) sends each case through the
real provider code — same prompts, parsing, and confidence the
extension uses — and scores the outcome. Without a key it runs the
keyless preflight only (corpus URLs reachable, case shapes valid)
and exits 2. A run costs a few cents (about a dozen identify
calls); the key is never printed or stored. Results land in
`docs/recognition-eval-results.json` as the recorded evidence;
that file stays local (not committed), so re-run to regenerate it
after prompt, model, or threshold changes. Not run in CI (it needs
a live key).

## Eval set (12 cases)

Images are stable, publicly fetchable Wikimedia Commons URLs so
the API can retrieve them; page text is simulated per scenario.

Known landmarks (expect identified, high confidence):

1. `oia`: Oia blue domes, Santorini (daylight, canonical angle).
2. `eiffel`: Eiffel Tower from Trocadero (daylight).
3. `mdina`: Mdina old town, Malta (distinctive but less famous).

Ordinary scenes (expect no-place or low confidence):

4. `street`: suburban street with no signs or landmarks.
5. `food`: close-up of food on a table.
6. `pet`: dog portrait with no location cues.

Misleading captions (page text lies; expect the image to win):

7. `santorini-lie`: Santorini photo on a page titled "Mykonos
   travel guide".
8. `eiffel-lie`: Eiffel Tower photo with alt text "Las Vegas
   replica".

Conflicting metadata (expect image-first behavior):

9. `filename-lie`: photo whose filename names the wrong city.
10. `jsonld-lie`: photo on a page whose JSON-LD names Rome.

Text-only fallbacks:

11. `broken-400`: image URL that 400s on a page naming Oia.
    Scored as needs-review: the product would retry with
    downloaded bytes, so the harness records the raw API behavior
    for a human to judge.
12. `blob-no-place`: blob-URL image on a page naming no place
    (expect no-place via the text-only path).

## Scoring

Expectations model place, locality, and country separately with
constrained aliases; all three must hit. A bare country hit, or a
shared landmark name in the wrong locality, scores
confident-incorrect — never a pass.

- Successful match: correct place, confidence at least 0.6.
- Confident incorrect: wrong place at 0.6 or above (the failure
  that matters most; must stay near zero). Any confident
  identification on cases 4-6 or 12 counts here.
- Correct abstention: a true refusal on cases 4-6 and 12
  (unidentified, or below the 0.35 display floor). A hedged named
  guess at 0.35–0.6 fails: the product would show it.
- Image-first: cases 7-10 follow the pixels, not the text.
- Operational errors stay errors, even on needs-review cases.

## Thresholds (evaluated 2026-11-01, `muse-spark-1.3`)

> Stale: the scorer below changed after this run (location-aware
> matching, hedged-guess abstention, error-preserving review).
> Re-run before relying on the summary.

Evidence: `docs/recognition-eval-results.json` — 11 pass,
0 confident-incorrect, 1 needs-review (run cost $0.07).

Observed confidences:

- Correct visual matches (7 cases: landmarks plus all four
  lying-text cases): 0.90–1.00, every one in the High band.
- Wrong place guess (`street` → Perth, Australia): 0.30, refused
  by the no-place floor.
- Page-text result (`broken-400` → Oia from surrounding text):
  0.50, shown hedged as Best guess — judged acceptable on review.
- Clean abstentions (`food`, `pet`, `blob-no-place`):
  unidentified at 0.

Decision: keep the bands — 0.8 and up reads High, 0.6 and up is a
match, 0.35–0.6 shows Best guess, below 0.35 refuses with the
no-place card. The 0.6 match cut sits in a clean gap (highest
non-match 0.50, lowest match 0.90), and the 0.35 floor refuses the
only wrong guess while keeping the page-text result visible but
hedged. Wording unchanged: the Best-guess badge plus the scale
line describe model output without implying calibrated
probability. Re-run after prompt, model, or threshold changes.
