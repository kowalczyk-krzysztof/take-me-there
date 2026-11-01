// Pure verdict logic for the recognition eval. Kept side-effect free so the
// unit suite covers it; the harness imports it. Never throws: malformed
// outcomes score as errors instead of killing the run.
export const scoreVerdict = (expect, outcome, matchConfidence) => {
  if (!expect || typeof expect !== 'object') return 'error';
  if (!outcome || typeof outcome !== 'object') return 'error';
  if (expect.kind === 'needs-review') return 'review';
  if (typeof outcome.error === 'string') return 'error';

  const { identified, confidence } = outcome;

  if (typeof identified !== 'boolean' || typeof confidence !== 'number') return 'error';

  if (expect.kind === 'abstain') {
    if (!identified || confidence < matchConfidence) return 'pass';
    return 'confident-incorrect';
  }

  if (expect.kind !== 'match' && expect.kind !== 'image-first') return 'error';

  const haystack =
    `${outcome.placeName ?? ''} ${outcome.city ?? ''} ${outcome.country ?? ''}`.toLowerCase();
  const hit = (Array.isArray(expect.tokens) ? expect.tokens : []).some((token) =>
    haystack.includes(String(token).toLowerCase())
  );

  if (identified && confidence >= matchConfidence && hit) return 'pass';
  if (identified && confidence >= matchConfidence) return 'confident-incorrect';
  return 'fail';
};
