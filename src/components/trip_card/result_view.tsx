import type { PlaceResult } from '../../types';
import styles from './trip_card.module.css';
import { msg } from '../../utils/i18n';
import type { AlternatesView, ConfidenceView, TripCardCallbacks } from './trip_card';
import { ChipsRow } from './chips_row';
import { AlternatesView as AlternatesList } from './alternates_view';

interface Props {
  place: PlaceResult;
  lowConfidence: boolean;
  canReanalyze: boolean;
  confidence: ConfidenceView;
  sourceHost: string | null;
  alternates: AlternatesView;
  callbacks: TripCardCallbacks;
}

export const ResultView = ({
  place,
  lowConfidence,
  canReanalyze,
  confidence,
  sourceHost,
  alternates,
  callbacks,
}: Props) => {
  const subtitle = [place.city, place.country].filter((part) => part).join(', ');

  return (
    <>
      <h2 tabIndex={-1}>
        {place.placeName}
        {lowConfidence ? (
          <>
            {' '}
            <span className={styles.badge}>{msg('bestGuessBadge')}</span>
          </>
        ) : null}
      </h2>
      {subtitle ? <p className={styles.subtitle}>{subtitle}</p> : null}
      <p className={styles.confidence}>{confidence.line}</p>
      {confidence.showScale ? (
        <p className={styles['confidence-scale']}>{msg('confidenceScale')}</p>
      ) : null}
      {sourceHost ? <p className={styles.source}>{msg('sourceLine', sourceHost)}</p> : null}
      {place.oneLiner ? (
        <p className={styles.oneliner} title={place.oneLiner}>
          {place.oneLiner}
        </p>
      ) : null}
      <section className={styles.secondary} aria-label={msg('secondaryHeading')}>
        <ChipsRow alternates={alternates} onAlternates={callbacks.onAlternates} />
        <AlternatesList alternates={alternates} onCancel={callbacks.onCancelAlternates} />
        {canReanalyze ? (
          <div className={styles['disagree-row']}>
            <span>{msg('notThisPlace')}</span>
            <button type="button" onClick={callbacks.onReanalyze}>
              {msg('reanalyzeButton')}
            </button>
          </div>
        ) : null}
      </section>
    </>
  );
};
