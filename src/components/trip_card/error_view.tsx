import { msg } from '../../utils/i18n';
import type { TripCardCallbacks } from './trip_card';
import { OneShotButton } from './one_shot_button';
import { FallbackLine } from './fallback_line';

interface Props {
  title: string;
  body: string;
  showRetry: boolean;
  fallback: { label: string; href: string } | null;
  callbacks: Pick<TripCardCallbacks, 'onRetry' | 'onDismissError'>;
}

export const ErrorView = ({ title, body, showRetry, fallback, callbacks }: Props) => {
  const hasAction = showRetry || fallback !== null;

  return (
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
      {fallback ? <FallbackLine fallback={fallback} /> : null}
      {hasAction ? null : (
        <button type="button" onClick={callbacks.onDismissError}>
          {msg('dismissErrorButton')}
        </button>
      )}
    </>
  );
};
