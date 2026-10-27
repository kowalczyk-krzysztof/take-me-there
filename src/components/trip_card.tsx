import { useEffect, useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import type { PlaceResult } from '../types';
import { prefersReducedMotion } from '../utils/dom';
import styles from './trip_card.module.css';
import { msg } from '../utils/i18n';


export interface ItineraryStopView {
  name: string;
  nights: number | null;
  links: Array<{ id: string; href: string }>;
}

export interface CompareOptionView {
  value: string;
  label: string;
}

export type AlternateIntentView = 'cheaper' | 'quieter' | 'similar';

export interface AlternateCardView {
  name: string;
  why: string;
  bestMonth: string;
  pinned: boolean;
}

export interface TripPinAlternateDetail {
  index: number;
}

export type AlternatesView =
  | { state: 'idle' }
  | { state: 'loading'; intent: AlternateIntentView }
  | { state: 'ready'; intent: AlternateIntentView; cards: AlternateCardView[] };

export interface TripCompareDetail {
  value: string;
}

export interface TripAlternatesDetail {
  intent: AlternateIntentView;
}

export interface TripPlanInsteadDetail {
  index: number;
}

export interface TripCardCallbacks {
  onPin: () => void;
  onReanalyze: () => void;
  onRetry: () => void;
  onFetchRetry: () => void;
  onNanoInstead: () => void;
  onLookAgain: () => void;
  onAlternates: (intent: AlternateIntentView) => void;
  onCompare: (value: string) => void;
  onPinAlternate: (index: number) => void;
  onPlanInstead: (index: number) => void;
}

export type CardState =
  | { view: 'idle'; hint: string; shortcut: string }
  | { view: 'loading' }
  | {
    view: 'result';
    place: PlaceResult;
    lowConfidence: boolean;
    pinned: boolean;
    onDevice?: boolean;
    compareOptions?: CompareOptionView[];
    alternates?: AlternatesView;
  }
  | { view: 'no-place'; showLookAgain: boolean; fallback: { label: string; href: string } | null }
  | {
    view: 'error';
    title: string;
    body: string;
    showRetry: boolean;
    fallback?: { label: string; href: string } | null;
    showFetchRetry?: boolean;
    showNanoInstead?: boolean;
  }
  | {
    view: 'itinerary';
    title: string;
    stops: ItineraryStopView[];
    mapsUrl: string | null;
    mapsLabel: string;
  };

const LOADING_LINES = ['loadingReading', 'loadingIdentifying', 'loadingWriting'];
const ROTATE_MS = 2500;

const IdleView = ({ hint, shortcut }: { hint: string; shortcut: string }) => (
  <>
    <p className={styles.hint}>{hint}</p>
    <p className={styles.shortcut}>{shortcut}</p>
  </>
);

const LoadingView = () => {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (prefersReducedMotion()) {
      return;
    }
    const timer = setInterval(() => {
      setIndex((current) => (current + 1) % LOADING_LINES.length);
    }, ROTATE_MS);
    return () => clearInterval(timer);
  }, []);
  return (
    <div className={styles.skeleton} aria-hidden="true">
      {['60%', '40%', '100%', '100%'].map((width, index) => (
        <div key={index} className="skeleton-block" style={{ width }} />
      ))}
      <p className={styles.cosmetic}>{msg(LOADING_LINES[index])}</p>
    </div>
  );
};

// Re-run buttons fire once: aria-disabled (never native disabled on the
// focused control) plus a loading label, reset by the next render.
const OneShotButton = ({
  label, loadingLabel, onFire,
}: {
  label: string;
  loadingLabel: string;
  onFire: () => void;
}) => {
  const [fired, setFired] = useState(false);
  // Sync guard: back-to-back clicks in one tick batch before state flushes.
  const firedRef = useRef(false);
  return (
    <button
      type="button"
      className={styles.primary}
      aria-disabled={fired || undefined}
      onClick={() => {
        if (firedRef.current) {
          return;
        }
        firedRef.current = true;
        flushSync(() => setFired(true));
        onFire();
      }}
    >
      {fired ? loadingLabel : label}
    </button>
  );
};

const FallbackLine = ({ fallback }: { fallback: { label: string; href: string } }) => (
  <p className={styles.fallback}>
    <span>{`${msg('fallbackPrefix')} `}</span>
    <a href={fallback.href} target="_blank" rel="noopener">
      {fallback.label}
      <span className="visually-hidden">{msg('newTabSuffix')}</span>
    </a>
  </p>
);

const ChipsRow = ({ alternates, onAlternates }: { alternates: AlternatesView; onAlternates: (intent: AlternateIntentView) => void }) => {
  const intents: Array<{ intent: AlternateIntentView; key: string }> = [
    { intent: 'cheaper', key: 'alternatesCheaper' },
    { intent: 'quieter', key: 'alternatesQuieter' },
    { intent: 'similar', key: 'alternatesSimilar' },
  ];
  return (
    <div className={styles['chips-row']}>
      {intents.map(({ intent, key }) => {
        const busy = alternates.state === 'loading' && alternates.intent === intent;
        return (
          <button
            key={intent}
            type="button"
            className={styles.chip}
            data-intent={intent}
            aria-disabled={busy || undefined}
            onClick={() => {
              if (busy) {
                return;
              }
              onAlternates(intent);
            }}
          >
            {msg(key)}
          </button>
        );
      })}
    </div>
  );
};

const AlternatesView = ({ alternates, onPinAlternate, onPlanInstead }: { alternates: AlternatesView; onPinAlternate: (index: number) => void; onPlanInstead: (index: number) => void }) => {
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
      </div>
    );
  }
  return (
    <div className={styles.alternates} aria-busy="false">
      {alternates.cards.map((card, index) => (
        <div key={index} className={styles['alternate-card']}>
          <div className={styles['alternate-head']}>
            <div className="thumb-monogram" aria-hidden="true">{card.name.trim().charAt(0)}</div>
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
              {msg('pinButton', card.name)}
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

const CompareRow = ({ options, onCompare }: { options: CompareOptionView[]; onCompare: (value: string) => void }) => {
  const selectRef = useRef<HTMLSelectElement>(null);
  return (
    <div className={styles['compare-row']}>
      <label>
        {msg('compareLabel')}
        <select ref={selectRef}>
          {options.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </label>
      <button
        type="button"
        className="compare-go"
        onClick={() => {
          onCompare(selectRef.current?.value ?? '');
        }}
      >
        {msg('compareGo')}
      </button>
    </div>
  );
};

const ResultView = ({
  place, lowConfidence, pinned, onDevice, compareOptions, alternates, callbacks,
}: {
  place: PlaceResult;
  lowConfidence: boolean;
  pinned: boolean;
  onDevice: boolean;
  compareOptions: CompareOptionView[];
  alternates: AlternatesView;
  callbacks: TripCardCallbacks;
}) => {
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
        {onDevice ? (
          <>
            {' '}
            <span className={`${styles.badge} nano-badge`}>{msg('nanoBadge')}</span>
          </>
        ) : null}
      </h2>
      {subtitle ? <p className={styles.subtitle}>{subtitle}</p> : null}
      {place.oneLiner ? <p className={styles.oneliner}>{place.oneLiner}</p> : null}
      <button
        type="button"
        className={styles['pin-button']}
        aria-pressed={pinned}
        onClick={callbacks.onPin}
      >
        {msg('pinButton', place.placeName)}
      </button>
      <ChipsRow alternates={alternates} onAlternates={callbacks.onAlternates} />
      <AlternatesView alternates={alternates} onPinAlternate={callbacks.onPinAlternate} onPlanInstead={callbacks.onPlanInstead} />
      {compareOptions.length > 0 ? <CompareRow options={compareOptions} onCompare={callbacks.onCompare} /> : null}
      <details>
        <summary>{msg('notThisPlace')}</summary>
        <div className={styles['disagree-buttons']}>
          <button type="button" onClick={callbacks.onReanalyze}>
            {msg('reanalyzeButton')}
          </button>
        </div>
      </details>
    </>
  );
};

const ItineraryView = ({
  title, stops, mapsUrl, mapsLabel,
}: {
  title: string;
  stops: ItineraryStopView[];
  mapsUrl: string | null;
  mapsLabel: string;
}) => (
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

const NoPlaceView = ({
  showLookAgain, fallback, onLookAgain,
}: {
  showLookAgain: boolean;
  fallback: { label: string; href: string } | null;
  onLookAgain: () => void;
}) => (
  <>
    <h2 tabIndex={-1}>{msg('noPlaceTitle')}</h2>
    <p>{msg('noPlaceBody')}</p>
    {showLookAgain ? (
      <OneShotButton
        label={msg('lookAgainButton')}
        loadingLabel={msg('lookingAgainButton')}
        onFire={onLookAgain}
      />
    ) : null}
    {fallback ? <FallbackLine fallback={fallback} /> : null}
  </>
);

const ErrorView = ({
  title, body, showRetry, fallback, showFetchRetry, showNanoInstead, callbacks,
}: {
  title: string;
  body: string;
  showRetry: boolean;
  fallback: { label: string; href: string } | null;
  showFetchRetry: boolean;
  showNanoInstead: boolean;
  callbacks: Pick<TripCardCallbacks, 'onRetry' | 'onFetchRetry' | 'onNanoInstead'>;
}) => (
  <>
    <h2 tabIndex={-1}>{title}</h2>
    <p>{body}</p>
    {showRetry ? (
      <OneShotButton
        label={msg('retryButton')}
        loadingLabel={msg('retryingButton')}
        onFire={callbacks.onRetry}
      />
    ) : null}
    {showFetchRetry ? (
      <OneShotButton
        label={msg('fetchRetryButton')}
        loadingLabel={msg('fetchRetryLoading')}
        onFire={callbacks.onFetchRetry}
      />
    ) : null}
    {showNanoInstead ? (
      <OneShotButton
        label={msg('nanoTryInstead')}
        loadingLabel={msg('nanoDownloading')}
        onFire={callbacks.onNanoInstead}
      />
    ) : null}
    {fallback ? <FallbackLine fallback={fallback} /> : null}
  </>
);

// The epoch key remounts the whole view on every new card object, so
// per-render state (one-shot buttons, rotation) resets on every update.
export const TripCard = ({ card, callbacks }: { card: CardState; callbacks: TripCardCallbacks }) => {
  const [epoch, setEpoch] = useState(0);
  const prevCard = useRef(card);
  if (prevCard.current !== card) {
    prevCard.current = card;
    setEpoch((current) => current + 1);
  }
  let view: ReactNode;
  switch (card.view) {
    case 'idle':
      view = <IdleView hint={card.hint} shortcut={card.shortcut} />;
      break;
    case 'loading':
      view = <LoadingView />;
      break;
    case 'result':
      view = (
        <ResultView
          place={card.place}
          lowConfidence={card.lowConfidence}
          pinned={card.pinned}
          onDevice={card.onDevice ?? false}
          compareOptions={card.compareOptions ?? []}
          alternates={card.alternates ?? { state: 'idle' }}
          callbacks={callbacks}
        />
      );
      break;
    case 'no-place':
      view = (
        <NoPlaceView
          showLookAgain={card.showLookAgain}
          fallback={card.fallback}
          onLookAgain={callbacks.onLookAgain}
        />
      );
      break;
    case 'error':
      view = (
        <ErrorView
          title={card.title}
          body={card.body}
          showRetry={card.showRetry}
          fallback={card.fallback ?? null}
          showFetchRetry={card.showFetchRetry ?? false}
          showNanoInstead={card.showNanoInstead ?? false}
          callbacks={callbacks}
        />
      );
      break;
    case 'itinerary':
      view = (
        <ItineraryView
          title={card.title}
          stops={card.stops}
          mapsUrl={card.mapsUrl}
          mapsLabel={card.mapsLabel}
        />
      );
      break;
  }
  return (
    <div key={epoch} className={styles.root}>
      {view}
    </div>
  );
};

