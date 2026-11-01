# Recognition evaluation

Small repeatable set for judging identification quality and the
confidence language. Run it manually with a real key: right-click
each eval image, record identified/confidence/correct, and score the
table below. No harness script exists yet; the set is small enough
to run by hand in a few minutes.

## Eval set (12 images)

Known landmarks (expect identified, high confidence):

1. Oia blue domes, Santorini (daylight, canonical angle).
2. Eiffel Tower from Trocadero (daylight).
3. A distinctive but less famous old town (for example Mdina, Malta).

Ordinary scenes (expect no-place or low confidence):

4. A generic suburban street with no signs.
5. A close-up of food on a table.
6. A pet portrait.

Misleading captions (page text lies; expect the image to win):

7. Santorini photo on a page titled "Mykonos travel guide".
8. Eiffel Tower photo with alt text "Las Vegas replica".

Conflicting metadata (expect image-first behavior):

9. Photo whose filename names the wrong city.
10. Photo on a page whose JSON-LD names a different place.

Text-only fallbacks (broken image address; expect page-text result):

11. Image URL that 400s on a page naming a specific place.
12. Blob-URL image on a page naming no place (expect no-place).

## Scoring

- Successful match: correct place, confidence at least 0.6.
- Confident incorrect: wrong place at 0.6 or above (the failure
  that matters most; must stay near zero).
- Correct abstention: no-place on cases 4-6 and 12.
- Image-first: cases 7-10 follow the pixels, not the text.

## Thresholds (unevaluated)

Current bands are engineering judgment, not eval-backed: 0.8 and up
reads High, 0.6 and up is a match, below 0.6 shows Best guess, and
below 0.35 refuses with the no-place card. Revisit this section with
scores from the set above before changing the bands or the wording.
