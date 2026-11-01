// Pure verdict logic for the recognition eval. Kept side-effect free so the
// unit suite covers it; the harness imports it. Never throws: malformed
// outcomes score as errors instead of killing the run.
//
// Match expectations model place identity, locality, and country
// separately: { kind, place: [...], locality: [...], country: [...] }.
// A bare country hit (or a shared landmark name in the wrong locality)
// must not establish correctness, so all three alias groups must hit.
export const scoreVerdict = (expect, outcome, matchConfidence, displayConfidence = 0.35) => {
  if (!expect || typeof expect !== 'object') return 'error';
  if (!outcome || typeof outcome !== 'object') return 'error';
  if (typeof outcome.error === 'string') return 'error';
  if (expect.kind === 'needs-review') return 'review';

  const { identified, confidence } = outcome;

  if (typeof identified !== 'boolean' || typeof confidence !== 'number') return 'error';

  if (expect.kind === 'abstain') {
    // The product renders named guesses from the display floor up, so only
    // a true refusal (or a sub-floor mumble) counts as a correct abstention.
    if (!identified || confidence < displayConfidence) return 'pass';
    if (confidence >= matchConfidence) return 'confident-incorrect';
    return 'fail';
  }

  if (expect.kind !== 'match' && expect.kind !== 'image-first') return 'error';

  const placeAliases = Array.isArray(expect.place) ? expect.place : null;
  const localityAliases = Array.isArray(expect.locality) ? expect.locality : null;
  const countryAliases = Array.isArray(expect.country) ? expect.country : null;

  if (!placeAliases || !localityAliases || !countryAliases) return 'error';

  const nameHaystack = `${outcome.placeName ?? ''} ${outcome.city ?? ''}`.toLowerCase();
  const countryHaystack = `${outcome.country ?? ''}`.toLowerCase();

  const hit = (aliases, haystack) =>
    aliases.some((alias) => {
      const token = String(alias).toLowerCase().trim();

      return token !== '' && haystack.includes(token);
    });

  const hitAll =
    hit(placeAliases, nameHaystack) &&
    hit(localityAliases, nameHaystack) &&
    hit(countryAliases, countryHaystack);

  if (identified && confidence >= matchConfidence && hitAll) return 'pass';
  if (identified && confidence >= matchConfidence) return 'confident-incorrect';
  return 'fail';
};
