import { clickEl, focusEl } from '../../test/helpers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TripBoard,
  type BoardItemView,
  type BoardNoticeView,
  type TripMovePinDetail,
  type TripRemovePinDetail,
} from './trip_board';
import { installChromeMock, uninstallChromeMock } from '../../test/chrome_mock';
import { renderSync } from '../../test/render_sync';

const ITEMS: BoardItemView[] = [
  {
    placeName: 'Oia',
    country: 'Greece',
    title: 'Oia, Greece',
    host: 'example.com',
    image: 'data:image/jpeg,aaa',
    canMoveUp: false,
    canMoveDown: true,
  },
  {
    placeName: 'Fira',
    country: 'Greece',
    title: 'Fira, Greece',
    host: 'blog.example',
    image: null,
    canMoveUp: true,
    canMoveDown: false,
  },
];

const NOTICE_OFF: BoardNoticeView = { text: null, retryLabel: null };

const renderBoard = (
  items: BoardItemView[],
  canPlan: boolean,
  callbacks: {
    onRemovePin?: (detail: TripRemovePinDetail) => void;
    onMovePin?: (detail: TripMovePinDetail) => void;
    onPlan?: () => void;
    onClearConfirm?: () => void;
    onRetryPin?: () => void;
  } = {},
  notice: BoardNoticeView = NOTICE_OFF
) =>
  renderSync(
    <TripBoard
      items={items}
      canPlan={canPlan}
      notice={notice}
      onRemovePin={callbacks.onRemovePin ?? (() => {})}
      onMovePin={callbacks.onMovePin ?? (() => {})}
      onPlan={callbacks.onPlan ?? (() => {})}
      onClearConfirm={callbacks.onClearConfirm ?? (() => {})}
      onRetryPin={callbacks.onRetryPin ?? (() => {})}
    />
  );

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
    const onRemovePin = vi.fn();

    const root = renderBoard(ITEMS, true, { onRemovePin }).container;

    const toggle = root.querySelector('.disclosure') as HTMLButtonElement;
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.textContent).toBe('boardTitle(2)');

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

    const mono = entries[1].querySelector('.thumb-monogram');
    expect(mono?.textContent).toBe('F');
    expect(mono?.getAttribute('aria-hidden')).toBe('true');
    clickEl(entries[0].querySelector('.remove-button') as HTMLButtonElement);
    expect(onRemovePin).toHaveBeenCalledWith({
      placeName: 'Oia',
      country: 'Greece',
    } satisfies TripRemovePinDetail);
    clickEl(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(root.querySelector('.board-body')?.hasAttribute('hidden')).toBe(true);
  });

  it('shows the empty state without a clear button', () => {
    const root = renderBoard([], false).container;
    expect(root.querySelector('.empty')?.textContent).toBe('boardEmpty');
    expect(root.querySelector('ul')).toBeNull();
    expect(root.querySelector('.clear-button')).toBeNull();
  });

  it('disables planning with an adjacent explanation under two pins', () => {
    const onPlan = vi.fn();

    const rendered = renderBoard([ITEMS[0]!], false, { onPlan });

    const root = rendered.container;

    const plan = root.querySelector('.plan-button') as HTMLButtonElement;
    expect(plan.getAttribute('aria-disabled')).toBe('true');
    expect(root.querySelector('.plan-note')?.textContent).toBe('boardPlanNote');
    clickEl(plan);
    expect(onPlan).not.toHaveBeenCalled();
    rendered.rerender(
      <TripBoard
        items={ITEMS}
        canPlan={true}
        notice={NOTICE_OFF}
        onRemovePin={() => {}}
        onMovePin={() => {}}
        onPlan={onPlan}
        onClearConfirm={() => {}}
        onRetryPin={() => {}}
      />
    );

    const enabled = root.querySelector('.plan-button') as HTMLButtonElement;
    expect(enabled.hasAttribute('aria-disabled')).toBe(false);
    expect(root.querySelector('.plan-note')).toBeNull();
    clickEl(enabled);
    expect(onPlan).toHaveBeenCalledTimes(1);
  });

  it('confirms clearing inline with focus on the heading', () => {
    const onClearConfirm = vi.fn();

    const root = renderBoard(ITEMS, true, { onClearConfirm }).container;
    clickEl(root.querySelector('.clear-button') as HTMLButtonElement);

    const heading = root.querySelector('.confirm-heading') as HTMLHeadingElement;
    expect(heading.textContent).toBe('boardClearTitle(2)');
    expect(document.activeElement).toBe(heading);

    const [confirm, cancel] = [
      ...root.querySelectorAll('.confirm-actions button'),
    ] as HTMLButtonElement[];
    clickEl(cancel);
    expect(onClearConfirm).not.toHaveBeenCalled();
    expect(root.querySelector('ul')).not.toBeNull();
    expect(document.activeElement?.className).toContain('clear-button');
    clickEl(root.querySelector('.clear-button') as HTMLButtonElement);
    clickEl(root.querySelectorAll('.confirm-actions button')[0] as HTMLButtonElement);
    expect(confirm).not.toBeNull();
    expect(onClearConfirm).toHaveBeenCalledTimes(1);
  });

  it('shows the pin-failure notice with a retry action', () => {
    const onRetryPin = vi.fn();

    const rendered = renderBoard(ITEMS, true, { onRetryPin });
    rendered.rerender(
      <TripBoard
        items={ITEMS}
        canPlan={true}
        notice={{ text: 'boardNoticePinFail', retryLabel: 'boardRetryNoThumb' }}
        onRemovePin={() => {}}
        onMovePin={() => {}}
        onPlan={() => {}}
        onClearConfirm={() => {}}
        onRetryPin={onRetryPin}
      />
    );

    const notice = rendered.container.querySelector('.notice') as HTMLElement;
    expect(notice.hidden).toBe(false);
    expect(notice.textContent).toContain('boardNoticePinFail');
    expect(notice.querySelector('button')?.textContent).toBe('boardRetryNoThumb');
    clickEl(notice.querySelector('button') as HTMLButtonElement);
    expect(onRetryPin).toHaveBeenCalledTimes(1);
    rendered.rerender(
      <TripBoard
        items={ITEMS}
        canPlan={true}
        notice={{ text: 'boardNoticeRemoveFail', retryLabel: 'boardRetryRemove' }}
        onRemovePin={() => {}}
        onMovePin={() => {}}
        onPlan={() => {}}
        onClearConfirm={() => {}}
        onRetryPin={onRetryPin}
      />
    );
    expect(notice.querySelector('button')?.textContent).toBe('boardRetryRemove');
    rendered.rerender(
      <TripBoard
        items={ITEMS}
        canPlan={true}
        notice={NOTICE_OFF}
        onRemovePin={() => {}}
        onMovePin={() => {}}
        onPlan={() => {}}
        onClearConfirm={() => {}}
        onRetryPin={onRetryPin}
      />
    );
    expect(notice.hidden).toBe(true);
  });

  it('moves pins with boundary-aware buttons', () => {
    const onMovePin = vi.fn();

    const root = renderBoard(ITEMS, true, { onMovePin }).container;

    const entries = [...root.querySelectorAll('li')];
    expect(entries).toHaveLength(2);

    const upFirst = entries[0].querySelector('.move-up-button') as HTMLButtonElement;
    expect(upFirst.textContent).toBe('boardMoveUp(Oia)');
    expect(upFirst.disabled).toBe(true);

    const downFirst = entries[0].querySelector('.move-down-button') as HTMLButtonElement;
    expect(downFirst.disabled).toBe(false);
    clickEl(downFirst);
    expect(onMovePin).toHaveBeenCalledWith({
      placeName: 'Oia',
      country: 'Greece',
      direction: 'down',
    } satisfies TripMovePinDetail);

    const upLast = entries[1].querySelector('.move-up-button') as HTMLButtonElement;
    expect(upLast.disabled).toBe(false);
    clickEl(upLast);
    expect(onMovePin).toHaveBeenCalledWith({
      placeName: 'Fira',
      country: 'Greece',
      direction: 'up',
    } satisfies TripMovePinDetail);
    expect(entries[1].querySelector('.move-down-button') as HTMLButtonElement).toHaveProperty(
      'disabled',
      true
    );
  });

  it('repairs focus to the disclosure when a re-render removes it', () => {
    const rendered = renderBoard(ITEMS, true);

    const root = rendered.container;

    const remove = root.querySelector('li .remove-button') as HTMLButtonElement;
    focusEl(remove);
    rendered.rerender(
      <TripBoard
        items={[ITEMS[1]!]}
        canPlan={false}
        notice={NOTICE_OFF}
        onRemovePin={() => {}}
        onMovePin={() => {}}
        onPlan={() => {}}
        onClearConfirm={() => {}}
        onRetryPin={() => {}}
      />
    );
    expect(document.activeElement?.className).toContain('disclosure');
  });
});
