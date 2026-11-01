import { describe, expect, it } from 'vitest';
import { CACHE_ENTRY_VERSION, unwrapEntry } from './result_cache';

const validEntry = () => ({
  place: {
    identified: true,
    placeName: 'Oia',
    city: 'Oia',
    country: 'Greece',
    confidence: 0.9,
    oneLiner: 'Blue domes over the caldera.',
  },
  usage: { inputTokens: 10, outputTokens: 5, searchCount: 0, flatFeesUsd: 0 },
});

const wrapped = (entry: unknown, createdAt: unknown = Date.now()) => ({
  v: CACHE_ENTRY_VERSION,
  entry,
  createdAt,
});

describe('cache entry validation', () => {
  it('accepts versioned records with timestamps', () => {
    expect(unwrapEntry(wrapped(validEntry()))?.place.placeName).toBe('Oia');
  });

  it('rejects bare entries, bad versions, and missing timestamps', () => {
    expect(unwrapEntry(validEntry())).toBeUndefined();
    expect(unwrapEntry({ v: 999, entry: validEntry(), createdAt: Date.now() })).toBeUndefined();
    expect(unwrapEntry({ v: CACHE_ENTRY_VERSION, entry: validEntry() })).toBeUndefined();
    expect(unwrapEntry(wrapped(validEntry(), 'yesterday'))).toBeUndefined();
    expect(unwrapEntry(null)).toBeUndefined();
    expect(unwrapEntry({ v: CACHE_ENTRY_VERSION })).toBeUndefined();
  });

  it('rejects unknown fields and schema violations', () => {
    const many = { ...validEntry(), sources: [] };
    expect(unwrapEntry(wrapped(many))).toBeUndefined();

    const { oneLiner: _dropped, ...shortPlace } = validEntry().place;
    void _dropped;
    const badPlace = { ...validEntry(), place: shortPlace };
    expect(unwrapEntry(wrapped(badPlace))).toBeUndefined();
  });
});
