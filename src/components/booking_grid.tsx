import { buildLinks } from '../deep_links';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { injectComponentStyles } from './shared_styles';
import elementCss from './booking_grid.css?raw';

injectComponentStyles('booking-grid', elementCss);

const msg = (key: string, subs?: string | string[]): string =>
  chrome.i18n.getMessage(key, subs);

const BookingGridView = ({ destination }: { destination: string }) => (
  <>
    {destination
      ? buildLinks(destination).map((link) => (
          <a key={link.id} href={link.href} target="_blank" rel="noopener" className="tile">
            {msg(`bookingLink_${link.id}`)}
            <span className="visually-hidden">{msg('newTabSuffix')}</span>
          </a>
        ))
      : null}
  </>
);

export class BookingGridElement extends HTMLElement {
  private root: Root | null = null;
  private destination = '';

  setDestination(destination: string): void {
    this.destination = destination;
    this.root ??= createRoot(this);
    flushSync(() => {
      this.root?.render(<BookingGridView destination={this.destination} />);
    });
  }
}

if (!customElements.get('booking-grid')) {
  customElements.define('booking-grid', BookingGridElement);
}
