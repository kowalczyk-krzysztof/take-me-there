import { describe, expect, it } from 'vitest';
import { scoreVerdict } from './recognition-eval-scoring.mjs';

const MATCH = 0.6;

const place = (overrides = {}) => ({
  identified: true,
  placeName: 'Oia',
  city: 'Oia',
  country: 'Greece',
  confidence: 0.9,
  textFallback: false,
  ...overrides,
});

describe('recognition-eval scoring', () => {
  it('passes matches on the right place at match confidence', () => {
    expect(scoreVerdict({ kind: 'match', tokens: ['oia', 'santorini'] }, place(), MATCH)).toBe(
      'pass'
    );
    expect(
      scoreVerdict({ kind: 'image-first', tokens: ['oia', 'santorini'] }, place(), MATCH)
    ).toBe('pass');
  });

  it('flags confident wrong places instead of passing them', () => {
    expect(
      scoreVerdict(
        { kind: 'match', tokens: ['oia', 'santorini'] },
        place({ placeName: 'Mykonos Town', city: 'Mykonos', country: 'Greece' }),
        MATCH
      )
    ).toBe('confident-incorrect');
  });

  it('fails low-confidence and unidentified matches without flagging them', () => {
    expect(
      scoreVerdict({ kind: 'match', tokens: ['oia'] }, place({ confidence: 0.5 }), MATCH)
    ).toBe('fail');
    expect(
      scoreVerdict(
        { kind: 'match', tokens: ['oia'] },
        place({ identified: false, confidence: 0.2 }),
        MATCH
      )
    ).toBe('fail');
  });

  it('passes abstentions on unidentified or low-confidence outcomes', () => {
    expect(
      scoreVerdict(
        { kind: 'abstain' },
        place({ identified: false, placeName: '', city: '', country: '', confidence: 0.1 }),
        MATCH
      )
    ).toBe('pass');
    expect(scoreVerdict({ kind: 'abstain' }, place({ confidence: 0.4 }), MATCH)).toBe('pass');
  });

  it('flags confident identifications of nothing as confident-incorrect', () => {
    expect(scoreVerdict({ kind: 'abstain' }, place(), MATCH)).toBe('confident-incorrect');
  });

  it('passes needs-review and error outcomes through without throwing', () => {
    expect(scoreVerdict({ kind: 'needs-review' }, place(), MATCH)).toBe('review');
    expect(scoreVerdict({ kind: 'match', tokens: ['oia'] }, { error: 'network' }, MATCH)).toBe(
      'error'
    );
  });

  it('scores malformed inputs as errors instead of throwing', () => {
    expect(scoreVerdict(null, place(), MATCH)).toBe('error');
    expect(scoreVerdict({ kind: 'match', tokens: ['oia'] }, null, MATCH)).toBe('error');
    expect(scoreVerdict({ kind: 'match', tokens: ['oia'] }, {}, MATCH)).toBe('error');
    expect(scoreVerdict({ kind: 'bogus' }, place(), MATCH)).toBe('error');
    expect(scoreVerdict({ kind: 'match' }, place(), MATCH)).toBe('confident-incorrect');
  });
});
