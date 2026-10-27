import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import styles from './compare_table.module.css';
import { msg } from '../utils/i18n';
import { emit } from '../utils/events';


export interface DuelRowView {
  criterion: string;
  a: string;
  b: string;
}

type DuelState =
  | { mode: 'loading'; a: string; b: string }
  | { mode: 'ready'; a: string; b: string; rows: DuelRowView[]; verdict: string }
  | { mode: 'error'; a: string; b: string };

const DuelTable = ({ state }: { state: Extract<DuelState, { mode: 'loading' | 'ready' }> }) => (
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

export class CompareTableElement extends HTMLElement {
  private root: Root | null = null;
  private state: DuelState = { mode: 'loading', a: '', b: '' };

  connectedCallback(): void {
    this.classList.add(styles.root);
    this.root ??= createRoot(this);
    this.render();
  }

  disconnectedCallback(): void {
    this.root?.unmount();
    this.root = null;
  }

  setLoading(a: string, b: string): void {
    this.state = { mode: 'loading', a, b };
    this.render();
  }

  setResults(a: string, b: string, rows: DuelRowView[], verdict: string): void {
    this.state = { mode: 'ready', a, b, rows, verdict };
    this.render();
  }

  setError(): void {
    this.state = { mode: 'error', a: this.state.a, b: this.state.b };
    this.render();
  }

  private render(): void {
    if (this.root) {
      const host = this;
      const state = this.state;
      flushSync(() => {
        this.root?.render(
          state.mode === 'error' ? (
            <div className={styles['duel-error']}>
              <p>{msg('duelError', [state.a, state.b])}</p>
              <button type="button" className={styles.primary} onClick={() => emit(host, 'duel-retry')}>
                {msg('duelRetry')}
              </button>
            </div>
          ) : (
            <DuelTable state={state} />
          ),
        );
      });
    }
  }
}

if (!customElements.get('compare-table')) {
  customElements.define('compare-table', CompareTableElement);
}
