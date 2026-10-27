// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import './trip_card';
import type { TripCardElement } from './trip_card';
import type { PlaceResult } from '../types';
import { installChromeMock, uninstallChromeMock } from '../test/chrome_mock';

const mount = (): { el: TripCardElement; root: ShadowRoot } => {
  const el = document.createElement('trip-card') as TripCardElement;
  document.body.append(el);
  return { el, root: el.shadowRoot as ShadowRoot };
};

const PLACE: PlaceResult = {
  identified: true,
  placeName: 'Oia',
  city: 'Oia',
  country: 'Greece',
  confidence: 0.9,
  oneLiner: 'Blue domes.',
};

beforeEach(() => {
  installChromeMock();
  document.body.innerHTML = '';
});

afterEach(() => {
  document.body.innerHTML = '';
  uninstallChromeMock();
});

describe('trip-card', () => {
  it('renders idle hints', () => {
    const { root } = mount();
    (root.host as TripCardElement).setCard({ view: 'idle', hint: 'hint', shortcut: 'keys' });
    expect(root.querySelector('.hint')?.textContent).toBe('hint');
    expect(root.querySelector('.shortcut')?.textContent).toBe('keys');
  });

  it('renders an aria-hidden skeleton while loading', () => {
    const { root } = mount();
    (root.host as TripCardElement).setCard({ view: 'loading' });
    const skeleton = root.querySelector('.skeleton');
    expect(skeleton?.getAttribute('aria-hidden')).toBe('true');
    expect(skeleton?.querySelectorAll('.skeleton-block').length).toBeGreaterThan(0);
    expect(root.querySelector('.cosmetic')?.textContent).toBe('loadingReading');
  });

  it('renders results with badges and disagree actions', () => {
    const { el, root } = mount();
    el.setCard({ view: 'result', place: PLACE, lowConfidence: false, pinned: false });
    expect(root.querySelector('h2')?.textContent).toBe('Oia');
    expect(root.querySelector('.subtitle')?.textContent).toBe('Oia, Greece');
    expect(root.querySelector('.badge')).toBeNull();
    el.setCard({ view: 'result', place: { ...PLACE, confidence: 0.2 }, lowConfidence: true, pinned: false });
    expect(root.querySelector('.badge')?.textContent).toBe('bestGuessBadge');
    expect(root.querySelector('summary')?.textContent).toBe('notThisPlace');

    const seen: string[] = [];
    el.addEventListener('trip-reanalyze', () => seen.push('reanalyze'));
    el.addEventListener('trip-edit-destination', () => seen.push('edit'));
    const buttons = [...root.querySelectorAll('.disagree-buttons button')];
    (buttons[0] as HTMLButtonElement).click();
    (buttons[1] as HTMLButtonElement).click();
    expect(seen).toEqual(['reanalyze', 'edit']);
  });

  it('omits empty result fields', () => {
    const { el, root } = mount();
    el.setCard({
      view: 'result',
      place: { ...PLACE, city: '', country: '', oneLiner: '' },
      lowConfidence: false,
      pinned: false,
    });
    expect(root.querySelector('.subtitle')).toBeNull();
    expect(root.querySelector('.oneliner')).toBeNull();
  });

  it('renders no-place cards with escapes', () => {
    const { el, root } = mount();
    let looks = 0;
    el.addEventListener('trip-look-again', () => {
      looks += 1;
    });
    el.setCard({
      view: 'no-place',
      showLookAgain: true,
      fallback: { label: 'Santorini', href: 'https://www.google.com/maps/search/?api=1&query=x' },
    });
    expect(root.querySelector('h2')?.textContent).toBe('noPlaceTitle');
    const button = root.querySelector('button.primary') as HTMLButtonElement;
    expect(button.textContent).toBe('lookAgainButton');
    button.click();
    expect(looks).toBe(1);
    const link = root.querySelector('.fallback a') as HTMLAnchorElement;
    expect(link.textContent).toContain('Santorini');
    expect(link.target).toBe('_blank');

    el.setCard({ view: 'no-place', showLookAgain: false, fallback: null });
    expect(root.querySelector('button')).toBeNull();
    expect(root.querySelector('.fallback')).toBeNull();
  });

  it('renders error cards with optional retry', () => {
    const { el, root } = mount();
    let retries = 0;
    el.addEventListener('trip-retry', () => {
      retries += 1;
    });
    el.setCard({ view: 'error', title: 'T', body: 'B', showRetry: true });
    expect(root.querySelector('h2')?.textContent).toBe('T');
    (root.querySelector('button') as HTMLButtonElement).click();
    expect(retries).toBe(1);
    el.setCard({ view: 'error', title: 'T', body: 'B', showRetry: false });
    expect(root.querySelector('button')).toBeNull();
  });

  it('focuses its heading on request', () => {
    const { el, root } = mount();
    el.setCard({ view: 'result', place: PLACE, lowConfidence: false, pinned: false });
    el.focusHeading();
    expect((root.activeElement as HTMLElement)?.tagName).toBe('H2');
  });

  it('renders the pin toggle with pressed state and event', () => {
    const { el, root } = mount();
    el.setCard({ view: 'result', place: PLACE, lowConfidence: false, pinned: false });
    const pin = root.querySelector('.pin-button') as HTMLButtonElement;
    expect(pin.textContent).toBe('pinButton');
    expect(pin.getAttribute('aria-pressed')).toBe('false');
    const fired = vi.fn();
    el.addEventListener('trip-pin', fired);
    pin.click();
    expect(fired).toHaveBeenCalledTimes(1);
    el.setCard({ view: 'result', place: PLACE, lowConfidence: false, pinned: true });
    expect(root.querySelector('.pin-button')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('renders itineraries with stops, nights, links, and the Maps route', () => {
    const { el, root } = mount();
    el.setCard({
      view: 'itinerary',
      title: 'Trip plan - 2 stops',
      stops: [
        {
          name: 'Oia, Greece',
          nights: 2,
          links: [{ id: 'maps', href: 'https://maps.example/q' }],
        },
        { name: 'Fira, Greece', nights: null, links: [] },
      ],
      mapsUrl: 'https://maps.example/dir',
      mapsLabel: 'Open route in Google Maps (2 stops)',
    });
    expect(root.querySelector('h2')?.textContent).toBe('Trip plan - 2 stops');
    const entries = [...root.querySelectorAll('.stop-list li')];
    expect(entries).toHaveLength(2);
    expect(entries[0].querySelector('.stop-name')?.textContent).toBe('Oia, Greece');
    expect(entries[0].querySelector('.stop-nights')?.textContent).toBe('itineraryNights');
    expect(entries[1].querySelector('.stop-nights')).toBeNull();
    const stopLink = entries[0].querySelector('.stop-links a') as HTMLAnchorElement;
    expect(stopLink.href).toBe('https://maps.example/q');
    expect(stopLink.target).toBe('_blank');
    expect(stopLink.querySelector('.visually-hidden')?.textContent).toBe('newTabSuffix');
    const maps = root.querySelector('.maps-link') as HTMLAnchorElement;
    expect(maps.textContent).toContain('Open route in Google Maps (2 stops)');
    expect(maps.querySelector('.visually-hidden')?.textContent).toBe('newTabSuffix');
  });

  it('omits the Maps link when no route exists', () => {
    const { el, root } = mount();
    el.setCard({
      view: 'itinerary',
      title: 'Trip plan - 1 stop',
      stops: [{ name: 'Oia', nights: null, links: [] }],
      mapsUrl: null,
      mapsLabel: '',
    });
    expect(root.querySelector('.maps-link')).toBeNull();
  });
});
