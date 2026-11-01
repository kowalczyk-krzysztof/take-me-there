import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BookingGrid } from './booking_grid';
import { installChromeMock, uninstallChromeMock } from '../../test/chrome_mock';
import { renderSync } from '../../test/render_sync';

beforeEach(() => {
  installChromeMock();
  document.body.innerHTML = '';
});

afterEach(() => {
  document.body.innerHTML = '';
  uninstallChromeMock();
});

describe('booking-grid', () => {
  it('renders localized tiles for the verified portals', () => {
    const root = renderSync(<BookingGrid destination="Oia, Greece" />).container;

    const tiles = [...root.querySelectorAll('a.tile')] as HTMLAnchorElement[];
    expect(tiles).toHaveLength(2);
    expect(tiles.map((tile) => tile.textContent?.replace('newTabSuffix', ''))).toEqual([
      'bookingLink_maps',
      'bookingLink_hotels',
    ]);
    expect(tiles[0].href).toContain('https://www.google.com/maps/search/');
    expect(tiles[0].href).toContain(encodeURIComponent('Oia, Greece'));

    for (const tile of tiles) {
      expect(tile.target).toBe('_blank');
      expect(tile.rel).toBe('noopener noreferrer');
      expect(tile.querySelector('.visually-hidden')?.textContent).toBe('newTabSuffix');
    }
  });

  it('renders nothing without a destination', () => {
    const rendered = renderSync(<BookingGrid destination="" />);
    expect(rendered.container.querySelectorAll('a.tile')).toHaveLength(0);
    rendered.rerender(<BookingGrid destination="Oia, Greece" />);
    expect(rendered.container.querySelectorAll('a.tile')).toHaveLength(2);
    rendered.rerender(<BookingGrid destination="" />);
    expect(rendered.container.querySelectorAll('a.tile')).toHaveLength(0);
  });
});
