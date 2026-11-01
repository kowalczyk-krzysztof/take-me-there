import styles from './trip_card.module.css';
import { msg } from '../../utils/i18n';
import type { LoadingPhase } from './trip_card';

const PHASE_KEYS: Record<LoadingPhase, string> = {
  collecting: 'loadingPhaseCollecting',
  identifying: 'loadingPhaseIdentifying',
};

interface Props {
  phase: LoadingPhase;
  onCancel: () => void;
}

export const LoadingView = ({ phase, onCancel }: Props) => (
  <>
    <div className={styles.skeleton} aria-hidden="true">
      {['60%', '40%', '100%', '100%'].map((width, index) => (
        <div key={index} className="skeleton-block" style={{ width }} />
      ))}
      <p className={styles.cosmetic}>{msg(PHASE_KEYS[phase])}</p>
    </div>
    <button type="button" className={styles['cancel-button']} onClick={onCancel}>
      {msg('cancelButton')}
    </button>
  </>
);
