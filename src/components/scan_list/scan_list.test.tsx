import { clickEl } from '../../test/helpers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScanList, type ScanItemView } from './scan_list';
import { installChromeMock, uninstallChromeMock } from '../../test/chrome_mock';
import { renderSync } from '../../test/render_sync';

const ITEMS: ScanItemView[] = [
  {
    placeName: 'Oia',
    country: 'Greece',
    title: 'Oia, Greece',
    image: 'https://img/oia.jpg',
  },
  { placeName: 'Fira', country: 'Greece', title: 'Fira, Greece', image: null },
];

const noop = () => {};

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
    const root = renderSync(<ScanList loading={true} items={[]} onCancel={noop} />).container;
    expect(root.querySelector('h2')?.textContent).toBe('scanTitle');

    const grid = root.querySelector('.skeleton-grid');
    expect(grid?.getAttribute('aria-hidden')).toBe('true');
    expect(grid?.querySelectorAll('.scan-card').length).toBe(3);
    expect(grid?.querySelectorAll('.skeleton-block').length).toBe(9);
    expect(root.querySelector('section')?.getAttribute('aria-busy')).toBe('true');
  });

  it('offers cancel while loading and hides it with results', () => {
    const onCancel = vi.fn();

    const rendered = renderSync(<ScanList loading={true} items={[]} onCancel={onCancel} />);
    const cancel = rendered.container.querySelector('section > button') as HTMLButtonElement;
    expect(cancel?.textContent).toBe('cancelButton');
    clickEl(cancel);
    expect(onCancel).toHaveBeenCalledTimes(1);

    rendered.rerender(<ScanList loading={false} items={ITEMS} onCancel={onCancel} />);
    expect(
      [...rendered.container.querySelectorAll('section > button')].some(
        (button) => button.textContent === 'cancelButton'
      )
    ).toBe(false);
  });

  it('renders a no-skeleton shadow after results arrive', () => {
    const rendered = renderSync(<ScanList loading={true} items={[]} onCancel={noop} />);
    rendered.rerender(<ScanList loading={false} items={ITEMS} onCancel={noop} />);

    const root = rendered.container;
    expect(root.querySelector('.skeleton-grid')).toBeNull();
    expect(root.querySelector('section')?.getAttribute('aria-busy')).toBe('false');
    expect(root.querySelectorAll('.scan-card').length).toBe(2);

    const list = root.querySelector('ul.scan-results') as HTMLElement;
    expect(list.children).toHaveLength(2);
    expect(list.children[0].tagName).toBe('LI');
  });

  it('renders cards with group labels and titles', () => {
    const root = renderSync(<ScanList loading={false} items={ITEMS} onCancel={noop} />).container;

    const cards = root.querySelectorAll('.scan-card');
    expect(cards[0]?.getAttribute('role')).toBe('group');
    expect(cards[0]?.getAttribute('aria-label')).toBe('Oia, Greece');
    expect(cards[0]?.querySelector('.scan-title')?.textContent).toBe('Oia, Greece');
    expect(cards[0]?.querySelectorAll('button')).toHaveLength(0);
    // No card-wide click wrapper: no parent of the content handles clicks.
    expect((cards[0] as HTMLElement).onclick).toBeNull();
  });

  it('renders decorative thumbnails with a placeholder fallback', () => {
    const root = renderSync(<ScanList loading={false} items={ITEMS} onCancel={noop} />).container;

    const cards = root.querySelectorAll('.scan-card');

    const img = cards[0]?.querySelector('img');
    expect(img?.getAttribute('alt')).toBe('');
    expect(img?.getAttribute('src')).toBe('https://img/oia.jpg');
    expect(cards[1]?.querySelector('img')).toBeNull();

    const placeholder = cards[1]?.querySelector('.thumb-placeholder');
    expect(placeholder?.getAttribute('aria-hidden')).toBe('true');
  });
});
