import { useEffect, useState } from 'react';
import { prefersReducedMotion } from '../../utils/dom';
import styles from './trip_card.module.css';
import { msg } from '../../utils/i18n';

const LOADING_LINES = ['loadingReading', 'loadingIdentifying', 'loadingWriting'];
const ROTATE_MS = 2500;

export const LoadingView = () => {
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
