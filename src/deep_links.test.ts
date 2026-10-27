import { describe, expect, it } from 'vitest';
import {
  MAX_DESTINATION_CHARS,
  UNVERIFIED_PORTALS_ENABLED,
  buildDestination,
  buildLinks,
} from './deep_links';

describe('deep_links', () => {
  it('builds a deduped destination from place parts', () => {
    expect(buildDestination('Oia', 'Oia', 'Greece')).toBe('Oia, Greece');
    expect(buildDestination('  Eiffel Tower ', '', 'France')).toBe('Eiffel Tower, France');
    expect(buildDestination('', '', '')).toBe('');
  });

  it('percent-encodes hostile destinations', () => {
    const links = buildLinks('A&B #1 "quoted" 100%');
    const maps = links.find((link) => link.id === 'maps');
    expect(maps?.href).toBe(
      `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent('A&B #1 "quoted" 100%')}`,
    );
    for (const link of links) {
      expect(link.href).not.toContain('"');
      expect(link.href).not.toContain('#1');
    }
  });

  it('strips path-breaking characters for the Airbnb segment', () => {
    const links = buildLinks('a/b?c#d e');
    const airbnb = links.find((link) => link.id === 'airbnb');
    expect(airbnb?.href).toBe('https://www.airbnb.com/s/abcd%20e/homes');
  });

  it('caps destinations at the character limit', () => {
    const links = buildLinks(`${'sight '.repeat(50)}x&y`);
    const maps = links.find((link) => link.id === 'maps');
    const query = new URL(maps?.href ?? '').searchParams.get('query') ?? '';
    expect(query.length).toBeLessThanOrEqual(MAX_DESTINATION_CHARS);
  });

  it('ships only the click-verified portals until the rest are proven', () => {
    expect(UNVERIFIED_PORTALS_ENABLED).toBe(false);
    expect(buildLinks('Oia, Greece').map((link) => link.id)).toEqual([
      'maps',
      'flights',
      'hotels',
      'airbnb',
    ]);
  });
});
