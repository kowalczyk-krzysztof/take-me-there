import styles from './trip_card.module.css';
import { msg } from '../../utils/i18n';
import { mapsSearchUrl } from '../../deep_links';
import { ExternalLink } from '../external_link/external_link';
import { Monogram } from '../thumb_image/monogram';
import type { AlternatesView as AlternatesState } from './trip_card';

interface Props {
  alternates: AlternatesState;
  onCancel: () => void;
}

export const AlternatesView = ({ alternates, onCancel }: Props) => {
  if (alternates.state === 'idle') {
    return <div className={styles.alternates} hidden />;
  }

  if (alternates.state === 'loading') {
    return (
      <div className={styles.alternates} aria-busy="true">
        <div className={styles['alternates-skeletons']} aria-hidden="true">
          {[0, 1, 2].map((index) => (
            <div key={index} className={`skeleton-block ${styles['skeleton-card']}`} />
          ))}
        </div>
        <button type="button" onClick={onCancel}>
          {msg('cancelButton')}
        </button>
      </div>
    );
  }

  return (
    <div className={styles.alternates} aria-busy="false">
      {alternates.cards.map((card) => (
        <div key={card.name} className={styles['alternate-card']}>
          <div className={styles['alternate-head']}>
            <Monogram name={card.name} />
            <ExternalLink href={mapsSearchUrl(card.name)} className={styles['alternate-name']}>
              {card.name}
            </ExternalLink>
          </div>
          <p className={styles['alternate-why']}>{card.why}</p>
          <p className={styles['alternate-month']}>{msg('alternatesBestMonth', card.bestMonth)}</p>
        </div>
      ))}
    </div>
  );
};
