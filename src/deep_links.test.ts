import { describe, expect, it } from 'vitest';
import {
  MAX_DESTINATION_CHARS,
  UNVERIFIED_PORTALS_ENABLED,
  buildDestination,
  buildLinks,
  mapsDirUrl,
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

describe('mapsDirUrl', () => {
  it('routes first to last with encoded-pipe waypoints', () => {
    expect(mapsDirUrl(['Oia', 'Fira', 'Imerovigli'])).toBe(
      'https://www.google.com/maps/dir/?api=1&origin=Oia&destination=Imerovigli&waypoints=Fira',
    );
  });

  it('omits the waypoints param for direct routes and rejects single stops', () => {
    expect(mapsDirUrl(['Oia', 'Fira'])).toBe(
      'https://www.google.com/maps/dir/?api=1&origin=Oia&destination=Fira',
    );
    expect(mapsDirUrl(['Oia'])).toBeNull();
    expect(mapsDirUrl([])).toBeNull();
  });

  it('strips pipes, controls, and newlines before encoding', () => {
    const url = mapsDirUrl(['Oi|a\nFira', 'X', 'Y']);
    expect(url).toContain('origin=Oi');
    expect(url).not.toContain('|');
    expect(url).not.toContain('%0A');
    // A literal pipe in a place name cannot forge an extra waypoint.
    const forged = mapsDirUrl(['A', 'B|C', 'D']);
    expect(forged?.split('%7C')).toHaveLength(1);
  });

  it('caps waypoints at nine and the URL at 2048 chars', () => {
    const stops = ['Start', ...Array.from({ length: 20 }, (_, i) => `Stop ${i}`), 'End'];
    const url = mapsDirUrl(stops);
    expect(url?.split('%7C')).toHaveLength(9);
    expect(url).toContain('destination=End');
    const long = ['Start', ...Array.from({ length: 11 }, (_, i) => `L${'o'.repeat(110)}${i}`), 'End'];
    const capped = mapsDirUrl(long);
    expect(capped && capped.length <= 2048).toBe(true);
    expect(capped).toContain('origin=Start');
    expect(capped).toContain('destination=End');
  });
});
