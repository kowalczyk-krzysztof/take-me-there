import { useEffect, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import type { PlaceResult } from '../types';
import { prefersReducedMotion } from '../utils/dom';
import styles from './trip_card.module.css';
import { msg } from '../utils/i18n';
import { emit } from '../utils/events';


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
  host, label, loadingLabel, event,
}: {
  host: HTMLElement;
  label: string;
  loadingLabel: string;
  event: string;
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
        emit(host, event);
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

const ChipsRow = ({ host, alternates }: { host: HTMLElement; alternates: AlternatesView }) => {
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
              emit(host, 'trip-alternates', { intent } satisfies TripAlternatesDetail);
            }}
          >
            {msg(key)}
          </button>
        );
      })}
    </div>
  );
};

const AlternatesView = ({ host, alternates }: { host: HTMLElement; alternates: AlternatesView }) => {
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
                emit(host, 'trip-pin-alternate', { index } satisfies TripPinAlternateDetail);
              }}
            >
              {msg('pinButton', card.name)}
            </button>
            <button
              type="button"
              onClick={() => {
                emit(host, 'trip-plan-instead', { index } satisfies TripPlanInsteadDetail);
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

const CompareRow = ({ host, options }: { host: HTMLElement; options: CompareOptionView[] }) => {
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
          emit(host, 'trip-compare', { value: selectRef.current?.value ?? '' } satisfies TripCompareDetail);
        }}
      >
        {msg('compareGo')}
      </button>
    </div>
  );
};

const ResultView = ({
  host, place, lowConfidence, pinned, onDevice, compareOptions, alternates,
}: {
  host: HTMLElement;
  place: PlaceResult;
  lowConfidence: boolean;
  pinned: boolean;
  onDevice: boolean;
  compareOptions: CompareOptionView[];
  alternates: AlternatesView;
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
        onClick={() => emit(host, 'trip-pin')}
      >
        {msg('pinButton', place.placeName)}
      </button>
      <ChipsRow host={host} alternates={alternates} />
      <AlternatesView host={host} alternates={alternates} />
      {compareOptions.length > 0 ? <CompareRow host={host} options={compareOptions} /> : null}
      <details>
        <summary>{msg('notThisPlace')}</summary>
        <div className={styles['disagree-buttons']}>
          <button type="button" onClick={() => emit(host, 'trip-reanalyze')}>
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
  host, showLookAgain, fallback,
}: {
  host: HTMLElement;
  showLookAgain: boolean;
  fallback: { label: string; href: string } | null;
}) => (
  <>
    <h2 tabIndex={-1}>{msg('noPlaceTitle')}</h2>
    <p>{msg('noPlaceBody')}</p>
    {showLookAgain ? (
      <OneShotButton
        host={host}
        label={msg('lookAgainButton')}
        loadingLabel={msg('lookingAgainButton')}
        event="trip-look-again"
      />
    ) : null}
    {fallback ? <FallbackLine fallback={fallback} /> : null}
  </>
);

const ErrorView = ({
  host, title, body, showRetry, fallback, showFetchRetry, showNanoInstead,
}: {
  host: HTMLElement;
  title: string;
  body: string;
  showRetry: boolean;
  fallback: { label: string; href: string } | null;
  showFetchRetry: boolean;
  showNanoInstead: boolean;
}) => (
  <>
    <h2 tabIndex={-1}>{title}</h2>
    <p>{body}</p>
    {showRetry ? (
      <OneShotButton
        host={host}
        label={msg('retryButton')}
        loadingLabel={msg('retryingButton')}
        event="trip-retry"
      />
    ) : null}
    {showFetchRetry ? (
      <OneShotButton
        host={host}
        label={msg('fetchRetryButton')}
        loadingLabel={msg('fetchRetryLoading')}
        event="trip-fetch-retry"
      />
    ) : null}
    {showNanoInstead ? (
      <OneShotButton
        host={host}
        label={msg('nanoTryInstead')}
        loadingLabel={msg('nanoDownloading')}
        event="trip-nano"
      />
    ) : null}
    {fallback ? <FallbackLine fallback={fallback} /> : null}
  </>
);

// The epoch key remounts the whole view on every setCard call, so per-render
// state (one-shot buttons, rotation) resets exactly like the old rebuild.
const CardView = ({ host, state, epoch }: { host: HTMLElement; state: CardState; epoch: number }) => {
  switch (state.view) {
    case 'idle':
      return (
        <div key={epoch}>
          <IdleView hint={state.hint} shortcut={state.shortcut} />
        </div>
      );
    case 'loading':
      return (
        <div key={epoch}>
          <LoadingView />
        </div>
      );
    case 'result':
      return (
        <div key={epoch}>
          <ResultView
            host={host}
            place={state.place}
            lowConfidence={state.lowConfidence}
            pinned={state.pinned}
            onDevice={state.onDevice ?? false}
            compareOptions={state.compareOptions ?? []}
            alternates={state.alternates ?? { state: 'idle' }}
          />
        </div>
      );
    case 'no-place':
      return (
        <div key={epoch}>
          <NoPlaceView host={host} showLookAgain={state.showLookAgain} fallback={state.fallback} />
        </div>
      );
    case 'error':
      return (
        <div key={epoch}>
          <ErrorView
            host={host}
            title={state.title}
            body={state.body}
            showRetry={state.showRetry}
            fallback={state.fallback ?? null}
            showFetchRetry={state.showFetchRetry ?? false}
            showNanoInstead={state.showNanoInstead ?? false}
          />
        </div>
      );
    case 'itinerary':
      return (
        <div key={epoch}>
          <ItineraryView
            title={state.title}
            stops={state.stops}
            mapsUrl={state.mapsUrl}
            mapsLabel={state.mapsLabel}
          />
        </div>
      );
  }
};

export class TripCardElement extends HTMLElement {
  private root: Root | null = null;
  private epoch = 0;

  connectedCallback(): void {
    this.classList.add(styles.root);
    this.root ??= createRoot(this);
    this.render({ view: 'loading' });
  }

  disconnectedCallback(): void {
    this.root?.unmount();
    this.root = null;
  }

  setCard(state: CardState): void {
    this.epoch += 1;
    this.render(state);
  }

  focusHeading(): void {
    this.querySelector('h2')?.focus();
  }

  private render(state: CardState): void {
    if (this.root) {
      flushSync(() => {
        this.root?.render(<CardView host={this} state={state} epoch={this.epoch} />);
      });
    }
  }
}

if (!customElements.get('trip-card')) {
  customElements.define('trip-card', TripCardElement);
}
