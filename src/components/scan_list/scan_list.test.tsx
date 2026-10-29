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
    pinned: false,
  },
  { placeName: 'Fira', country: 'Greece', title: 'Fira, Greece', image: null, pinned: true },
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
    const root = renderSync(
      <ScanList
        loading={true}
        items={[]}
        onGuide={noop}
        onPin={noop}
        onPinSelected={noop}
        onCancel={noop}
      />
    ).container;
    expect(root.querySelector('h2')?.textContent).toBe('scanTitle');

    const grid = root.querySelector('.skeleton-grid');
    expect(grid?.getAttribute('aria-hidden')).toBe('true');
    expect(grid?.querySelectorAll('.scan-card').length).toBe(3);
    expect(grid?.querySelectorAll('.skeleton-block').length).toBe(9);
    expect(root.querySelector('section')?.getAttribute('aria-busy')).toBe('true');
  });

  it('offers cancel while loading and hides it with results', () => {
    const onCancel = vi.fn();

    const rendered = renderSync(
      <ScanList
        loading={true}
        items={[]}
        onGuide={noop}
        onPin={noop}
        onPinSelected={noop}
        onCancel={onCancel}
      />
    );
    const cancel = rendered.container.querySelector('section > button') as HTMLButtonElement;
    expect(cancel?.textContent).toBe('cancelButton');
    cancel.click();
    expect(onCancel).toHaveBeenCalledTimes(1);

    rendered.rerender(
      <ScanList
        loading={false}
        items={ITEMS}
        onGuide={noop}
        onPin={noop}
        onPinSelected={noop}
        onCancel={onCancel}
      />
    );
    expect(
      [...rendered.container.querySelectorAll('section > button')].some(
        (button) => button.textContent === 'cancelButton'
      )
    ).toBe(false);
  });

  it('shows saved pins as disabled with pressed state', () => {
    const root = renderSync(
      <ScanList
        loading={false}
        items={ITEMS}
        onGuide={noop}
        onPin={noop}
        onPinSelected={noop}
        onCancel={noop}
      />
    ).container;

    const pins = [...root.querySelectorAll('.scan-card .pin-button')] as HTMLButtonElement[];
    expect(pins).toHaveLength(2);
    expect(pins[0].textContent).toBe('pinButton(Oia)');
    expect(pins[0].getAttribute('aria-pressed')).toBe('false');
    expect(pins[0].disabled).toBe(false);
    expect(pins[1].textContent).toBe('savedButton(Fira)');
    expect(pins[1].getAttribute('aria-pressed')).toBe('true');
    expect(pins[1].disabled).toBe(true);
  });

  it('renders a no-skeleton shadow after results arrive', () => {
    const rendered = renderSync(
      <ScanList
        loading={true}
        items={[]}
        onGuide={noop}
        onPin={noop}
        onPinSelected={noop}
        onCancel={noop}
      />
    );
    rendered.rerender(
      <ScanList
        loading={false}
        items={ITEMS}
        onGuide={noop}
        onPin={noop}
        onPinSelected={noop}
        onCancel={noop}
      />
    );

    const root = rendered.container;
    expect(root.querySelector('.skeleton-grid')).toBeNull();
    expect(root.querySelector('section')?.getAttribute('aria-busy')).toBe('false');
    expect(root.querySelectorAll('.scan-card').length).toBe(2);

    const list = root.querySelector('ul.scan-results') as HTMLElement;
    expect(list.children).toHaveLength(2);
    expect(list.children[0].tagName).toBe('LI');
  });

  it('renders cards with group labels and three sibling controls', () => {
    const root = renderSync(
      <ScanList
        loading={false}
        items={ITEMS}
        onGuide={noop}
        onPin={noop}
        onPinSelected={noop}
        onCancel={noop}
      />
    ).container;

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
    const root = renderSync(
      <ScanList
        loading={false}
        items={ITEMS}
        onGuide={noop}
        onPin={noop}
        onPinSelected={noop}
        onCancel={noop}
      />
    ).container;

    const cards = root.querySelectorAll('.scan-card');

    const img = cards[0]?.querySelector('img');
    expect(img?.getAttribute('alt')).toBe('');
    expect(img?.getAttribute('src')).toBe('https://img/oia.jpg');
    expect(cards[1]?.querySelector('img')).toBeNull();

    const placeholder = cards[1]?.querySelector('.thumb-placeholder');
    expect(placeholder?.getAttribute('aria-hidden')).toBe('true');
  });

  it('emits guide and pin events per card', () => {
    const onGuide = vi.fn();

    const onPin = vi.fn();

    const root = renderSync(
      <ScanList
        loading={false}
        items={ITEMS}
        onGuide={onGuide}
        onPin={onPin}
        onPinSelected={noop}
        onCancel={noop}
      />
    ).container;

    const cards = root.querySelectorAll('.scan-card');
    (cards[1]?.querySelectorAll('button')[0] as HTMLButtonElement).click();
    (cards[0]?.querySelectorAll('button')[1] as HTMLButtonElement).click();
    expect(onGuide).toHaveBeenCalledWith(1);
    expect(onPin).toHaveBeenCalledWith(0);
  });

  it('counts checked cards in pin-selected and survives re-render', () => {
    const i18n = vi.spyOn(chrome.i18n, 'getMessage');

    const onPinSelected = vi.fn();

    const rendered = renderSync(
      <ScanList
        loading={false}
        items={ITEMS}
        onGuide={noop}
        onPin={noop}
        onPinSelected={onPinSelected}
        onCancel={noop}
      />
    );

    const root = rendered.container;

    const boxes = root.querySelectorAll('input[type="checkbox"]');
    (boxes[0] as HTMLInputElement).click();
    (boxes[1] as HTMLInputElement).click();
    expect(i18n).toHaveBeenLastCalledWith('scanPinSelected', '2');
    // Re-render (e.g. after a single pin) keeps the checked titles.
    rendered.rerender(
      <ScanList
        loading={false}
        items={[{ ...ITEMS[0]!, pinned: true }, ITEMS[1]!]}
        onGuide={noop}
        onPin={noop}
        onPinSelected={onPinSelected}
        onCancel={noop}
      />
    );
    expect(i18n).toHaveBeenLastCalledWith('scanPinSelected', '2');
    (root.querySelector('.pin-selected') as HTMLButtonElement).click();
    expect(onPinSelected).toHaveBeenCalledWith([0, 1]);
  });

  it('ignores pin-selected with nothing checked', () => {
    const onPinSelected = vi.fn();

    const root = renderSync(
      <ScanList
        loading={false}
        items={ITEMS}
        onGuide={noop}
        onPin={noop}
        onPinSelected={onPinSelected}
        onCancel={noop}
      />
    ).container;
    (root.querySelector('.pin-selected') as HTMLButtonElement).click();
    expect(onPinSelected).not.toHaveBeenCalled();
  });
});
