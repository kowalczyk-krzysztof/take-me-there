import { clickEl, focusEl } from '../../test/helpers';
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

const CONF = { line: 'Confidence: High (0.90).', showScale: true };

const noop = () => {};

const fullCallbacks = (overrides: Partial<TripCardCallbacks> = {}): TripCardCallbacks => ({
  onReanalyze: noop,
  onRetry: noop,
  onLookAgain: noop,
  onAlternates: noop,
  onCancelAlternates: noop,
  onCancelLoading: noop,
  onDismissError: noop,
  ...overrides,
});

const renderCard = (card: CardState, callbacks: Partial<TripCardCallbacks> = {}): Rendered =>
  renderSync(<TripCard card={card} callbacks={fullCallbacks(callbacks)} />);

const rerenderCard = (
  rendered: Rendered,
  card: CardState,
  callbacks: Partial<TripCardCallbacks> = {}
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
    const root = renderCard({ view: 'idle', hint: 'hint' }).container;
    expect(root.querySelector('.hint')?.textContent).toBe('hint');
    expect(root.querySelector('.scanHint')?.textContent).toBe('panelScanHint');
  });

  it('renders an aria-hidden skeleton while loading', () => {
    const root = renderCard({ view: 'loading', phase: 'identifying' }).container;

    const skeleton = root.querySelector('.skeleton');
    expect(skeleton?.getAttribute('aria-hidden')).toBe('true');
    expect(skeleton?.querySelectorAll('.skeleton-block').length).toBeGreaterThan(0);
    expect(root.querySelector('.cosmetic')?.textContent).toBe('loadingPhaseIdentifying');
  });

  it('shows the collecting phase with a working cancel', () => {
    const onCancel = vi.fn();

    const root = renderCard(
      { view: 'loading', phase: 'collecting' },
      { onCancelLoading: onCancel }
    ).container;
    expect(root.querySelector('.cosmetic')?.textContent).toBe('loadingPhaseCollecting');

    const cancel = root.querySelector('.cancel-button') as HTMLButtonElement;
    expect(cancel?.textContent).toBe('cancelButton');
    expect(cancel.closest('[aria-hidden="true"]')).toBeNull();
    clickEl(cancel);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('orders name, location, confidence, and source before actions', () => {
    const root = renderCard({
      view: 'result',
      place: PLACE,
      lowConfidence: false,
      canReanalyze: true,
      confidence: { line: 'Confidence: High (0.90).', showScale: true },
      sourceHost: 'example.com',
    }).container;

    const order = [...(root.querySelector('.root')?.children ?? [])].map((el) =>
      el.tagName === 'H2'
        ? 'name'
        : el.tagName === 'SECTION'
          ? 'secondary'
          : (el as HTMLElement).className || el.tagName
    );
    expect(order.indexOf('name')).toBe(0);
    expect(order).toContain('secondary');

    const texts = [...(root.querySelectorAll('.root > p') ?? [])].map((el) => el.textContent);
    expect(texts[0]).toBe('Oia, Greece');
    expect(texts[1]).toBe('Confidence: High (0.90).');
    expect(texts[2]).toBe('confidenceScale');
    expect(texts[3]).toBe('sourceLine(example.com)');
    expect(texts[4]).toBe('Blue domes.');

    const secondary = root.querySelector('section.secondary') as HTMLElement;
    expect(secondary?.getAttribute('aria-label')).toBe('secondaryHeading');
    expect(secondary?.querySelector('.disagree-row')).not.toBeNull();
  });

  it('hides source and scale for chosen places', () => {
    const root = renderCard({
      view: 'result',
      place: PLACE,
      lowConfidence: false,
      canReanalyze: false,
      confidence: { line: 'confidenceChosen', showScale: false },
      sourceHost: null,
    }).container;
    expect(root.querySelector('.confidence')?.textContent).toBe('confidenceChosen');
    expect(root.querySelector('.confidence-scale')).toBeNull();
    expect(root.querySelector('.source')).toBeNull();
  });

  it('hides the correction row when there is nothing to reanalyze', () => {
    const root = renderCard({
      view: 'result',
      place: PLACE,
      lowConfidence: false,
      canReanalyze: false,
      confidence: CONF,
      sourceHost: 'example.com',
    }).container;
    expect(root.querySelector('h2')?.textContent).toBe('Oia');
    expect(root.querySelector('.disagree-row')).toBeNull();
  });

  it('renders results with badges and disagree actions', () => {
    const onReanalyze = vi.fn();

    const rendered = renderCard(
      {
        view: 'result',
        place: PLACE,
        lowConfidence: false,
        canReanalyze: true,
        confidence: CONF,
        sourceHost: 'example.com',
      },
      { onReanalyze }
    );

    const root = rendered.container;
    expect(root.querySelector('h2')?.textContent).toBe('Oia');
    expect(root.querySelector('.subtitle')?.textContent).toBe('Oia, Greece');
    expect(root.querySelector('.badge')).toBeNull();
    rerenderCard(
      rendered,
      {
        view: 'result',
        place: { ...PLACE, confidence: 0.2 },
        lowConfidence: true,
        canReanalyze: true,
        confidence: CONF,
        sourceHost: 'example.com',
      },
      { onReanalyze }
    );
    expect(root.querySelector('.badge')?.textContent).toBe('bestGuessBadge');

    const disagree = root.querySelector('.disagree-row') as HTMLElement;
    expect(disagree.querySelector('span')?.textContent).toBe('notThisPlace');

    const button = disagree.querySelector('button') as HTMLButtonElement;
    expect(button.textContent).toBe('reanalyzeButton');
    clickEl(button);
    expect(onReanalyze).toHaveBeenCalledTimes(1);
  });

  it('omits empty result fields', () => {
    const root = renderCard({
      view: 'result',
      place: { ...PLACE, city: '', country: '', oneLiner: '' },
      lowConfidence: false,
      canReanalyze: true,
      confidence: CONF,
      sourceHost: 'example.com',
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
      canReanalyze: true,
      confidence: CONF,
      sourceHost: 'example.com',
    }).container;

    const oneliner = root.querySelector('.oneliner') as HTMLElement;
    expect(oneliner.textContent).toBe(oneLiner);
    expect(oneliner.getAttribute('title')).toBe(oneLiner);
  });

  it('renders intent chips that emit one-shot alternates events', () => {
    const onAlternates = vi.fn();

    const root = renderCard(
      {
        view: 'result',
        place: PLACE,
        lowConfidence: false,
        canReanalyze: true,
        confidence: CONF,
        sourceHost: 'example.com',
      },
      { onAlternates }
    ).container;

    const chips = root.querySelectorAll('.chips-row .chip');
    expect(chips).toHaveLength(3);
    expect(root.querySelector('.chips-label')?.textContent).toBe('alternatesLabel');
    expect(chips[0]?.textContent).toBe('alternatesCheaper');
    expect(chips[0]?.hasAttribute('aria-pressed')).toBe(false);
    clickEl(chips[1] as HTMLButtonElement);
    expect(onAlternates).toHaveBeenCalledWith('quieter');
  });

  it('marks the pressed chip aria-disabled with skeleton cards while loading', () => {
    const onAlternates = vi.fn();

    const root = renderCard(
      {
        view: 'result',
        place: PLACE,
        lowConfidence: false,
        canReanalyze: true,
        confidence: CONF,
        sourceHost: 'example.com',
        alternates: { state: 'loading', intent: 'cheaper' },
      },
      { onAlternates }
    ).container;

    const chips = root.querySelectorAll('.chips-row .chip');
    expect(chips[0]?.getAttribute('aria-disabled')).toBe('true');
    expect(chips[1]?.hasAttribute('aria-disabled')).toBe(false);
    clickEl(chips[0] as HTMLButtonElement);
    expect(onAlternates).not.toHaveBeenCalled();

    const skeletons = root.querySelector('.alternates-skeletons');
    expect(skeletons?.getAttribute('aria-hidden')).toBe('true');
    expect(skeletons?.querySelectorAll('.skeleton-block')).toHaveLength(3);
    expect(root.querySelector('.alternates')?.getAttribute('aria-busy')).toBe('true');
  });

  it('renders alternate cards', () => {
    const root = renderCard({
      view: 'result',
      place: PLACE,
      lowConfidence: false,
      canReanalyze: true,
      confidence: CONF,
      sourceHost: 'example.com',
      alternates: {
        state: 'ready',
        intent: 'cheaper',
        cards: [
          {
            name: 'Fira, Greece',
            why: 'Same caldera, lower prices.',
            bestMonth: 'May',
          },
        ],
      },
    }).container;
    expect(root.querySelector('.alternates-skeletons')).toBeNull();
    const name = root.querySelector('.alternate-name') as HTMLAnchorElement;
    expect(name.tagName).toBe('A');
    expect(name.textContent?.replace('newTabSuffix', '')).toBe('Fira, Greece');
    expect(name.href).toContain('https://www.google.com/maps/search/');
    expect(name.href).toContain(encodeURIComponent('Fira, Greece'));
    expect(name.target).toBe('_blank');
    expect(root.querySelector('.alternate-why')?.textContent).toBe('Same caldera, lower prices.');
    expect(root.querySelector('.alternate-month')?.textContent).toBe('alternatesBestMonth(May)');
  });

  it('renders no-place cards with escapes', () => {
    const onLookAgain = vi.fn();

    const rendered = renderCard(
      {
        view: 'no-place',
        showLookAgain: true,
        fallback: { label: 'Santorini', href: 'https://www.google.com/maps/search/?api=1&query=x' },
      },
      { onLookAgain }
    );

    const root = rendered.container;
    expect(root.querySelector('h2')?.textContent).toBe('noPlaceTitle');

    const button = root.querySelector('button.primary') as HTMLButtonElement;
    expect(button.textContent).toBe('lookAgainButton');
    clickEl(button);
    expect(onLookAgain).toHaveBeenCalledTimes(1);

    const link = root.querySelector('.fallback a') as HTMLAnchorElement;
    expect(link.textContent).toContain('Santorini');
    expect(link.target).toBe('_blank');

    rerenderCard(
      rendered,
      { view: 'no-place', showLookAgain: false, fallback: null },
      { onLookAgain }
    );
    expect(root.querySelector('button')).toBeNull();
    expect(root.querySelector('.fallback')).toBeNull();
  });

  it('renders error cards with optional retry', () => {
    const onRetry = vi.fn();

    const rendered = renderCard(
      { view: 'error', title: 'T', body: 'B', showRetry: true },
      { onRetry }
    );

    const root = rendered.container;
    expect(root.querySelector('h2')?.textContent).toBe('T');
    clickEl(root.querySelector('button') as HTMLButtonElement);
    expect(onRetry).toHaveBeenCalledTimes(1);
    rerenderCard(rendered, { view: 'error', title: 'T', body: 'B', showRetry: false }, { onRetry });
    expect(root.querySelector('button')?.textContent).toBe('dismissErrorButton');
  });

  it('dismisses dead-end errors back to start', () => {
    const onDismissError = vi.fn();

    const root = renderCard(
      { view: 'error', title: 'T', body: 'B', showRetry: false },
      { onDismissError }
    ).container;

    const buttons = root.querySelectorAll('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.textContent).toBe('dismissErrorButton');
    clickEl(buttons[0] as HTMLButtonElement);
    expect(onDismissError).toHaveBeenCalledTimes(1);
  });

  it('renders a focusable result heading', () => {
    const root = renderCard({
      view: 'result',
      place: PLACE,
      lowConfidence: false,
      canReanalyze: true,
      confidence: CONF,
      sourceHost: 'example.com',
    }).container;

    const heading = root.querySelector('h2') as HTMLHeadingElement;
    focusEl(heading);
    expect(document.activeElement?.tagName).toBe('H2');
  });

  it('fires retry once with a loading state', () => {
    const onRetry = vi.fn();

    const root = renderCard(
      { view: 'error', title: 'Fail', body: 'Why', showRetry: true },
      { onRetry }
    ).container;

    const retry = root.querySelector('.primary') as HTMLButtonElement;
    clickEl(retry);
    clickEl(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(retry.getAttribute('aria-disabled')).toBe('true');
    expect(retry.textContent).toBe('retryingButton');
  });

  it('fires look-again once with a loading state', () => {
    const onLookAgain = vi.fn();

    const root = renderCard(
      { view: 'no-place', showLookAgain: true, fallback: null },
      { onLookAgain }
    ).container;

    const lookAgain = root.querySelector('.primary') as HTMLButtonElement;
    clickEl(lookAgain);
    clickEl(lookAgain);
    expect(onLookAgain).toHaveBeenCalledTimes(1);
    expect(lookAgain.getAttribute('aria-disabled')).toBe('true');
    expect(lookAgain.textContent).toBe('lookingAgainButton');
  });
});
