import styles from './trip_card.module.css';
import { msg } from '../../utils/i18n';
import type { AlternatesView, AlternateIntentView } from './trip_card';

interface Props {
  alternates: AlternatesView;
  onAlternates: (intent: AlternateIntentView) => void;
}

export const INTENT_KEYS: Record<AlternateIntentView, string> = {
  cheaper: 'alternatesCheaper',
  quieter: 'alternatesQuieter',
  similar: 'alternatesSimilar',
};

const INTENTS = Object.keys(INTENT_KEYS) as AlternateIntentView[];

export const ChipsRow = ({ alternates, onAlternates }: Props) => {
  const shown = alternates.state === 'idle' ? null : alternates.intent;

  return (
    <div className={styles['chips-row']}>
      <span className={styles['chips-label']}>{msg('alternatesLabel')}</span>
      {INTENTS.map((intent) => {
        const busy = alternates.state === 'loading' && alternates.intent === intent;
        const active = shown === intent;

        return (
          <button
            key={intent}
            type="button"
            className={active ? `${styles.chip} ${styles['chip-active']}` : styles.chip}
            data-intent={intent}
            aria-disabled={busy || undefined}
            onClick={() => {
              if (busy) {
                return;
              }
              onAlternates(intent);
            }}
          >
            {msg(INTENT_KEYS[intent])}
          </button>
        );
      })}
    </div>
  );
};
