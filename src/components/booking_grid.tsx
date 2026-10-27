import { buildLinks } from '../deep_links';
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

