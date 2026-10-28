// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TripCard, type CardState, type TripCardCallbacks } from './trip_card';
import type { PlaceResult } from '../../types';
import { installChromeMock, uninstallChromeMock } from '../../test/chrome_mock';
import { renderSync, type Rendered } from '../../test/render_sync';

const PLACE: PlaceResult = {
  identified: true,
  placeName: 'Oia',
  city: 'Oia',
  country: 'Greece',
  confidence: 0.9,
  oneLiner: 'Blue domes.',
};

const noop = () => {};

const fullCallbacks = (overrides: Partial<TripCardCallbacks> = {}): TripCardCallbacks => ({
  onPin: noop,
  onPlanTrip: noop,
  onReanalyze: noop,
  onRetry: noop,
  onFetchRetry: noop,
  onLookAgain: noop,
  onAlternates: noop,
  onCompare: noop,
  onPinAlternate: noop,
  onPlanInstead: noop,
  ...overrides,
});

const renderCard = (card: CardState, callbacks: Partial<TripCardCallbacks> = {}): Rendered =>
  renderSync(<TripCard card={card} callbacks={fullCallbacks(callbacks)} />);

const rerenderCard = (
  rendered: Rendered,
  card: CardState,
  callbacks: Partial<TripCardCallbacks> = {},
): void => {
  rendered.rerender(<TripCard card={card} callbacks={fullCallbacks(callbacks)} />);
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
    const root = renderCard({ view: 'idle', hint: 'hint', shortcut: 'keys' }).container;
    expect(root.querySelector('.hint')?.textContent).toBe('hint');
    expect(root.querySelector('.shortcut')?.textContent).toBe('keys');
  });

  it('renders an aria-hidden skeleton while loading', () => {
    const root = renderCard({ view: 'loading' }).container;
    const skeleton = root.querySelector('.skeleton');
    expect(skeleton?.getAttribute('aria-hidden')).toBe('true');
    expect(skeleton?.querySelectorAll('.skeleton-block').length).toBeGreaterThan(0);
    expect(root.querySelector('.cosmetic')?.textContent).toBe('loadingReading');
  });

  it('renders results with badges and disagree actions', () => {
    const onReanalyze = vi.fn();
    const rendered = renderCard(
      { view: 'result', place: PLACE, lowConfidence: false, pinned: false, planState: 'ready' },
      { onReanalyze },
    );
    const root = rendered.container;
    expect(root.querySelector('h2')?.textContent).toBe('Oia');
    expect(root.querySelector('.subtitle')?.textContent).toBe('Oia, Greece');
    expect(root.querySelector('.badge')).toBeNull();
    rerenderCard(
      rendered,
      { view: 'result', place: { ...PLACE, confidence: 0.2 }, lowConfidence: true, pinned: false, planState: 'ready' },
      { onReanalyze },
    );
    expect(root.querySelector('.badge')?.textContent).toBe('bestGuessBadge');
    const disagree = root.querySelector('.disagree-row') as HTMLElement;
    expect(disagree.querySelector('span')?.textContent).toBe('notThisPlace');
    const button = disagree.querySelector('button') as HTMLButtonElement;
    expect(button.textContent).toBe('reanalyzeButton');
    button.click();
    expect(onReanalyze).toHaveBeenCalledTimes(1);
  });

  it('omits empty result fields', () => {
    const root = renderCard({
      view: 'result',
      place: { ...PLACE, city: '', country: '', oneLiner: '' },
      lowConfidence: false,
      pinned: false,
      planState: 'ready',
    }).container;
    expect(root.querySelector('.subtitle')).toBeNull();
    expect(root.querySelector('.oneliner')).toBeNull();
  });

  it('keeps the full description on the clamped oneliner', () => {
    const oneLiner = 'A very long description that the stylesheet clamps to three lines.';
    const root = renderCard({
      view: 'result',
      place: { ...PLACE, oneLiner },
      lowConfidence: false,
      pinned: false,
      planState: 'ready',
    }).container;
    const oneliner = root.querySelector('.oneliner') as HTMLElement;
    expect(oneliner.textContent).toBe(oneLiner);
    expect(oneliner.getAttribute('title')).toBe(oneLiner);
  });

  it('renders intent chips that emit one-shot alternates events', () => {
    const onAlternates = vi.fn();
    const root = renderCard(
      { view: 'result', place: PLACE, lowConfidence: false, pinned: false, planState: 'ready' },
      { onAlternates },
    ).container;
    const chips = root.querySelectorAll('.chips-row .chip');
    expect(chips).toHaveLength(3);
    expect(root.querySelector('.chips-label')?.textContent).toBe('alternatesLabel');
    expect(chips[0]?.textContent).toBe('alternatesCheaper');
    expect(chips[0]?.hasAttribute('aria-pressed')).toBe(false);
    (chips[1] as HTMLButtonElement).click();
    expect(onAlternates).toHaveBeenCalledWith('quieter');
  });

  it('marks the pressed chip aria-disabled with skeleton cards while loading', () => {
    const onAlternates = vi.fn();
    const root = renderCard(
      {
        view: 'result',
        place: PLACE,
        lowConfidence: false,
        pinned: false,
        planState: 'ready',
        alternates: { state: 'loading', intent: 'cheaper' },
      },
      { onAlternates },
    ).container;
    const chips = root.querySelectorAll('.chips-row .chip');
    expect(chips[0]?.getAttribute('aria-disabled')).toBe('true');
    expect(chips[1]?.hasAttribute('aria-disabled')).toBe(false);
    (chips[0] as HTMLButtonElement).click();
    expect(onAlternates).not.toHaveBeenCalled();
    const skeletons = root.querySelector('.alternates-skeletons');
    expect(skeletons?.getAttribute('aria-hidden')).toBe('true');
    expect(skeletons?.querySelectorAll('.skeleton-block')).toHaveLength(3);
    expect(root.querySelector('.alternates')?.getAttribute('aria-busy')).toBe('true');
  });

  it('renders alternate cards with instead actions', () => {
    const onPlanInstead = vi.fn();
    const root = renderCard(
      {
        view: 'result',
        place: PLACE,
        lowConfidence: false,
        pinned: false,
        planState: 'ready',
        alternates: {
          state: 'ready',
          intent: 'cheaper',
          cards: [{ name: 'Fira, Greece', why: 'Same caldera, lower prices.', bestMonth: 'May', pinned: false }],
        },
      },
      { onPlanInstead },
    ).container;
    expect(root.querySelector('.alternates-skeletons')).toBeNull();
    expect(root.querySelector('.alternate-name')?.textContent).toBe('Fira, Greece');
    expect(root.querySelector('.alternate-why')?.textContent).toBe('Same caldera, lower prices.');
    expect(root.querySelector('.alternate-month')?.textContent).toBe('alternatesBestMonth');
    (root.querySelector('.alternate-actions button:not(.pin-button)') as HTMLButtonElement).click();
    expect(onPlanInstead).toHaveBeenCalledWith(0);
  });

  it('pins alternate cards with a monogram tile', () => {
    const onPinAlternate = vi.fn();
    const root = renderCard(
      {
        view: 'result',
        place: PLACE,
        lowConfidence: false,
        pinned: false,
        planState: 'ready',
        alternates: {
          state: 'ready',
          intent: 'cheaper',
          cards: [
            { name: 'Fira, Greece', why: 'Same caldera, lower prices.', bestMonth: 'May', pinned: false },
            { name: 'Oia, Greece', why: 'Same island.', bestMonth: 'June', pinned: true },
          ],
        },
      },
      { onPinAlternate },
    ).container;
    const tiles = root.querySelectorAll('.alternate-card .thumb-monogram');
    expect(tiles).toHaveLength(2);
    expect(tiles[0]?.textContent).toBe('F');
    expect(tiles[0]?.getAttribute('aria-hidden')).toBe('true');
    const pins = root.querySelectorAll('.alternate-card .pin-button') as NodeListOf<HTMLButtonElement>;
    expect(pins).toHaveLength(2);
    expect(pins[0]?.getAttribute('aria-pressed')).toBe('false');
    expect(pins[1]?.getAttribute('aria-pressed')).toBe('true');
    pins[0]?.click();
    expect(onPinAlternate).toHaveBeenCalledWith(0);
  });

  it('disables the compare picker without options', () => {
    const onCompare = vi.fn();
    const rendered = renderCard(
      { view: 'result', place: PLACE, lowConfidence: false, pinned: false, planState: 'ready' },
      { onCompare },
    );
    const root = rendered.container;
    const empty = root.querySelector('.compare-row') as HTMLElement;
    expect(empty.querySelector('select')?.hasAttribute('disabled')).toBe(true);
    expect(empty.querySelector('option')?.textContent).toBe('compareEmpty');
    expect(empty.querySelector('.compare-go')?.hasAttribute('disabled')).toBe(true);
    (empty.querySelector('.compare-go') as HTMLButtonElement).click();
    expect(onCompare).not.toHaveBeenCalled();
    rerenderCard(
      rendered,
      {
        view: 'result',
        place: PLACE,
        lowConfidence: false,
        pinned: false,
        planState: 'ready',
        compareOptions: [{ value: 'Fira|||Greece', label: 'Fira, Greece' }],
      },
      { onCompare },
    );
    const row = root.querySelector('.compare-row');
    expect(row?.querySelector('label')?.textContent).toContain('compareLabel');
    expect(row?.querySelector('.compare-go')?.textContent).toBe('compareGo');
    (row?.querySelector('.compare-go') as HTMLButtonElement).click();
    expect(onCompare).toHaveBeenCalledWith('Fira|||Greece');
  });

  it('renders no-place cards with escapes', () => {
    const onLookAgain = vi.fn();
    const rendered = renderCard(
      {
        view: 'no-place',
        showLookAgain: true,
        fallback: { label: 'Santorini', href: 'https://www.google.com/maps/search/?api=1&query=x' },
      },
      { onLookAgain },
    );
    const root = rendered.container;
    expect(root.querySelector('h2')?.textContent).toBe('noPlaceTitle');
    const button = root.querySelector('button.primary') as HTMLButtonElement;
    expect(button.textContent).toBe('lookAgainButton');
    button.click();
    expect(onLookAgain).toHaveBeenCalledTimes(1);
    const link = root.querySelector('.fallback a') as HTMLAnchorElement;
    expect(link.textContent).toContain('Santorini');
    expect(link.target).toBe('_blank');

    rerenderCard(rendered, { view: 'no-place', showLookAgain: false, fallback: null }, { onLookAgain });
    expect(root.querySelector('button')).toBeNull();
    expect(root.querySelector('.fallback')).toBeNull();
  });

  it('renders error cards with optional retry', () => {
    const onRetry = vi.fn();
    const rendered = renderCard(
      { view: 'error', title: 'T', body: 'B', showRetry: true },
      { onRetry },
    );
    const root = rendered.container;
    expect(root.querySelector('h2')?.textContent).toBe('T');
    (root.querySelector('button') as HTMLButtonElement).click();
    expect(onRetry).toHaveBeenCalledTimes(1);
    rerenderCard(rendered, { view: 'error', title: 'T', body: 'B', showRetry: false }, { onRetry });
    expect(root.querySelector('button')).toBeNull();
  });

  it('renders the byte-fetch retry alongside the plain retry', () => {
    const onRetry = vi.fn();
    const onFetchRetry = vi.fn();
    const root = renderCard(
      { view: 'error', title: 'T', body: 'B', showRetry: true, showFetchRetry: true },
      { onRetry, onFetchRetry },
    ).container;
    const buttons = root.querySelectorAll('button');
    expect(buttons).toHaveLength(2);
    expect(buttons[1]?.textContent).toBe('fetchRetryButton');
    (buttons[1] as HTMLButtonElement).click();
    expect(buttons[1]?.textContent).toBe('fetchRetryLoading');
    expect(onFetchRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
    (buttons[1] as HTMLButtonElement).click();
    expect(onFetchRetry).toHaveBeenCalledTimes(1);
  });

  it('renders a focusable result heading', () => {
    const root = renderCard(
      { view: 'result', place: PLACE, lowConfidence: false, pinned: false, planState: 'ready' },
    ).container;
    const heading = root.querySelector('h2') as HTMLHeadingElement;
    heading.focus();
    expect(document.activeElement?.tagName).toBe('H2');
  });

  it('gates the guide behind the plan button', () => {
    const onPlanTrip = vi.fn();
    const rendered = renderCard(
      { view: 'result', place: PLACE, lowConfidence: false, pinned: false, planState: 'idle' },
      { onPlanTrip },
    );
    const root = rendered.container;
    const button = root.querySelector('.plan-trip-button') as HTMLButtonElement;
    expect(button.textContent).toBe('planTripButton');
    expect(button.hasAttribute('aria-disabled')).toBe(false);
    button.click();
    expect(onPlanTrip).toHaveBeenCalledTimes(1);
    rerenderCard(
      rendered,
      { view: 'result', place: PLACE, lowConfidence: false, pinned: false, planState: 'planning' },
      { onPlanTrip },
    );
    const busy = root.querySelector('.plan-trip-button') as HTMLButtonElement;
    expect(busy.textContent).toBe('planningButton');
    expect(busy.getAttribute('aria-disabled')).toBe('true');
    busy.click();
    expect(onPlanTrip).toHaveBeenCalledTimes(1);
    rerenderCard(
      rendered,
      { view: 'result', place: PLACE, lowConfidence: false, pinned: false, planState: 'ready' },
      { onPlanTrip },
    );
    expect(root.querySelector('.plan-trip-button')).toBeNull();
  });

  it('renders the pin toggle with pressed state and event', () => {
    const onPin = vi.fn();
    const rendered = renderCard(
      { view: 'result', place: PLACE, lowConfidence: false, pinned: false, planState: 'ready' },
      { onPin },
    );
    const root = rendered.container;
    const pin = root.querySelector('.pin-button') as HTMLButtonElement;
    expect(pin.textContent).toBe('pinButton');
    expect(pin.getAttribute('aria-pressed')).toBe('false');
    pin.click();
    expect(onPin).toHaveBeenCalledTimes(1);
    rerenderCard(
      rendered,
      { view: 'result', place: PLACE, lowConfidence: false, pinned: true, planState: 'ready' },
      { onPin },
    );
    expect(root.querySelector('.pin-button')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('renders itineraries with stops, nights, links, and the Maps route', () => {
    const root = renderCard({
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
    }).container;
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
    const root = renderCard({
      view: 'itinerary',
      title: 'Trip plan - 1 stop',
      stops: [{ name: 'Oia', nights: null, links: [] }],
      mapsUrl: null,
      mapsLabel: '',
    }).container;
    expect(root.querySelector('.maps-link')).toBeNull();
  });

  it('fires retry once with a loading state', () => {
    const onRetry = vi.fn();
    const root = renderCard(
      { view: 'error', title: 'Fail', body: 'Why', showRetry: true },
      { onRetry },
    ).container;
    const retry = root.querySelector('.primary') as HTMLButtonElement;
    retry.click();
    retry.click();
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(retry.getAttribute('aria-disabled')).toBe('true');
    expect(retry.textContent).toBe('retryingButton');
  });

  it('fires look-again once with a loading state', () => {
    const onLookAgain = vi.fn();
    const root = renderCard(
      { view: 'no-place', showLookAgain: true, fallback: null },
      { onLookAgain },
    ).container;
    const lookAgain = root.querySelector('.primary') as HTMLButtonElement;
    lookAgain.click();
    lookAgain.click();
    expect(onLookAgain).toHaveBeenCalledTimes(1);
    expect(lookAgain.getAttribute('aria-disabled')).toBe('true');
    expect(lookAgain.textContent).toBe('lookingAgainButton');
  });
});
