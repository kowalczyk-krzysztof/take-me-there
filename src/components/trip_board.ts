// <trip-board>: the D1 Trip Board section. Labeled collapsible list of
// pinned places with per-item remove buttons, the Plan/Clear actions, the
// pin-failure notice with its retry, and the inline clear confirm. Image
// URLs arrive pre-validated from the panel and are assigned via the src
// property only; thumbnails are decorative (alt="").
import { adoptSharedStyles } from './shared_styles';
import elementCss from './trip_board.css?raw';

const msg = (key: string, subs?: string | string[]): string =>
  chrome.i18n.getMessage(key, subs);

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

export class TripBoardElement extends HTMLElement {
  private root: ShadowRoot;
  private items: BoardItemView[] = [];
  private canPlan = false;

  constructor() {
    super();
    this.root = this.attachShadow({ mode: 'open' });
    adoptSharedStyles(this.root);
    const style = document.createElement('style');
    style.textContent = elementCss;
    this.root.append(style);
  }

  setBoard(items: BoardItemView[], canPlan: boolean): void {
    this.items = items;
    this.canPlan = canPlan;
    // Focus repair: a list re-render that removes the focused control falls
    // back to the disclosure button, never to <body>.
    const focusedInList = this.root.activeElement?.closest('li');
    this.render();
    if (focusedInList) {
      this.disclosure()?.focus();
    }
  }

  setNotice(text: string | null, retry: boolean): void {
    this.renderNotice(text, retry);
  }

  showClearConfirm(count: number): void {
    const body = this.root.querySelector('.board-body');
    if (!body) {
      return;
    }
    body.replaceChildren();
    const heading = document.createElement('h2');
    heading.tabIndex = -1;
    heading.className = 'confirm-heading';
    heading.textContent = msg('boardClearTitle', String(count));
    const actions = document.createElement('div');
    actions.className = 'confirm-actions';
    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = 'primary';
    confirm.textContent = msg('boardClear');
    confirm.addEventListener('click', () => this.emit('trip-clear-confirm'));
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = msg('videoConfirmCancel');
    cancel.addEventListener('click', () => {
      this.render();
      this.root.querySelector<HTMLButtonElement>('.clear-button')?.focus();
    });
    actions.append(confirm, cancel);
    body.append(heading, actions);
    heading.focus();
  }

  focusHeading(): void {
    this.disclosure()?.focus();
  }

  private disclosure(): HTMLButtonElement | null {
    return this.root.querySelector<HTMLButtonElement>('.disclosure');
  }

  private emit(name: string, detail?: unknown): void {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
  }

  private render(): void {
    const wasOpen =
      this.root.querySelector('.disclosure')?.getAttribute('aria-expanded') !== 'false';
    for (const child of [...this.root.children]) {
      if (child.tagName !== 'STYLE') {
        child.remove();
      }
    }
    const section = document.createElement('section');
    section.setAttribute('aria-labelledby', 'board-heading');
    const heading = document.createElement('h2');
    heading.id = 'board-heading';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'disclosure';
    toggle.setAttribute('aria-expanded', String(wasOpen));
    toggle.textContent = msg('boardTitle', String(this.items.length));
    toggle.addEventListener('click', () => {
      const open = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', String(!open));
      const body = this.root.querySelector('.board-body');
      if (body) {
        body.toggleAttribute('hidden', open);
      }
    });
    heading.append(toggle);
    section.append(heading);
    const body = document.createElement('div');
    body.className = 'board-body';
    body.toggleAttribute('hidden', !wasOpen);
    if (this.items.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = msg('boardEmpty');
      body.append(empty);
    } else {
      const list = document.createElement('ul');
      list.setAttribute('aria-labelledby', 'board-heading');
      for (const item of this.items) {
        list.append(this.renderItem(item));
      }
      body.append(list);
    }
    const planRow = document.createElement('div');
    planRow.className = 'plan-row';
    const plan = document.createElement('button');
    plan.type = 'button';
    plan.className = 'primary plan-button';
    plan.textContent = msg('boardPlan');
    if (!this.canPlan) {
      plan.setAttribute('aria-disabled', 'true');
      const note = document.createElement('p');
      note.className = 'plan-note';
      note.textContent = msg('boardPlanNote');
      planRow.append(plan, note);
    } else {
      planRow.append(plan);
    }
    plan.addEventListener('click', () => {
      if (this.canPlan) {
        this.emit('trip-plan');
      }
    });
    body.append(planRow);
    if (this.items.length > 0) {
      const clear = document.createElement('button');
      clear.type = 'button';
      clear.className = 'clear-button';
      clear.textContent = msg('boardClear');
      clear.addEventListener('click', () => this.showClearConfirm(this.items.length));
      body.append(clear);
    }
    const notice = document.createElement('p');
    notice.className = 'notice';
    notice.hidden = true;
    body.append(notice);
    section.append(body);
    this.root.append(section);
  }

  private renderItem(item: BoardItemView): HTMLElement {
    const entry = document.createElement('li');
    if (item.image) {
      const thumb = document.createElement('img');
      thumb.alt = '';
      thumb.referrerPolicy = 'no-referrer';
      thumb.onerror = () => thumb.remove();
      thumb.src = item.image;
      entry.append(thumb);
    }
    const text = document.createElement('div');
    text.className = 'item-text';
    const name = document.createElement('p');
    name.className = 'item-name';
    name.textContent = item.title;
    const host = document.createElement('p');
    host.className = 'item-host';
    host.textContent = item.host;
    text.append(name, host);
    entry.append(text);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = msg('boardRemove', item.placeName);
    remove.addEventListener('click', () =>
      this.emit('trip-remove-pin', {
        placeName: item.placeName,
        country: item.country,
      } satisfies TripRemovePinDetail),
    );
    entry.append(remove);
    return entry;
  }

  private renderNotice(text: string | null, retry: boolean): void {
    const notice = this.root.querySelector('.notice');
    if (!notice) {
      return;
    }
    notice.replaceChildren();
    notice.toggleAttribute('hidden', text === null);
    if (text === null) {
      return;
    }
    const line = document.createElement('span');
    line.textContent = text;
    notice.append(line);
    if (retry) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = msg('boardRetryNoThumb');
      button.addEventListener('click', () => this.emit('trip-retry-pin'));
      notice.append(button);
    }
  }
}

if (!customElements.get('trip-board')) {
  customElements.define('trip-board', TripBoardElement);
}
