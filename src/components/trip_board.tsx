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

interface NoticeView {
  text: string | null;
  retry: boolean;
}

const BoardItem = ({ host, item }: { host: HTMLElement; item: BoardItemView }) => (
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
        emit(host, 'trip-remove-pin', {
          placeName: item.placeName,
          country: item.country,
        } satisfies TripRemovePinDetail);
      }}
    >
      {msg('boardRemove', item.placeName)}
    </button>
  </li>
);

const BoardView = ({
  host, items, canPlan, open, notice, confirming, onToggle, onClear, onCancelConfirm,
}: {
  host: HTMLElement;
  items: BoardItemView[];
  canPlan: boolean;
  open: boolean;
  notice: NoticeView;
  confirming: number | null;
  onToggle: () => void;
  onClear: () => void;
  onCancelConfirm: () => void;
}) => (
  <section aria-labelledby="board-heading">
    <h2 id="board-heading">
      <button type="button" className={styles.disclosure} aria-expanded={open} onClick={onToggle}>
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
            <button
              type="button"
              className={styles.primary}
              onClick={() => emit(host, 'trip-clear-confirm')}
            >
              {msg('boardClear')}
            </button>
            <button type="button" onClick={onCancelConfirm}>
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
                <BoardItem key={`${item.placeName}|${item.country}`} host={host} item={item} />
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
                  emit(host, 'trip-plan');
                }
              }}
            >
              {msg('boardPlan')}
            </button>
            {!canPlan ? <p className={styles['plan-note']}>{msg('boardPlanNote')}</p> : null}
          </div>
          {items.length > 0 ? (
            <button type="button" className={styles['clear-button']} onClick={onClear}>
              {msg('boardClear')}
            </button>
          ) : null}
          <p className={styles.notice} hidden={notice.text === null || undefined}>
            {notice.text !== null ? <span>{notice.text}</span> : null}
            {notice.text !== null && notice.retry ? (
              <button type="button" onClick={() => emit(host, 'trip-retry-pin')}>
                {msg('boardRetryNoThumb')}
              </button>
            ) : null}
          </p>
        </>
      )}
    </div>
  </section>
);

export class TripBoardElement extends HTMLElement {
  private root: Root | null = null;
  private items: BoardItemView[] = [];
  private canPlan = false;
  private open = true;
  private notice: NoticeView = { text: null, retry: false };
  private confirming: number | null = null;

  connectedCallback(): void {
    this.classList.add(styles.root);
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
    // Focus repair: a list re-render that removes the focused control falls
    // back to the disclosure button, never to <body>.
    const focusedInList = document.activeElement?.closest('li');
    this.render();
    if (focusedInList) {
      this.disclosure()?.focus();
    }
  }

  setNotice(text: string | null, retry: boolean): void {
    this.notice = { text, retry };
    this.render();
  }

  showClearConfirm(count: number): void {
    const body = this.querySelector('.board-body');
    if (!body) {
      return;
    }
    this.confirming = count;
    this.render();
    this.querySelector<HTMLElement>('.confirm-heading')?.focus();
  }

  focusHeading(): void {
    this.disclosure()?.focus();
  }

  private disclosure(): HTMLButtonElement | null {
    return this.querySelector<HTMLButtonElement>('.disclosure');
  }

  private render(): void {
    if (this.root) {
      flushSync(() => {
        this.root?.render(
          <BoardView
            host={this}
            items={this.items}
            canPlan={this.canPlan}
            open={this.open}
            notice={this.notice}
            confirming={this.confirming}
            onToggle={() => {
              this.open = !this.open;
              this.render();
            }}
            onClear={() => this.showClearConfirm(this.items.length)}
            onCancelConfirm={() => {
              this.confirming = null;
              this.render();
              this.querySelector<HTMLButtonElement>('.clear-button')?.focus();
            }}
          />,
        );
      });
    }
  }
}

if (!customElements.get('trip-board')) {
  customElements.define('trip-board', TripBoardElement);
}
