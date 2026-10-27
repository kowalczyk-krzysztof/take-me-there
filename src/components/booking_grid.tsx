import { buildLinks } from '../deep_links';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import styles from './booking_grid.module.css';
import { msg } from '../utils/i18n';

export const BookingGrid = ({ destination }: { destination: string }) => (
  <div className={styles.root}>
    {destination
      ? buildLinks(destination).map((link) => (
          <a key={link.id} href={link.href} target="_blank" rel="noopener" className={styles.tile}>
            {msg(`bookingLink_${link.id}`)}
            <span className="visually-hidden">{msg('newTabSuffix')}</span>
          </a>
        ))
      : null}
  </div>
);

export class BookingGridElement extends HTMLElement {
  private root: Root | null = null;
  private destination = '';

  setDestination(destination: string): void {
    this.destination = destination;
    this.root ??= createRoot(this);
    flushSync(() => {
      this.root?.render(<BookingGrid destination={this.destination} />);
    });
  }
}

if (!customElements.get('booking-grid')) {
  customElements.define('booking-grid', BookingGridElement);
}
