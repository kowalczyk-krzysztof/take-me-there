import { msg } from '../../utils/i18n';
import { OneShotButton } from './one_shot_button';
import { FallbackLine } from './fallback_line';

interface Props {
  showLookAgain: boolean;
  fallback: { label: string; href: string } | null;
  onLookAgain: () => void;
}

export const NoPlaceView = ({ showLookAgain, fallback, onLookAgain }: Props) => (
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
