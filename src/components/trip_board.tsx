import { useLayoutEffect, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import styles from './trip_board.module.css';
import { msg } from '../utils/i18n';
import { emit } from '../utils/events';

export interface BoardItemView {
  placeName: string;
  country: string;
  title: string;
  host: string;
  image: string | null;
}

export interface TripRemovePinDetail {
  placeName: string;
  country: string;
}

export interface BoardNoticeView {
  text: string | null;
  retry: boolean;
}

export interface TripBoardCallbacks {
  onRemovePin: (detail: TripRemovePinDetail) => void;
  onPlan: () => void;
  onClearConfirm: () => void;
  onRetryPin: () => void;
}

const BoardItem = ({ item, onRemovePin }: { item: BoardItemView; onRemovePin: (detail: TripRemovePinDetail) => void }) => (
  <li>
    {item.image ? (
      <img
        alt=""
        referrerPolicy="no-referrer"
        src={item.image}
        onError={(event) => event.currentTarget.remove()}
      />
    ) : (
      <div className="thumb-monogram" aria-hidden="true">{item.title.trim().charAt(0)}</div>
    )}
    <div className={styles['item-text']}>
      <p className={styles['item-name']}>{item.title}</p>
      <p className={styles['item-host']}>{item.host}</p>
    </div>
    <button
      type="button"
      onClick={() => {
        onRemovePin({ placeName: item.placeName, country: item.country });
      }}
    >
      {msg('boardRemove', item.placeName)}
    </button>
  </li>
);

export const TripBoard = ({
  items, canPlan, notice, onRemovePin, onPlan, onClearConfirm, onRetryPin,
}: {
  items: BoardItemView[];
  canPlan: boolean;
  notice: BoardNoticeView;
} & TripBoardCallbacks) => {
  const [open, setOpen] = useState(true);
  const [confirming, setConfirming] = useState<number | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const focusDisclosure = (root: HTMLDivElement | null): void => {
    root?.querySelector<HTMLButtonElement>(`.${styles.disclosure}`)?.focus();
  };
  // Focus repair: a list re-render that removes the focused control falls
  // back to the disclosure button, never to <body>.
  const repairFocus = useRef(false);
  const prevItems = useRef(items);
  if (prevItems.current !== items) {
    prevItems.current = items;
    repairFocus.current = !!document.activeElement?.closest('li');
    setConfirming(null);
  }
  useLayoutEffect(() => {
    if (repairFocus.current) {
      repairFocus.current = false;
      focusDisclosure(rootRef.current);
    }
  });
  return (
    <div className={styles.root} ref={rootRef}>
      <section aria-labelledby="board-heading">
        <h2 id="board-heading">
          <button
            type="button"
            className={styles.disclosure}
            aria-expanded={open}
            onClick={() => flushSync(() => setOpen((was) => !was))}
          >
            {msg('boardTitle', String(items.length))}
          </button>
        </h2>
        <div className="board-body" hidden={!open || undefined}>
          {confirming !== null ? (
            <>
              <h2 tabIndex={-1} className={styles['confirm-heading']}>
                {msg('boardClearTitle', String(confirming))}
              </h2>
              <div className={styles['confirm-actions']}>
                <button type="button" className={styles.primary} onClick={onClearConfirm}>
                  {msg('boardClear')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    flushSync(() => setConfirming(null));
                    rootRef.current?.querySelector<HTMLButtonElement>(`.${styles['clear-button']}`)?.focus();
                  }}
                >
                  {msg('videoConfirmCancel')}
                </button>
              </div>
            </>
          ) : (
            <>
              {items.length === 0 ? (
                <p className={styles.empty}>{msg('boardEmpty')}</p>
              ) : (
                <ul aria-labelledby="board-heading">
                  {items.map((item) => (
                    <BoardItem
                      key={`${item.placeName}|${item.country}`}
                      item={item}
                      onRemovePin={onRemovePin}
                    />
                  ))}
                </ul>
              )}
              <div className={styles['plan-row']}>
                <button
                  type="button"
                  className={`${styles.primary} plan-button`}
                  aria-disabled={!canPlan || undefined}
                  onClick={() => {
                    if (canPlan) {
                      onPlan();
                    }
                  }}
                >
                  {msg('boardPlan')}
                </button>
                {!canPlan ? <p className={styles['plan-note']}>{msg('boardPlanNote')}</p> : null}
              </div>
              {items.length > 0 ? (
                <button
                  type="button"
                  className={styles['clear-button']}
                  onClick={() => {
                    flushSync(() => setConfirming(items.length));
                    rootRef.current?.querySelector<HTMLElement>(`.${styles['confirm-heading']}`)?.focus();
                  }}
                >
                  {msg('boardClear')}
                </button>
              ) : null}
              <p className={styles.notice} hidden={notice.text === null || undefined}>
                {notice.text !== null ? <span>{notice.text}</span> : null}
                {notice.text !== null && notice.retry ? (
                  <button type="button" onClick={onRetryPin}>
                    {msg('boardRetryNoThumb')}
                  </button>
                ) : null}
              </p>
            </>
          )}
        </div>
      </section>
    </div>
  );
};

export class TripBoardElement extends HTMLElement {
  private root: Root | null = null;
  private items: BoardItemView[] = [];
  private canPlan = false;
  private notice: BoardNoticeView = { text: null, retry: false };

  connectedCallback(): void {
    this.root ??= createRoot(this);
    this.render();
  }

  disconnectedCallback(): void {
    this.root?.unmount();
    this.root = null;
  }

  setBoard(items: BoardItemView[], canPlan: boolean): void {
    this.items = items;
    this.canPlan = canPlan;
    this.render();
  }

  setNotice(text: string | null, retry: boolean): void {
    this.notice = { text, retry };
    this.render();
  }

  focusHeading(): void {
    this.querySelector<HTMLButtonElement>(`.${styles.disclosure}`)?.focus();
  }

  private render(): void {
    if (this.root) {
      const host = this;
      const { items, canPlan, notice } = this;
      flushSync(() => {
        this.root?.render(
          <TripBoard
            items={items}
            canPlan={canPlan}
            notice={notice}
            onRemovePin={(detail) => emit(host, 'trip-remove-pin', detail)}
            onPlan={() => emit(host, 'trip-plan')}
            onClearConfirm={() => emit(host, 'trip-clear-confirm')}
            onRetryPin={() => emit(host, 'trip-retry-pin')}
          />,
        );
      });
    }
  }
}

if (!customElements.get('trip-board')) {
  customElements.define('trip-board', TripBoardElement);
}
