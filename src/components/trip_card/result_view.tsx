import type { PlaceResult } from '../../types';
import styles from './trip_card.module.css';
import { msg } from '../../utils/i18n';
import type { AlternatesView, CompareOptionView, PlanState, TripCardCallbacks } from './trip_card';
import { ChipsRow } from './chips_row';
import { AlternatesView as AlternatesList } from './alternates_view';
import { CompareRow } from './compare_row';

interface Props {
  place: PlaceResult;
  lowConfidence: boolean;
  pinned: boolean;
  planState: PlanState;
  compareOptions: CompareOptionView[];
  alternates: AlternatesView;
  callbacks: TripCardCallbacks;
}

export const ResultView = ({
  place,
  lowConfidence,
  pinned,
  planState,
  compareOptions,
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
      {place.oneLiner ? (
        <p className={styles.oneliner} title={place.oneLiner}>
          {place.oneLiner}
        </p>
      ) : null}
      <button
        type="button"
        className={styles['pin-button']}
        aria-pressed={pinned}
        onClick={callbacks.onPin}
      >
        {msg('pinButton', place.placeName)}
      </button>
      {planState === 'ready' ? null : (
        <>
          <button
            type="button"
            className={styles['plan-trip-button']}
            aria-disabled={planState === 'planning' || undefined}
            onClick={() => {
              if (planState === 'planning') {
                return;
              }
              callbacks.onPlanTrip();
            }}
          >
            {msg(
              planState === 'planning'
                ? 'planningButton'
                : planState === 'interrupted'
                  ? 'startAgainButton'
                  : 'planTripButton'
            )}
          </button>
          {planState === 'interrupted' ? (
            <p className={styles['start-again-hint']}>{msg('startAgainHint')}</p>
          ) : null}
        </>
      )}
      <ChipsRow alternates={alternates} onAlternates={callbacks.onAlternates} />
      <AlternatesList
        alternates={alternates}
        onPinAlternate={callbacks.onPinAlternate}
        onPlanInstead={callbacks.onPlanInstead}
        onCancel={callbacks.onCancelAlternates}
      />
      <CompareRow options={compareOptions} onCompare={callbacks.onCompare} />
      <div className={styles['disagree-row']}>
        <span>{msg('notThisPlace')}</span>
        <button type="button" onClick={callbacks.onReanalyze}>
          {msg('reanalyzeButton')}
        </button>
      </div>
    </>
  );
};
