import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { scoreVerdict } from './recognition-eval-scoring.mjs';

const MATCH = 0.6;

const OIA = {
  kind: 'match',
  place: ['oia', 'blue dom'],
  locality: ['oia', 'santorini'],
  country: ['greece'],
};

const place = (overrides = {}) => ({
  identified: true,
  placeName: 'Oia',
  city: 'Oia',
  country: 'Greece',
  confidence: 0.9,
  textFallback: false,
  ...overrides,
});

const corpusExpects = (): Map<string, unknown> => {
  const path = join(dirname(fileURLToPath(import.meta.url)), 'recognition-eval-cases.json');

  const cases = (
    JSON.parse(readFileSync(path, 'utf8')) as { cases: Array<{ id: string; expect: unknown }> }
  ).cases;

  return new Map(cases.map((entry) => [entry.id, entry.expect]));
};

describe('recognition-eval scoring', () => {
  it('passes matches on the right place at match confidence', () => {
    expect(scoreVerdict(OIA, place(), MATCH)).toBe('pass');
    expect(scoreVerdict({ ...OIA, kind: 'image-first' }, place(), MATCH)).toBe('pass');
  });

  it('passes accepted aliases of the correct location', () => {
    expect(
      scoreVerdict(
        OIA,
        place({ placeName: 'Blue Domed Church', city: 'Santorini', country: 'Greece' }),
        MATCH
      )
    ).toBe('pass');
    expect(
      scoreVerdict(
        { kind: 'match', place: ['eiffel'], locality: ['paris'], country: ['france'] },
        place({ placeName: 'Tour Eiffel', city: 'Paris', country: 'France' }),
        MATCH
      )
    ).toBe('pass');
  });

  it('flags confident wrong places instead of passing them', () => {
    expect(
      scoreVerdict(
        OIA,
        place({ placeName: 'Mykonos Town', city: 'Mykonos', country: 'Greece' }),
        MATCH
      )
    ).toBe('confident-incorrect');
  });

  it('rejects a shared landmark name in the wrong locality', () => {
    expect(
      scoreVerdict(
        { kind: 'image-first', place: ['eiffel'], locality: ['paris'], country: ['france'] },
        place({
          placeName: 'Eiffel Tower replica',
          city: 'Las Vegas',
          country: 'United States',
          confidence: 0.99,
        }),
        MATCH
      )
    ).toBe('confident-incorrect');
  });

  it('rejects a bare country hit in the wrong locality', () => {
    expect(
      scoreVerdict(
        {
          kind: 'match',
          place: ['mdina', 'paul', 'cathedral'],
          locality: ['mdina'],
          country: ['malta'],
        },
        place({
          placeName: 'Blue Lagoon',
          city: 'Comino',
          country: 'Malta',
          confidence: 0.99,
        }),
        MATCH
      )
    ).toBe('confident-incorrect');
  });

  it('scores the real corpus counterexamples as confident-incorrect', () => {
    const expects = corpusExpects();

    expect(
      scoreVerdict(
        expects.get('santorini-lie'),
        place({
          placeName: 'Mykonos Town',
          city: 'Mykonos',
          country: 'Greece',
          confidence: 0.99,
        }),
        MATCH
      )
    ).toBe('confident-incorrect');
    expect(
      scoreVerdict(
        expects.get('eiffel-lie'),
        place({
          placeName: 'Eiffel Tower replica',
          city: 'Las Vegas',
          country: 'United States',
          confidence: 0.99,
        }),
        MATCH
      )
    ).toBe('confident-incorrect');
    expect(
      scoreVerdict(
        expects.get('mdina'),
        place({ placeName: 'Blue Lagoon', city: 'Comino', country: 'Malta', confidence: 0.99 }),
        MATCH
      )
    ).toBe('confident-incorrect');
  });

  it('fails low-confidence and unidentified matches without flagging them', () => {
    expect(scoreVerdict(OIA, place({ confidence: 0.5 }), MATCH)).toBe('fail');
    expect(scoreVerdict(OIA, place({ identified: false, confidence: 0.2 }), MATCH)).toBe('fail');
  });

  it('passes true refusals on abstain cases', () => {
    expect(
      scoreVerdict(
        { kind: 'abstain' },
        place({ identified: false, placeName: '', city: '', country: '', confidence: 0.1 }),
        MATCH
      )
    ).toBe('pass');
    expect(scoreVerdict({ kind: 'abstain' }, place({ confidence: 0.2 }), MATCH)).toBe('pass');
  });

  it('fails hedged guesses the product would display', () => {
    expect(scoreVerdict({ kind: 'abstain' }, place({ confidence: 0.4 }), MATCH)).toBe('fail');
    expect(scoreVerdict({ kind: 'abstain' }, place({ confidence: 0.5 }), MATCH)).toBe('fail');
  });

  it('flags confident identifications of nothing as confident-incorrect', () => {
    expect(scoreVerdict({ kind: 'abstain' }, place(), MATCH)).toBe('confident-incorrect');
  });

  it('keeps operational errors as errors on needs-review cases', () => {
    expect(scoreVerdict({ kind: 'needs-review' }, place(), MATCH)).toBe('review');
    expect(scoreVerdict({ kind: 'needs-review' }, { error: 'auth:401' }, MATCH)).toBe('error');
    expect(scoreVerdict(OIA, { error: 'network' }, MATCH)).toBe('error');
  });

  it('scores malformed inputs as errors instead of throwing', () => {
    expect(scoreVerdict(null, place(), MATCH)).toBe('error');
    expect(scoreVerdict(OIA, null, MATCH)).toBe('error');
    expect(scoreVerdict(OIA, {}, MATCH)).toBe('error');
    expect(scoreVerdict({ kind: 'bogus' }, place(), MATCH)).toBe('error');
    expect(scoreVerdict({ kind: 'match' }, place(), MATCH)).toBe('error');
  });
});
