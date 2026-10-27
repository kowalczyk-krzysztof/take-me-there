// <booking-grid>: the booking deep-link tile grid. Hrefs come from the
// verified templates and are assigned via the anchor href property only;
// labels resolve through locales.
import { buildLinks } from '../deep_links';
import { adoptSharedStyles } from './shared_styles';
import elementCss from './booking_grid.css?raw';

const msg = (key: string, subs?: string | string[]): string =>
  chrome.i18n.getMessage(key, subs);

export class BookingGridElement extends HTMLElement {
  private root: ShadowRoot;

  constructor() {
    super();
    this.root = this.attachShadow({ mode: 'open' });
    adoptSharedStyles(this.root);
    const style = document.createElement('style');
    style.textContent = elementCss;
    this.root.append(style);
  }

  setDestination(destination: string): void {
    for (const child of [...this.root.children]) {
      if (child.tagName !== 'STYLE') {
        child.remove();
      }
    }
    if (!destination) {
      return;
    }
    for (const link of buildLinks(destination)) {
      const tile = document.createElement('a');
      tile.href = link.href;
      tile.target = '_blank';
      tile.rel = 'noopener';
      tile.className = 'tile';
      tile.textContent = msg(`bookingLink_${link.id}`);
      const suffix = document.createElement('span');
      suffix.className = 'visually-hidden';
      suffix.textContent = msg('newTabSuffix');
      tile.append(suffix);
      this.root.append(tile);
    }
  }
}

if (!customElements.get('booking-grid')) {
  customElements.define('booking-grid', BookingGridElement);
}
