import { useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import styles from './trip_card.module.css';

interface Props {
  label: string;
  loadingLabel: string;
  onFire: () => void;
}

export const OneShotButton = ({ label, loadingLabel, onFire }: Props) => {
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
