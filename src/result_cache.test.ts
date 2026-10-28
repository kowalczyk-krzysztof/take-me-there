import { describe, expect, it } from 'vitest';
import { CACHE_ENTRY_VERSION, unwrapEntry } from './result_cache';
import { GUIDE_MAX_TEXT_CHARS } from './types';

const validEntry = () => ({
  place: {
    identified: true,
    placeName: 'Oia',
    city: 'Oia',
    country: 'Greece',
    confidence: 0.9,
    oneLiner: 'Blue domes over the caldera.',
  },
  guide: '# Oia',
  sources: [],
  usage: { inputTokens: 10, outputTokens: 5, searchCount: 0, flatFeesUsd: 0 },
  searchedWeb: false,
});

describe('cache entry validation', () => {
  it('accepts versioned and bare entries', () => {
    expect(unwrapEntry({ v: CACHE_ENTRY_VERSION, entry: validEntry() })?.guide).toBe('# Oia');
    expect(unwrapEntry(validEntry())?.place.placeName).toBe('Oia');
  });

  it('rejects oversized guides, excess citations, and schema violations', () => {
    const big = { ...validEntry(), guide: 'x'.repeat(GUIDE_MAX_TEXT_CHARS + 1) };
    expect(unwrapEntry({ v: CACHE_ENTRY_VERSION, entry: big })).toBeUndefined();

    const many = {
      ...validEntry(),
      sources: Array.from({ length: 33 }, (_, index) => ({
        title: `T${index}`,
        url: `https://example.com/${index}`,
      })),
    };
    expect(unwrapEntry({ v: CACHE_ENTRY_VERSION, entry: many })).toBeUndefined();

    const { oneLiner: _dropped, ...shortPlace } = validEntry().place;
    void _dropped;
    const badPlace = { ...validEntry(), place: shortPlace };
    expect(unwrapEntry({ v: CACHE_ENTRY_VERSION, entry: badPlace })).toBeUndefined();

    expect(unwrapEntry({ v: 999, entry: validEntry() })).toBeUndefined();
    expect(unwrapEntry(null)).toBeUndefined();
    expect(unwrapEntry({ v: CACHE_ENTRY_VERSION })).toBeUndefined();
  });
});
