// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import './trip_board';
import type { BoardItemView, TripBoardElement, TripRemovePinDetail } from './trip_board';
import { installChromeMock, uninstallChromeMock } from '../test/chrome_mock';

const mount = (): TripBoardElement => {
  const el = document.createElement('trip-board') as TripBoardElement;
  document.body.append(el);
  return el;
};

const ITEMS: BoardItemView[] = [
  { placeName: 'Oia', country: 'Greece', title: 'Oia, Greece', host: 'example.com', image: 'data:image/jpeg,aaa' },
  { placeName: 'Fira', country: 'Greece', title: 'Fira, Greece', host: 'blog.example', image: null },
];

beforeEach(() => {
  installChromeMock();
  document.body.innerHTML = '';
});

afterEach(() => {
  document.body.innerHTML = '';
  uninstallChromeMock();
});

describe('trip-board', () => {
  it('renders the labeled collapsible list with remove buttons', () => {
    const el = mount();
    const root = el;
    el.setBoard(ITEMS, true);
    const toggle = root.querySelector('.disclosure') as HTMLButtonElement;
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.textContent).toBe('boardTitle');
    const list = root.querySelector('ul');
    expect(list?.getAttribute('aria-labelledby')).toBe('board-heading');
    const entries = [...root.querySelectorAll('li')];
    expect(entries).toHaveLength(2);
    expect(entries[0].querySelector('.item-name')?.textContent).toBe('Oia, Greece');
    expect(entries[0].querySelector('.item-host')?.textContent).toBe('example.com');
    const thumb = entries[0].querySelector('img');
    expect(thumb?.getAttribute('src')).toBe('data:image/jpeg,aaa');
    expect(thumb?.alt).toBe('');
    expect(entries[1].querySelector('img')).toBeNull();
    const detail = vi.fn();
    el.addEventListener('trip-remove-pin', (event) => detail((event as CustomEvent).detail));
    (entries[0].querySelector('button') as HTMLButtonElement).click();
    expect(detail).toHaveBeenCalledWith({
      placeName: 'Oia',
      country: 'Greece',
    } satisfies TripRemovePinDetail);
    toggle.click();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(root.querySelector('.board-body')?.hasAttribute('hidden')).toBe(true);
  });

  it('shows the empty state without a clear button', () => {
    const el = mount();
    const root = el;
    el.setBoard([], false);
    expect(root.querySelector('.empty')?.textContent).toBe('boardEmpty');
    expect(root.querySelector('ul')).toBeNull();
    expect(root.querySelector('.clear-button')).toBeNull();
  });

  it('disables planning with an adjacent explanation under two pins', () => {
    const el = mount();
    const root = el;
    el.setBoard([ITEMS[0]], false);
    const plan = root.querySelector('.plan-button') as HTMLButtonElement;
    expect(plan.getAttribute('aria-disabled')).toBe('true');
    expect(root.querySelector('.plan-note')?.textContent).toBe('boardPlanNote');
    const fired = vi.fn();
    el.addEventListener('trip-plan', fired);
    plan.click();
    expect(fired).not.toHaveBeenCalled();
    el.setBoard(ITEMS, true);
    const enabled = root.querySelector('.plan-button') as HTMLButtonElement;
    expect(enabled.hasAttribute('aria-disabled')).toBe(false);
    expect(root.querySelector('.plan-note')).toBeNull();
    enabled.click();
    expect(fired).toHaveBeenCalledTimes(1);
  });

  it('confirms clearing inline with focus on the heading', () => {
    const el = mount();
    const root = el;
    el.setBoard(ITEMS, true);
    (root.querySelector('.clear-button') as HTMLButtonElement).click();
    const heading = root.querySelector('.confirm-heading') as HTMLHeadingElement;
    expect(heading.textContent).toBe('boardClearTitle');
    expect(document.activeElement).toBe(heading);
    const fired = vi.fn();
    el.addEventListener('trip-clear-confirm', fired);
    const [confirm, cancel] = [...root.querySelectorAll('.confirm-actions button')] as HTMLButtonElement[];
    cancel.click();
    expect(fired).not.toHaveBeenCalled();
    expect(root.querySelector('ul')).not.toBeNull();
    expect(document.activeElement?.className).toContain('clear-button');
    (root.querySelector('.clear-button') as HTMLButtonElement).click();
    (root.querySelectorAll('.confirm-actions button')[0] as HTMLButtonElement).click();
    expect(confirm).not.toBeNull();
    expect(fired).toHaveBeenCalledTimes(1);
  });

  it('shows the pin-failure notice with a retry action', () => {
    const el = mount();
    const root = el;
    el.setBoard(ITEMS, true);
    el.setNotice('boardNoticePinFail', true);
    const notice = root.querySelector('.notice') as HTMLElement;
    expect(notice.hidden).toBe(false);
    expect(notice.textContent).toContain('boardNoticePinFail');
    const fired = vi.fn();
    el.addEventListener('trip-retry-pin', fired);
    (notice.querySelector('button') as HTMLButtonElement).click();
    expect(fired).toHaveBeenCalledTimes(1);
    el.setNotice(null, false);
    expect(notice.hidden).toBe(true);
  });

  it('repairs focus to the disclosure when a re-render removes it', () => {
    const el = mount();
    const root = el;
    el.setBoard(ITEMS, true);
    const remove = root.querySelector('li button') as HTMLButtonElement;
    remove.focus();
    el.setBoard([ITEMS[1]], false);
    expect(document.activeElement?.className).toContain('disclosure');
  });
});
