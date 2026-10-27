import styles from './compare_table.module.css';
import { msg } from '../../utils/i18n';
import type { DuelTableState } from './compare_table';

interface Props {
  state: Extract<DuelTableState, { mode: 'loading' | 'ready' }>;
}

export const DuelTableView = ({ state }: Props) => (
  <table aria-busy={state.mode === 'loading'}>
    <caption>{msg('duelCaption', [state.a, state.b])}</caption>
    <thead>
      <tr>
        <th scope="col" />
        <th scope="col">{state.a}</th>
        <th scope="col">{state.b}</th>
      </tr>
    </thead>
    <tbody>
      {state.mode === 'loading'
        ? [0, 1, 2].map((row) => (
          <tr key={row} aria-hidden="true">
            {[0, 1, 2].map((cell) => (
              <td key={cell} className="skeleton-block" />
            ))}
          </tr>
        ))
        : (
          <>
            {state.rows.map((row) => (
              <tr key={row.criterion}>
                <th scope="row">{row.criterion}</th>
                <td>{row.a}</td>
                <td>{row.b}</td>
              </tr>
            ))}
            <tr className={styles.verdict}>
              <th scope="row">{msg('duelVerdict')}</th>
              <td colSpan={2}>{state.verdict}</td>
            </tr>
          </>
        )}
    </tbody>
  </table>
);
