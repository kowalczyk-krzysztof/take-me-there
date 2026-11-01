import { useRef, useState, type ReactNode } from 'react';
import type { PlaceResult } from '../../types';
import styles from './trip_card.module.css';
import { IdleView } from './idle_view';
import { LoadingView } from './loading_view';
import { ResultView } from './result_view';
import { NoPlaceView } from './no_place_view';
import { ErrorView } from './error_view';

export interface ConfidenceView {
  line: string;
  showScale: boolean;
}

export type AlternateIntentView = 'cheaper' | 'quieter' | 'similar';

export interface AlternateCardView {
  name: string;
  why: string;
  bestMonth: string;
}

export type AlternatesView =
  | { state: 'idle' }
  | { state: 'loading'; intent: AlternateIntentView }
  | { state: 'ready'; intent: AlternateIntentView; cards: AlternateCardView[] };

export type LoadingPhase = 'collecting' | 'identifying';

export interface TripCardCallbacks {
  onReanalyze: () => void;
  onRetry: () => void;
  onLookAgain: () => void;
  onAlternates: (intent: AlternateIntentView) => void;
  onCancelAlternates: () => void;
  onCancelLoading: () => void;
  onDismissError: () => void;
}

export type CardState =
  | { view: 'idle'; hint: string }
  | { view: 'loading'; phase: LoadingPhase }
  | {
      view: 'result';
      place: PlaceResult;
      lowConfidence: boolean;
      canReanalyze: boolean;
      confidence: ConfidenceView;
      sourceHost: string | null;
      alternates?: AlternatesView;
    }
  | { view: 'no-place'; showLookAgain: boolean; fallback: { label: string; href: string } | null }
  | {
      view: 'error';
      title: string;
      body: string;
      showRetry: boolean;
      fallback?: { label: string; href: string } | null;
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
      view = <IdleView hint={card.hint} />;

      break;
    case 'loading':
      view = <LoadingView phase={card.phase} onCancel={callbacks.onCancelLoading} />;

      break;
    case 'result':
      view = (
        <ResultView
          place={card.place}
          lowConfidence={card.lowConfidence}
          canReanalyze={card.canReanalyze}
          confidence={card.confidence}
          sourceHost={card.sourceHost}
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
          callbacks={callbacks}
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
