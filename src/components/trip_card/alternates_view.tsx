import styles from './trip_card.module.css';
import { msg } from '../../utils/i18n';
import { mapsSearchUrl } from '../../deep_links';
import { ExternalLink } from '../external_link/external_link';
import { Monogram } from '../thumb_image/monogram';
import type { AlternatesView as AlternatesState, AlternateIntentView } from './trip_card';

interface Props {
  alternates: AlternatesState;
  onCancel: () => void;
  onRetry: (intent: AlternateIntentView) => void;
}

export const AlternatesView = ({ alternates, onCancel, onRetry }: Props) => {
  if (alternates.state === 'idle') {
    return null;
  }

  if (alternates.state === 'error') {
    return (
      <div className={styles.alternates}>
        <p className={styles['alternates-error-title']}>{alternates.title}</p>
        <p className={styles['alternates-error-body']}>{alternates.body}</p>
        <button type="button" onClick={() => onRetry(alternates.intent)}>
          {msg('retryButton')}
        </button>
      </div>
    );
  }

  if (alternates.state === 'empty') {
    return (
      <div className={styles.alternates}>
        <p className={styles['alternates-error-title']}>{msg('alternatesEmptyTitle')}</p>
        <p className={styles['alternates-error-body']}>{msg('alternatesEmptyBody')}</p>
        <button type="button" onClick={() => onRetry(alternates.intent)}>
          {msg('retryButton')}
        </button>
      </div>
    );
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
    <div className={styles.alternates}>
      <p className={styles['alternates-provenance']}>
        {msg(alternates.grounded ? 'alternatesGrounded' : 'alternatesUngrounded')}
      </p>
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
      {alternates.sources.length > 0 ? (
        <p className={styles['alternates-sources']}>
          <span>{msg('alternatesSources')}: </span>
          {alternates.sources.map((source, index) => (
            <span key={source.url}>
              {index > 0 ? <span aria-hidden="true"> · </span> : null}
              <ExternalLink href={source.url}>{source.title}</ExternalLink>
            </span>
          ))}
        </p>
      ) : null}
    </div>
  );
};
