// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import './booking_grid';
import type { BookingGridElement } from './booking_grid';
import elementCss from './booking_grid.css?raw';
import { installChromeMock, uninstallChromeMock } from '../test/chrome_mock';

const mount = (): BookingGridElement => {
  const el = document.createElement('booking-grid') as BookingGridElement;
  document.body.append(el);
  return el;
};

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
    const el = mount();
    const root = el;
    el.setDestination('Oia, Greece');
    const tiles = [...root.querySelectorAll('a.tile')] as HTMLAnchorElement[];
    expect(tiles).toHaveLength(4);
    expect(tiles.map((tile) => tile.textContent?.replace('newTabSuffix', ''))).toEqual([
      'bookingLink_maps',
      'bookingLink_flights',
      'bookingLink_hotels',
      'bookingLink_airbnb',
    ]);
    expect(tiles[0].href).toContain('https://www.google.com/maps/search/');
    expect(tiles[0].href).toContain(encodeURIComponent('Oia, Greece'));
    for (const tile of tiles) {
      expect(tile.target).toBe('_blank');
      expect(tile.rel).toBe('noopener');
      expect(tile.querySelector('.visually-hidden')?.textContent).toBe('newTabSuffix');
    }
  });

  it('never hides its own host', () => {
    // An empty destination renders zero children, so an :empty rule would
    // hide the host exactly when content is missing - keep the ban.
    expect(elementCss).not.toContain(':empty');
  });

  it('renders nothing without a destination', () => {
    const el = mount();
    const root = el;
    el.setDestination('');
    expect(root.querySelectorAll('a.tile')).toHaveLength(0);
    el.setDestination('Oia, Greece');
    expect(root.querySelectorAll('a.tile')).toHaveLength(4);
    el.setDestination('');
    expect(root.querySelectorAll('a.tile')).toHaveLength(0);
  });
});
