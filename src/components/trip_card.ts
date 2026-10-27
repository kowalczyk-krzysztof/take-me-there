// <trip-card>: the loading, result, no-place, and error state cards. All
// model and page strings land as text nodes only.
import type { PlaceResult } from '../types';
import { adoptSharedStyles, prefersReducedMotion } from './shared_styles';
import elementCss from './trip_card.css?raw';

export interface ItineraryStopView {
  name: string;
  nights: number | null;
  links: Array<{ id: string; href: string }>;
}

export type CardState =
  | { view: 'idle'; hint: string; shortcut: string }
  | { view: 'loading' }
  | { view: 'result'; place: PlaceResult; lowConfidence: boolean; pinned: boolean }
  | { view: 'no-place'; showLookAgain: boolean; fallback: { label: string; href: string } | null }
  | {
    view: 'error';
    title: string;
    body: string;
    showRetry: boolean;
    fallback?: { label: string; href: string } | null;
  }
  | {
    view: 'itinerary';
    title: string;
    stops: ItineraryStopView[];
    mapsUrl: string | null;
    mapsLabel: string;
  };

const msg = (key: string, subs?: string | string[]): string =>
  chrome.i18n.getMessage(key, subs);

const LOADING_LINES = ['loadingReading', 'loadingIdentifying', 'loadingWriting'];
const ROTATE_MS = 2500;

export class TripCardElement extends HTMLElement {
  private root: ShadowRoot;
  private rotateTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    super();
    this.root = this.attachShadow({ mode: 'open' });
    adoptSharedStyles(this.root);
    const style = document.createElement('style');
    style.textContent = elementCss;
    this.root.append(style);
  }

  disconnectedCallback(): void {
    this.stopRotation();
  }

  setCard(state: CardState): void {
    this.stopRotation();
    for (const child of [...this.root.children]) {
      if (child.tagName !== 'STYLE') {
        child.remove();
      }
    }
    switch (state.view) {
      case 'idle':
        this.renderIdle(state.hint, state.shortcut);
        break;
      case 'loading':
        this.renderLoading();
        break;
      case 'result':
        this.renderResult(state.place, state.lowConfidence, state.pinned);
        break;
      case 'no-place':
        this.renderNoPlace(state.showLookAgain, state.fallback);
        break;
      case 'error':
        this.renderError(state.title, state.body, state.showRetry, state.fallback ?? null);
        break;
      case 'itinerary':
        this.renderItinerary(state.title, state.stops, state.mapsUrl, state.mapsLabel);
        break;
    }
  }

  focusHeading(): void {
    this.root.querySelector('h2')?.focus();
  }

  private renderIdle(hint: string, shortcut: string): void {
    const hintEl = document.createElement('p');
    hintEl.className = 'hint';
    hintEl.textContent = hint;
    const shortcutEl = document.createElement('p');
    shortcutEl.className = 'shortcut';
    shortcutEl.textContent = shortcut;
    this.root.append(hintEl, shortcutEl);
  }

  private renderLoading(): void {
    const wrap = document.createElement('div');
    wrap.className = 'skeleton';
    wrap.setAttribute('aria-hidden', 'true');
    for (const width of ['60%', '40%', '100%', '100%']) {
      const block = document.createElement('div');
      block.className = 'skeleton-block';
      block.style.width = width;
      wrap.append(block);
    }
    const cosmetic = document.createElement('p');
    cosmetic.className = 'cosmetic';
    cosmetic.textContent = msg(LOADING_LINES[0]);
    wrap.append(cosmetic);
    this.root.append(wrap);
    if (!prefersReducedMotion()) {
      let index = 0;
      this.rotateTimer = setInterval(() => {
        index = (index + 1) % LOADING_LINES.length;
        cosmetic.textContent = msg(LOADING_LINES[index]);
      }, ROTATE_MS);
    }
  }

  private renderResult(place: PlaceResult, lowConfidence: boolean, pinned: boolean): void {
    const heading = document.createElement('h2');
    heading.tabIndex = -1;
    heading.textContent = place.placeName;
    this.root.append(heading);
    if (lowConfidence) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = msg('bestGuessBadge');
      heading.append(' ', badge);
    }
    const subtitle = [place.city, place.country].filter((part) => part).join(', ');
    if (subtitle) {
      const sub = document.createElement('p');
      sub.className = 'subtitle';
      sub.textContent = subtitle;
      this.root.append(sub);
    }
    if (place.oneLiner) {
      const one = document.createElement('p');
      one.className = 'oneliner';
      one.textContent = place.oneLiner;
      this.root.append(one);
    }
    const pin = document.createElement('button');
    pin.type = 'button';
    pin.className = 'pin-button';
    pin.setAttribute('aria-pressed', String(pinned));
    pin.textContent = msg('pinButton', place.placeName);
    pin.addEventListener('click', () => this.emit('trip-pin'));
    this.root.append(pin);
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = msg('notThisPlace');
    const buttons = document.createElement('div');
    buttons.className = 'disagree-buttons';
    const reanalyze = document.createElement('button');
    reanalyze.type = 'button';
    reanalyze.textContent = msg('reanalyzeButton');
    reanalyze.addEventListener('click', () => this.emit('trip-reanalyze'));
    buttons.append(reanalyze);
    details.append(summary, buttons);
    this.root.append(details);
  }

  private renderItinerary(
    title: string,
    stops: ItineraryStopView[],
    mapsUrl: string | null,
    mapsLabel: string,
  ): void {
    const heading = document.createElement('h2');
    heading.tabIndex = -1;
    heading.textContent = title;
    this.root.append(heading);
    const list = document.createElement('ol');
    list.className = 'stop-list';
    for (const stop of stops) {
      const entry = document.createElement('li');
      const name = document.createElement('p');
      name.className = 'stop-name';
      name.textContent = stop.name;
      entry.append(name);
      if (stop.nights !== null) {
        const nights = document.createElement('p');
        nights.className = 'stop-nights';
        nights.textContent = msg('itineraryNights', String(stop.nights));
        entry.append(nights);
      }
      if (stop.links.length > 0) {
        const row = document.createElement('p');
        row.className = 'stop-links';
        stop.links.forEach((link, index) => {
          if (index > 0) {
            row.append(' · ');
          }
          const anchor = document.createElement('a');
          anchor.href = link.href;
          anchor.target = '_blank';
          anchor.rel = 'noopener';
          anchor.textContent = msg(`bookingLink_${link.id}`);
          const suffix = document.createElement('span');
          suffix.className = 'visually-hidden';
          suffix.textContent = msg('newTabSuffix');
          anchor.append(suffix);
          row.append(anchor);
        });
        entry.append(row);
      }
      list.append(entry);
    }
    this.root.append(list);
    if (mapsUrl) {
      const maps = document.createElement('a');
      maps.className = 'maps-link';
      maps.href = mapsUrl;
      maps.target = '_blank';
      maps.rel = 'noopener';
      maps.textContent = mapsLabel;
      const suffix = document.createElement('span');
      suffix.className = 'visually-hidden';
      suffix.textContent = msg('newTabSuffix');
      maps.append(suffix);
      this.root.append(maps);
    }
  }

  private renderNoPlace(
    showLookAgain: boolean,
    fallback: { label: string; href: string } | null,
  ): void {
    const heading = document.createElement('h2');
    heading.tabIndex = -1;
    heading.textContent = msg('noPlaceTitle');
    const body = document.createElement('p');
    body.textContent = msg('noPlaceBody');
    this.root.append(heading, body);
    if (showLookAgain) {
      const lookAgain = document.createElement('button');
      lookAgain.type = 'button';
      lookAgain.className = 'primary';
      lookAgain.textContent = msg('lookAgainButton');
      lookAgain.addEventListener('click', () => this.emit('trip-look-again'));
      this.root.append(lookAgain);
    }
    if (fallback) {
      this.root.append(this.fallbackLine(fallback));
    }
  }

  private renderError(
    title: string,
    body: string,
    showRetry: boolean,
    fallback: { label: string; href: string } | null,
  ): void {
    const heading = document.createElement('h2');
    heading.tabIndex = -1;
    heading.textContent = title;
    const bodyEl = document.createElement('p');
    bodyEl.textContent = body;
    this.root.append(heading, bodyEl);
    if (showRetry) {
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'primary';
      retry.textContent = msg('retryButton');
      retry.addEventListener('click', () => this.emit('trip-retry'));
      this.root.append(retry);
    }
    if (fallback) {
      this.root.append(this.fallbackLine(fallback));
    }
  }

  private fallbackLine(fallback: { label: string; href: string }): HTMLElement {
    const line = document.createElement('p');
    line.className = 'fallback';
    const prefix = document.createElement('span');
    prefix.textContent = `${msg('fallbackPrefix')} `;
    const link = document.createElement('a');
    link.href = fallback.href;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = fallback.label;
    const suffix = document.createElement('span');
    suffix.className = 'visually-hidden';
    suffix.textContent = msg('newTabSuffix');
    link.append(suffix);
    line.append(prefix, link);
    return line;
  }

  private stopRotation(): void {
    if (this.rotateTimer !== undefined) {
      clearInterval(this.rotateTimer);
      this.rotateTimer = undefined;
    }
  }

  private emit(name: string): void {
    this.dispatchEvent(new CustomEvent(name, { bubbles: true, composed: true }));
  }
}

if (!customElements.get('trip-card')) {
  customElements.define('trip-card', TripCardElement);
}
