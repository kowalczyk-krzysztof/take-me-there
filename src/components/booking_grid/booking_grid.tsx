import { buildLinks } from '../../deep_links';
import styles from './booking_grid.module.css';
import { msg } from '../../utils/i18n';
import { ExternalLink } from '../external_link/external_link';

interface Props {
  destination: string;
}

export const BookingGrid = ({ destination }: Props) => (
  <div className={styles.root}>
    {destination
      ? buildLinks(destination).map((link) => (
          <ExternalLink key={link.id} href={link.href} className={styles.tile}>
            {msg(`bookingLink_${link.id}`) || link.id}
          </ExternalLink>
        ))
      : null}
  </div>
);
