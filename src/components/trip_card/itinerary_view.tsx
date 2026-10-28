import styles from './trip_card.module.css';
import { msg } from '../../utils/i18n';
import { ExternalLink } from '../external_link/external_link';
import type { ItineraryStopView } from './trip_card';

interface Props {
  title: string;
  stops: ItineraryStopView[];
  mapsUrl: string | null;
  mapsLabel: string;
}

export const ItineraryView = ({ title, stops, mapsUrl, mapsLabel }: Props) => (
  <>
    <h2 tabIndex={-1}>{title}</h2>
    <ol className={styles['stop-list']}>
      {stops.map((stop) => (
        <li key={stop.name}>
          <p className={styles['stop-name']}>{stop.name}</p>
          {stop.nights !== null ? (
            <p className={styles['stop-nights']}>{msg('itineraryNights', String(stop.nights))}</p>
          ) : null}
          {stop.links.length > 0 ? (
            <p className={styles['stop-links']}>
              {stop.links.map((link, index) => (
                <span key={link.id}>
                  {index > 0 ? ' · ' : null}
                  <ExternalLink href={link.href}>{msg(`bookingLink_${link.id}`)}</ExternalLink>
                </span>
              ))}
            </p>
          ) : null}
        </li>
      ))}
    </ol>
    {mapsUrl ? (
      <ExternalLink className={styles['maps-link']} href={mapsUrl}>
        {mapsLabel}
      </ExternalLink>
    ) : null}
  </>
);
