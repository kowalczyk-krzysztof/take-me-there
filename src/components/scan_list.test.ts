// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import './scan_list';
import type { ScanItemView } from './scan_list';
import { installChromeMock, uninstallChromeMock } from '../test/chrome_mock';

const mount = () => {
  const el = document.createElement('scan-list');
  document.body.append(el);
  return { el: el as unknown as import('./scan_list').ScanListElement, root: el };
};

const ITEMS: ScanItemView[] = [
  { placeName: 'Oia', country: 'Greece', title: 'Oia, Greece', image: 'https://img/oia.jpg', pinned: false },
  { placeName: 'Fira', country: 'Greece', title: 'Fira, Greece', image: null, pinned: true },
];

beforeEach(() => {
  installChromeMock();
  document.body.innerHTML = '';
});

afterEach(() => {
  document.body.innerHTML = '';
  uninstallChromeMock();
});

describe('scan-list', () => {
  it('renders an aria-hidden skeleton while loading', () => {
    const { root } = mount();
    (root as unknown as { setLoading: () => void }).setLoading();
    expect(root.querySelector('h2')?.textContent).toBe('scanTitle');
    const grid = root.querySelector('.skeleton-grid');
    expect(grid?.getAttribute('aria-hidden')).toBe('true');
    expect(grid?.querySelectorAll('.skeleton-block').length).toBe(6);
    expect(root.querySelector('section')?.getAttribute('aria-busy')).toBe('true');
  });

  it('renders a no-skeleton shadow after results arrive', () => {
    const { el, root } = mount();
    el.setLoading();
    el.setResults(ITEMS);
    expect(root.querySelector('.skeleton-grid')).toBeNull();
    expect(root.querySelector('section')?.getAttribute('aria-busy')).toBe('false');
    expect(root.querySelectorAll('.scan-card').length).toBe(2);
  });

  it('renders cards with group labels and three sibling controls', () => {
    const { el, root } = mount();
    el.setResults(ITEMS);
    const cards = root.querySelectorAll('.scan-card');
    expect(cards[0]?.getAttribute('role')).toBe('group');
    expect(cards[0]?.getAttribute('aria-label')).toBe('Oia, Greece');
    const box = cards[0]?.querySelector('input[type="checkbox"]');
    expect(box).not.toBeNull();
    expect(cards[0]?.querySelector('label')?.textContent).toBe('Oia, Greece');
    const buttons = cards[0]?.querySelectorAll('button');
    expect(buttons?.length).toBe(2);
    // No card-wide click wrapper: no parent of the controls handles clicks.
    expect((cards[0] as HTMLElement).onclick).toBeNull();
    expect(cards[0]?.querySelector('.pin-button')?.getAttribute('aria-pressed')).toBe('false');
    expect(cards[1]?.querySelector('.pin-button')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('renders decorative thumbnails with a placeholder fallback', () => {
    const { el, root } = mount();
    el.setResults(ITEMS);
    const cards = root.querySelectorAll('.scan-card');
    const img = cards[0]?.querySelector('img');
    expect(img?.getAttribute('alt')).toBe('');
    expect(img?.getAttribute('src')).toBe('https://img/oia.jpg');
    expect(cards[1]?.querySelector('img')).toBeNull();
    const placeholder = cards[1]?.querySelector('.thumb-placeholder');
    expect(placeholder?.getAttribute('aria-hidden')).toBe('true');
  });

  it('emits guide and pin events per card', () => {
    const { el, root } = mount();
    el.setResults(ITEMS);
    const guide = vi.fn();
    const pin = vi.fn();
    el.addEventListener('scan-guide', (event) => guide((event as CustomEvent).detail));
    el.addEventListener('scan-pin', (event) => pin((event as CustomEvent).detail));
    const cards = root.querySelectorAll('.scan-card');
    (cards[1]?.querySelectorAll('button')[0] as HTMLButtonElement).click();
    (cards[0]?.querySelectorAll('button')[1] as HTMLButtonElement).click();
    expect(guide).toHaveBeenCalledWith({ index: 1 });
    expect(pin).toHaveBeenCalledWith({ index: 0 });
  });

  it('counts checked cards in pin-selected and survives re-render', () => {
    const { el, root } = mount();
    const i18n = vi.spyOn(chrome.i18n, 'getMessage');
    el.setResults(ITEMS);
    const pinSelected = vi.fn();
    el.addEventListener('scan-pin-selected', (event) => pinSelected((event as CustomEvent).detail));
    const boxes = root.querySelectorAll('input[type="checkbox"]');
    (boxes[0] as HTMLInputElement).click();
    (boxes[1] as HTMLInputElement).click();
    expect(i18n).toHaveBeenLastCalledWith('scanPinSelected', '2');
    // Re-render (e.g. after a single pin) keeps the checked titles.
    el.setResults([{ ...ITEMS[0]!, pinned: true }, ITEMS[1]!]);
    expect(i18n).toHaveBeenLastCalledWith('scanPinSelected', '2');
    (root.querySelector('.pin-selected') as HTMLButtonElement).click();
    expect(pinSelected).toHaveBeenCalledWith({ indices: [0, 1] });
  });

  it('ignores pin-selected with nothing checked', () => {
    const { el, root } = mount();
    el.setResults(ITEMS);
    const pinSelected = vi.fn();
    el.addEventListener('scan-pin-selected', pinSelected);
    (root.querySelector('.pin-selected') as HTMLButtonElement).click();
    expect(pinSelected).not.toHaveBeenCalled();
  });
});
