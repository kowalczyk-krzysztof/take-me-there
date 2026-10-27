import styles from './trip_card.module.css';
import { msg } from '../../utils/i18n';
import type { AlternatesView, AlternateIntentView } from './trip_card';

interface Props {
  alternates: AlternatesView;
  onAlternates: (intent: AlternateIntentView) => void;
}

export const ChipsRow = ({ alternates, onAlternates }: Props) => {
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
              onAlternates(intent);
            }}
          >
            {msg(key)}
          </button>
        );
      })}
    </div>
  );
};
