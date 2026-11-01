import { describe, expect, it } from 'vitest';
import {
  MAX_DESTINATION_CHARS,
  UNVERIFIED_PORTALS_ENABLED,
  buildDestination,
  buildLinks,
  capDestination,
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
      `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent('A&B #1 "quoted" 100%')}`
    );

    for (const link of links) {
      expect(link.href).not.toContain('"');
      expect(link.href).not.toContain('#1');
    }
  });

  it('survives hostile destinations without throwing or smuggling schemes', () => {
    const hostile = [
      `${'x'.repeat(119)}\ud800`,
      '\udc00lead trail\ud800',
      'a\0b',
      '100% %zz %2',
      'javascript:alert(1)',
      '<img src=x onerror=alert(1)>',
      '\u202Ereversed',
      'e\u0301combining',
      'Oia\nhttps://evil.example',
      'x'.repeat(10000),
    ];

    for (const destination of hostile) {
      const capped = capDestination(destination);
      expect(() => encodeURIComponent(capped)).not.toThrow();

      for (const link of buildLinks(destination)) {
        expect(() => new URL(link.href)).not.toThrow();
        expect(link.href).not.toMatch(/^javascript:/i);
      }
    }
  });

  it('survives astral names cut at the character limit', () => {
    const links = buildLinks(`${'x'.repeat(MAX_DESTINATION_CHARS - 1)}😀tail`);

    for (const link of links) {
      expect(() => new URL(link.href)).not.toThrow();
    }
  });

  it('caps destinations at the character limit', () => {
    const links = buildLinks(`${'sight '.repeat(50)}x&y`);

    const maps = links.find((link) => link.id === 'maps');

    const query = new URL(maps?.href ?? '').searchParams.get('query') ?? '';
    expect(query.length).toBeLessThanOrEqual(MAX_DESTINATION_CHARS);
  });

  it('ships only the click-verified portals until the rest are proven', () => {
    expect(UNVERIFIED_PORTALS_ENABLED).toBe(false);
    expect(buildLinks('Oia, Greece').map((link) => link.id)).toEqual(['maps', 'hotels']);
  });
});
