// <compare-table>: the D3 destination-duel verdict table. Chrome (caption +
// column headers) renders immediately with three aria-hidden skeleton rows;
// the table carries aria-busy until real rows replace them, and is never a
// live region. Failures collapse to an inline error with a retry button so
// the result card the duel launched from stays intact.
import { adoptSharedStyles } from './shared_styles';
import elementCss from './compare_table.css?raw';

const msg = (key: string, subs?: string | string[]): string =>
  chrome.i18n.getMessage(key, subs);

export interface DuelRowView {
  criterion: string;
  a: string;
  b: string;
}

export class CompareTableElement extends HTMLElement {
  private root: ShadowRoot;
  private sideA = '';
  private sideB = '';

  constructor() {
    super();
    this.root = this.attachShadow({ mode: 'open' });
    adoptSharedStyles(this.root);
    const style = document.createElement('style');
    style.textContent = elementCss;
    this.root.append(style);
  }

  setLoading(a: string, b: string): void {
    this.sideA = a;
    this.sideB = b;
    this.renderTable(true, [], '');
  }

  setResults(a: string, b: string, rows: DuelRowView[], verdict: string): void {
    this.sideA = a;
    this.sideB = b;
    this.renderTable(false, rows, verdict);
  }

  setError(): void {
    for (const child of [...this.root.children]) {
      if (child.tagName !== 'STYLE') {
        child.remove();
      }
    }
    const wrap = document.createElement('div');
    wrap.className = 'duel-error';
    const text = document.createElement('p');
    text.textContent = msg('duelError', [this.sideA, this.sideB]);
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'primary';
    retry.textContent = msg('duelRetry');
    retry.addEventListener('click', () => {
      this.dispatchEvent(new CustomEvent('duel-retry', { bubbles: true, composed: true }));
    });
    wrap.append(text, retry);
    this.root.append(wrap);
  }

  private renderTable(loading: boolean, rows: DuelRowView[], verdict: string): void {
    for (const child of [...this.root.children]) {
      if (child.tagName !== 'STYLE') {
        child.remove();
      }
    }
    const table = document.createElement('table');
    table.setAttribute('aria-busy', String(loading));
    const caption = document.createElement('caption');
    caption.textContent = msg('duelCaption', [this.sideA, this.sideB]);
    table.append(caption);
    const head = document.createElement('thead');
    const headRow = document.createElement('tr');
    const corner = document.createElement('th');
    corner.setAttribute('scope', 'col');
    const colA = document.createElement('th');
    colA.setAttribute('scope', 'col');
    colA.textContent = this.sideA;
    const colB = document.createElement('th');
    colB.setAttribute('scope', 'col');
    colB.textContent = this.sideB;
    headRow.append(corner, colA, colB);
    head.append(headRow);
    table.append(head);
    const body = document.createElement('tbody');
    if (loading) {
      for (let i = 0; i < 3; i++) {
        const skeleton = document.createElement('tr');
        skeleton.setAttribute('aria-hidden', 'true');
        for (let c = 0; c < 3; c++) {
          const cell = document.createElement('td');
          cell.className = 'skeleton-block';
          skeleton.append(cell);
        }
        body.append(skeleton);
      }
    } else {
      for (const row of rows) {
        const tr = document.createElement('tr');
        const th = document.createElement('th');
        th.setAttribute('scope', 'row');
        th.textContent = row.criterion;
        const cellA = document.createElement('td');
        cellA.textContent = row.a;
        const cellB = document.createElement('td');
        cellB.textContent = row.b;
        tr.append(th, cellA, cellB);
        body.append(tr);
      }
      const verdictRow = document.createElement('tr');
      verdictRow.className = 'verdict';
      const verdictHead = document.createElement('th');
      verdictHead.setAttribute('scope', 'row');
      verdictHead.textContent = msg('duelVerdict');
      const verdictCell = document.createElement('td');
      verdictCell.setAttribute('colspan', '2');
      verdictCell.textContent = verdict;
      verdictRow.append(verdictHead, verdictCell);
      body.append(verdictRow);
    }
    table.append(body);
    this.root.append(table);
  }
}

if (!customElements.get('compare-table')) {
  customElements.define('compare-table', CompareTableElement);
}
