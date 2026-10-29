import styles from './trip_card.module.css';
import { msg } from '../../utils/i18n';
import { Monogram } from '../thumb_image/monogram';
import type { AlternatesView as AlternatesState } from './trip_card';

interface Props {
  alternates: AlternatesState;
  onPinAlternate: (index: number) => void;
  onPlanInstead: (index: number) => void;
  onCancel: () => void;
}

export const AlternatesView = ({ alternates, onPinAlternate, onPlanInstead, onCancel }: Props) => {
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
      {alternates.cards.map((card, index) => (
        <div key={index} className={styles['alternate-card']}>
          <div className={styles['alternate-head']}>
            <Monogram name={card.name} />
            <p className={styles['alternate-name']}>{card.name}</p>
          </div>
          <p className={styles['alternate-why']}>{card.why}</p>
          <p className={styles['alternate-month']}>{msg('alternatesBestMonth', card.bestMonth)}</p>
          <div className={styles['alternate-actions']}>
            <button
              type="button"
              className={styles['pin-button']}
              aria-pressed={card.pinned}
              onClick={() => {
                onPinAlternate(index);
              }}
            >
              {card.pinned ? msg('savedButton', card.name) : msg('pinButton', card.name)}
            </button>
            <button
              type="button"
              onClick={() => {
                onPlanInstead(index);
              }}
            >
              {msg('alternatesInstead', card.name)}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
};
