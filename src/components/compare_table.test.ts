// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import './compare_table';
import type { CompareTableElement, DuelRowView } from './compare_table';
import { installChromeMock, uninstallChromeMock } from '../test/chrome_mock';

const mount = (): { el: CompareTableElement; root: ShadowRoot } => {
  const el = document.createElement('compare-table') as CompareTableElement;
  document.body.append(el);
  return { el, root: el.shadowRoot as ShadowRoot };
};

const ROWS: DuelRowView[] = [
  { criterion: 'Cost', a: 'Pricey sunsets.', b: 'Cheaper stays.' },
  { criterion: 'Crowds', a: 'Packed.', b: 'Calm.' },
];

beforeEach(() => {
  installChromeMock();
  document.body.innerHTML = '';
});

afterEach(() => {
  document.body.innerHTML = '';
  uninstallChromeMock();
});

describe('compare-table', () => {
  it('renders chrome with aria-hidden skeleton rows while loading', () => {
    const { el, root } = mount();
    el.setLoading('Oia, Greece', 'Fira, Greece');
    const table = root.querySelector('table');
    expect(table?.getAttribute('aria-busy')).toBe('true');
    expect(table?.querySelector('caption')?.textContent).toBe('duelCaption');
    const cols = table?.querySelectorAll('thead th');
    expect(cols).toHaveLength(3);
    expect(cols?.[0]?.textContent).toBe('');
    expect(cols?.[1]?.textContent).toBe('Oia, Greece');
    expect(cols?.[2]?.getAttribute('scope')).toBe('col');
    const skeletons = table?.querySelectorAll('tbody tr');
    expect(skeletons).toHaveLength(3);
    for (const row of skeletons ?? []) {
      expect(row.getAttribute('aria-hidden')).toBe('true');
      expect(row.querySelector('th')).toBeNull();
      const cells = row.querySelectorAll('td');
      expect(cells).toHaveLength(3);
      for (const cell of cells) {
        expect(cell.textContent).toBe('');
        expect(cell.classList.contains('skeleton-block')).toBe(true);
      }
    }
  });

  it('replaces skeletons with row-headed results and a verdict row', () => {
    const { el, root } = mount();
    el.setLoading('Oia, Greece', 'Fira, Greece');
    el.setResults('Oia, Greece', 'Fira, Greece', ROWS, 'Pick Oia for views.');
    const table = root.querySelector('table');
    expect(table?.getAttribute('aria-busy')).toBe('false');
    expect(table?.querySelector('.skeleton-block')).toBeNull();
    const rows = table?.querySelectorAll('tbody tr');
    expect(rows).toHaveLength(3);
    const firstHead = rows?.[0]?.querySelector('th');
    expect(firstHead?.getAttribute('scope')).toBe('row');
    expect(firstHead?.textContent).toBe('Cost');
    expect(rows?.[0]?.querySelectorAll('td')[1]?.textContent).toBe('Cheaper stays.');
    const verdict = rows?.[2];
    expect(verdict?.querySelector('th')?.textContent).toBe('duelVerdict');
    const verdictCell = verdict?.querySelector('td');
    expect(verdictCell?.getAttribute('colspan')).toBe('2');
    expect(verdictCell?.textContent).toBe('Pick Oia for views.');
  });

  it('collapses to an inline error with retry', () => {
    const { el, root } = mount();
    el.setLoading('Oia, Greece', 'Fira, Greece');
    el.setError();
    expect(root.querySelector('table')).toBeNull();
    expect(root.querySelector('.duel-error p')?.textContent).toBe('duelError');
    expect(root.querySelector('.duel-error button')?.textContent).toBe('duelRetry');
    const retry = vi.fn();
    el.addEventListener('duel-retry', retry);
    (root.querySelector('.duel-error button') as HTMLButtonElement).click();
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
