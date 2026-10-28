import styles from './compare_table.module.css';
import { msg } from '../../utils/i18n';
import { DuelTableView } from './duel_table_view';

export interface DuelRowView {
  criterion: string;
  a: string;
  b: string;
}

export type DuelTableState =
  | { mode: 'loading'; a: string; b: string }
  | { mode: 'ready'; a: string; b: string; rows: DuelRowView[]; verdict: string }
  | { mode: 'error'; a: string; b: string };

interface Props {
  table: DuelTableState;
  onRetry: () => void;
  onCancel: () => void;
}

export const CompareTable = ({ table, onRetry, onCancel }: Props) => (
  <div className={styles.root}>
    {table.mode === 'error' ? (
      <div className={styles['duel-error']}>
        <p>{msg('duelError', [table.a, table.b])}</p>
        <button type="button" className={styles.primary} onClick={onRetry}>
          {msg('duelRetry')}
        </button>
      </div>
    ) : (
      <>
        <DuelTableView state={table} />
        {table.mode === 'loading' ? (
          <button type="button" onClick={onCancel}>
            {msg('cancelButton')}
          </button>
        ) : null}
      </>
    )}
  </div>
);
