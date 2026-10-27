// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
    el.setCard({ view: 'result', place: PLACE, lowConfidence: false });
    expect(root.querySelector('h2')?.textContent).toBe('Oia');
    expect(root.querySelector('.subtitle')?.textContent).toBe('Oia, Greece');
    expect(root.querySelector('.badge')).toBeNull();
    el.setCard({ view: 'result', place: { ...PLACE, confidence: 0.2 }, lowConfidence: true });
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
    el.setCard({ view: 'result', place: PLACE, lowConfidence: false });
    el.focusHeading();
    expect((root.activeElement as HTMLElement)?.tagName).toBe('H2');
  });
});
