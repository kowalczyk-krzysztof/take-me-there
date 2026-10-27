import styles from './trip_card.module.css';
import { msg } from '../../utils/i18n';
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
                  <a href={link.href} target="_blank" rel="noopener">
                    {msg(`bookingLink_${link.id}`)}
                    <span className="visually-hidden">{msg('newTabSuffix')}</span>
                  </a>
                </span>
              ))}
            </p>
          ) : null}
        </li>
      ))}
    </ol>
    {mapsUrl ? (
      <a className={styles['maps-link']} href={mapsUrl} target="_blank" rel="noopener">
        {mapsLabel}
        <span className="visually-hidden">{msg('newTabSuffix')}</span>
      </a>
    ) : null}
  </>
);
