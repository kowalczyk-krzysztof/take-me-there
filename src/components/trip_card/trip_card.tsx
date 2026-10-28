import { useRef, useState, type ReactNode } from 'react';
import type { PlaceResult } from '../../types';
import styles from './trip_card.module.css';
import { IdleView } from './idle_view';
import { LoadingView } from './loading_view';
import { ResultView } from './result_view';
import { ItineraryView } from './itinerary_view';
import { NoPlaceView } from './no_place_view';
import { ErrorView } from './error_view';

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

export type PlanState = 'idle' | 'planning' | 'ready' | 'interrupted';

export interface TripCardCallbacks {
  onPin: () => void;
  onPlanTrip: () => void;
  onReanalyze: () => void;
  onRetry: () => void;
  onFetchRetry: () => void;
  onLookAgain: () => void;
  onAlternates: (intent: AlternateIntentView) => void;
  onCompare: (value: string) => void;
  onPinAlternate: (index: number) => void;
  onPlanInstead: (index: number) => void;
  onCancelAlternates: () => void;
}

export type CardState =
  | { view: 'idle'; hint: string; shortcut: string }
  | { view: 'loading' }
  | {
      view: 'result';
      place: PlaceResult;
      lowConfidence: boolean;
      pinned: boolean;
      planState: PlanState;
      canReanalyze: boolean;
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
    }
  | {
      view: 'itinerary';
      title: string;
      stops: ItineraryStopView[];
      mapsUrl: string | null;
      mapsLabel: string;
    };

interface Props {
  card: CardState;
  callbacks: TripCardCallbacks;
}

export const TripCard = ({ card, callbacks }: Props) => {
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
          planState={card.planState}
          canReanalyze={card.canReanalyze}
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
