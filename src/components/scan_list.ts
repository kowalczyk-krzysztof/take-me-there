// <scan-list>: the D2 page-scan shortlist. Each card is a group labeled by
// the place name with three sibling controls (checkbox, Guide button, Pin
// button) and no card-wide click wrapper. Image URLs arrive pre-validated
// from the panel; thumbnails are decorative (alt="").
import { adoptSharedStyles } from './shared_styles';
import elementCss from './scan_list.css?raw';

const msg = (key: string, subs?: string | string[]): string =>
  chrome.i18n.getMessage(key, subs);

export interface ScanItemView {
  placeName: string;
  country: string;
  title: string;
  image: string | null;
  pinned: boolean;
}

export interface ScanGuideDetail {
  index: number;
}

export interface ScanPinDetail {
  index: number;
}

export interface ScanPinSelectedDetail {
  indices: number[];
}

export class ScanListElement extends HTMLElement {
  private root: ShadowRoot;
  private items: ScanItemView[] = [];
  private checked = new Set<string>();

  constructor() {
    super();
    this.root = this.attachShadow({ mode: 'open' });
    adoptSharedStyles(this.root);
    const style = document.createElement('style');
    style.textContent = elementCss;
    this.root.append(style);
  }

  focusHeading(): void {
    this.root.querySelector('h2')?.focus();
  }

  setLoading(): void {
    this.items = [];
    this.checked.clear();
    this.render(true);
  }

  setResults(items: ScanItemView[]): void {
    this.items = items;
    for (const name of [...this.checked]) {
      if (!items.some((item) => item.title === name)) {
        this.checked.delete(name);
      }
    }
    this.render(false);
  }

  private emit(name: string, detail?: unknown): void {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
  }

  private render(loading: boolean): void {
    for (const child of [...this.root.children]) {
      if (child.tagName !== 'STYLE') {
        child.remove();
      }
    }
    const section = document.createElement('section');
    section.setAttribute('aria-busy', String(loading));
    section.setAttribute('aria-labelledby', 'scan-heading');
    const heading = document.createElement('h2');
    heading.id = 'scan-heading';
    heading.tabIndex = -1;
    heading.textContent = msg('scanTitle');
    section.append(heading);
    if (loading) {
      const grid = document.createElement('div');
      grid.className = 'skeleton-grid';
      grid.setAttribute('aria-hidden', 'true');
      for (let i = 0; i < 6; i++) {
        const block = document.createElement('div');
        block.className = 'skeleton-block skeleton-card';
        grid.append(block);
      }
      section.append(grid);
    } else {
      const list = document.createElement('div');
      list.className = 'scan-results';
      this.items.forEach((item, index) => {
        list.append(this.renderCard(item, index));
      });
      section.append(list);
      if (this.items.length > 0) {
        const selected = document.createElement('button');
        selected.type = 'button';
        selected.className = 'primary pin-selected';
        selected.textContent = msg('scanPinSelected', String(this.checked.size));
        selected.addEventListener('click', () => {
          const indices = this.items
            .map((item, index) => ({ item, index }))
            .filter(({ item }) => this.checked.has(item.title))
            .map(({ index }) => index);
          if (indices.length > 0) {
            this.emit('scan-pin-selected', { indices } satisfies ScanPinSelectedDetail);
          }
        });
        section.append(selected);
      }
    }
    this.root.append(section);
  }

  private renderCard(item: ScanItemView, index: number): HTMLElement {
    const card = document.createElement('div');
    card.className = 'scan-card';
    card.setAttribute('role', 'group');
    card.setAttribute('aria-label', item.title);
    if (item.image) {
      const thumb = document.createElement('img');
      thumb.alt = '';
      thumb.referrerPolicy = 'no-referrer';
      thumb.onerror = () => thumb.remove();
      thumb.src = item.image;
      card.append(thumb);
    } else {
      const placeholder = document.createElement('div');
      placeholder.className = 'thumb-placeholder';
      placeholder.setAttribute('aria-hidden', 'true');
      card.append(placeholder);
    }
    const label = document.createElement('label');
    label.className = 'select-row';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = this.checked.has(item.title);
    box.addEventListener('change', () => {
      if (box.checked) {
        this.checked.add(item.title);
      } else {
        this.checked.delete(item.title);
      }
      const selected = this.root.querySelector('.pin-selected');
      if (selected) {
        selected.textContent = msg('scanPinSelected', String(this.checked.size));
      }
    });
    const name = document.createElement('span');
    name.textContent = item.title;
    label.append(box, name);
    card.append(label);
    const actions = document.createElement('div');
    actions.className = 'card-actions';
    const guide = document.createElement('button');
    guide.type = 'button';
    guide.textContent = msg('scanGuide', item.placeName);
    guide.addEventListener('click', () =>
      this.emit('scan-guide', { index } satisfies ScanGuideDetail),
    );
    const pin = document.createElement('button');
    pin.type = 'button';
    pin.className = 'pin-button';
    pin.setAttribute('aria-pressed', String(item.pinned));
    pin.textContent = msg('pinButton', item.placeName);
    pin.addEventListener('click', () =>
      this.emit('scan-pin', { index } satisfies ScanPinDetail),
    );
    actions.append(guide, pin);
    card.append(actions);
    return card;
  }
}

if (!customElements.get('scan-list')) {
  customElements.define('scan-list', ScanListElement);
}
