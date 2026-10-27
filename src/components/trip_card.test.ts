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
    const buttons = [...root.querySelectorAll('.disagree-buttons button')];
    expect(buttons).toHaveLength(1);
    (buttons[0] as HTMLButtonElement).click();
    expect(seen).toEqual(['reanalyze']);
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

  it('renders intent chips that emit one-shot alternates events', () => {
    const { el, root } = mount();
    el.setCard({ view: 'result', place: PLACE, lowConfidence: false, pinned: false });
    const chips = root.querySelectorAll('.chips-row .chip');
    expect(chips).toHaveLength(3);
    expect(chips[0]?.textContent).toBe('alternatesCheaper');
    expect(chips[0]?.hasAttribute('aria-pressed')).toBe(false);
    const seen: unknown[] = [];
    el.addEventListener('trip-alternates', (event) => seen.push((event as CustomEvent).detail));
    (chips[1] as HTMLButtonElement).click();
    expect(seen).toEqual([{ intent: 'quieter' }]);
  });

  it('marks the pressed chip aria-disabled with skeleton cards while loading', () => {
    const { el, root } = mount();
    el.setCard({
      view: 'result',
      place: PLACE,
      lowConfidence: false,
      pinned: false,
      alternates: { state: 'loading', intent: 'cheaper' },
    });
    const chips = root.querySelectorAll('.chips-row .chip');
    expect(chips[0]?.getAttribute('aria-disabled')).toBe('true');
    expect(chips[1]?.hasAttribute('aria-disabled')).toBe(false);
    const seen: unknown[] = [];
    el.addEventListener('trip-alternates', (event) => seen.push((event as CustomEvent).detail));
    (chips[0] as HTMLButtonElement).click();
    expect(seen).toEqual([]);
    const skeletons = root.querySelector('.alternates-skeletons');
    expect(skeletons?.getAttribute('aria-hidden')).toBe('true');
    expect(skeletons?.querySelectorAll('.skeleton-block')).toHaveLength(3);
    expect(root.querySelector('.alternates')?.getAttribute('aria-busy')).toBe('true');
  });

  it('renders alternate cards with instead actions', () => {
    const { el, root } = mount();
    el.setCard({
      view: 'result',
      place: PLACE,
      lowConfidence: false,
      pinned: false,
      alternates: {
        state: 'ready',
        intent: 'cheaper',
        cards: [{ name: 'Fira, Greece', why: 'Same caldera, lower prices.', bestMonth: 'May' }],
      },
    });
    expect(root.querySelector('.alternates-skeletons')).toBeNull();
    expect(root.querySelector('.alternate-name')?.textContent).toBe('Fira, Greece');
    expect(root.querySelector('.alternate-why')?.textContent).toBe('Same caldera, lower prices.');
    expect(root.querySelector('.alternate-month')?.textContent).toBe('alternatesBestMonth');
    const seen: unknown[] = [];
    el.addEventListener('trip-plan-instead', (event) => seen.push((event as CustomEvent).detail));
    (root.querySelector('.alternate-card button') as HTMLButtonElement).click();
    expect(seen).toEqual([{ index: 0 }]);
  });

  it('renders the compare picker only with options', () => {
    const { el, root } = mount();
    el.setCard({ view: 'result', place: PLACE, lowConfidence: false, pinned: false });
    expect(root.querySelector('.compare-row')).toBeNull();
    el.setCard({
      view: 'result',
      place: PLACE,
      lowConfidence: false,
      pinned: false,
      compareOptions: [{ value: 'Fira|||Greece', label: 'Fira, Greece' }],
    });
    const row = root.querySelector('.compare-row');
    expect(row?.querySelector('label')?.textContent).toContain('compareLabel');
    expect(row?.querySelector('.compare-go')?.textContent).toBe('compareGo');
    const seen: unknown[] = [];
    el.addEventListener('trip-compare', (event) => seen.push((event as CustomEvent).detail));
    (row?.querySelector('.compare-go') as HTMLButtonElement).click();
    expect(seen).toEqual([{ value: 'Fira|||Greece' }]);
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

  it('renders the byte-fetch retry alongside the plain retry', () => {
    const { el, root } = mount();
    const seen: string[] = [];
    el.addEventListener('trip-fetch-retry', () => seen.push('fetch'));
    el.addEventListener('trip-retry', () => seen.push('plain'));
    el.setCard({ view: 'error', title: 'T', body: 'B', showRetry: true, showFetchRetry: true });
    const buttons = root.querySelectorAll('button');
    expect(buttons).toHaveLength(2);
    expect(buttons[1]?.textContent).toBe('fetchRetryButton');
    (buttons[1] as HTMLButtonElement).click();
    expect(buttons[1]?.textContent).toBe('fetchRetryLoading');
    expect(seen).toEqual(['fetch']);
    (buttons[1] as HTMLButtonElement).click();
    expect(seen).toEqual(['fetch']);
  });

  it('labels on-device results and offers the on-device escape hatch', () => {
    const { el, root } = mount();
    el.setCard({ view: 'result', place: PLACE, lowConfidence: false, pinned: false });
    expect(root.querySelector('.nano-badge')).toBeNull();
    el.setCard({ view: 'result', place: PLACE, lowConfidence: false, pinned: false, onDevice: true });
    expect(root.querySelector('.nano-badge')?.textContent).toBe('nanoBadge');
    let nanos = 0;
    el.addEventListener('trip-nano', () => {
      nanos += 1;
    });
    el.setCard({ view: 'error', title: 'T', body: 'B', showRetry: true, showNanoInstead: true });
    const buttons = root.querySelectorAll('button');
    expect(buttons).toHaveLength(2);
    expect(buttons[1]?.textContent).toBe('nanoTryInstead');
    (buttons[1] as HTMLButtonElement).click();
    expect(nanos).toBe(1);
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

  it('fires retry once with a loading state', () => {
    const { el, root } = mount();
    el.setCard({ view: 'error', title: 'Fail', body: 'Why', showRetry: true });
    const retry = root.querySelector('.primary') as HTMLButtonElement;
    const fired = vi.fn();
    el.addEventListener('trip-retry', fired);
    retry.click();
    retry.click();
    expect(fired).toHaveBeenCalledTimes(1);
    expect(retry.getAttribute('aria-disabled')).toBe('true');
    expect(retry.textContent).toBe('retryingButton');
  });

  it('fires look-again once with a loading state', () => {
    const { el, root } = mount();
    el.setCard({ view: 'no-place', showLookAgain: true, fallback: null });
    const lookAgain = root.querySelector('.primary') as HTMLButtonElement;
    const fired = vi.fn();
    el.addEventListener('trip-look-again', fired);
    lookAgain.click();
    lookAgain.click();
    expect(fired).toHaveBeenCalledTimes(1);
    expect(lookAgain.getAttribute('aria-disabled')).toBe('true');
    expect(lookAgain.textContent).toBe('lookingAgainButton');
  });
});
