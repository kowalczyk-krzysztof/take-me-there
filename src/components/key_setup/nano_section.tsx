import styles from './key_setup.module.css';
import { msg } from '../../utils/i18n';
import type { NanoSectionState } from './key_setup';

interface Props {
  nano: NanoSectionState;
  nanoInstead: boolean;
  nanoProgress: number | null;
  onNanoEnable: () => void;
}

export const NanoSection = ({ nano, nanoInstead, nanoProgress, onNanoEnable }: Props) => {
  if (nano === 'hidden') {
    return null;
  }
  if (nano === 'downloading') {
    return (
      <div className={styles['nano-section']}>
        <p className={styles.hint} id="nano-hint">{msg('nanoDownloadHint')}</p>
        <progress
          id="nano-progress"
          max={100}
          value={nanoProgress === null ? undefined : Math.min(1, Math.max(0, nanoProgress)) * 100}
          aria-label={msg('nanoDownloading')}
        />
      </div>
    );
  }
  return (
    <div className={styles['nano-section']}>
      <p className={styles.hint} id="nano-hint">{msg('nanoDownloadHint')}</p>
      {nano === 'failed' ? <p className={styles.error}>{msg('nanoDownloadFail')}</p> : null}
      <button
        type="button"
        className={styles.secondary}
        aria-describedby="nano-hint"
        onClick={onNanoEnable}
      >
        {msg(nanoInstead ? 'nanoTryInstead' : 'nanoTry')}
      </button>
    </div>
  );
};
