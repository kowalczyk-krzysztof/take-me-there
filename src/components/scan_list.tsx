import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { injectComponentStyles } from './shared_styles';
import elementCss from './scan_list.css?raw';

injectComponentStyles('scan-list', elementCss);

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

const emit = (host: HTMLElement, name: string, detail?: unknown): void => {
  host.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
};

// Own component so the label lookup runs in tree order (after the cards),
// matching the old render sequence.
const PinSelectedButton = ({
  host, items, checked,
}: {
  host: HTMLElement;
  items: ScanItemView[];
  checked: Set<string>;
}) => (
  <button
    type="button"
    className="primary pin-selected"
    onClick={() => {
      const indices = items
        .map((item, index) => ({ item, index }))
        .filter(({ item }) => checked.has(item.title))
        .map(({ index }) => index);
      if (indices.length > 0) {
        emit(host, 'scan-pin-selected', { indices } satisfies ScanPinSelectedDetail);
      }
    }}
  >
    {msg('scanPinSelected', String(checked.size))}
  </button>
);

const ScanCard = ({
  host, item, index, initialChecked,
}: {
  host: HTMLElement;
  item: ScanItemView;
  index: number;
  initialChecked: boolean;
}) => (
  <div className="scan-card" role="group" aria-label={item.title}>
    {item.image ? (
      <img
        alt=""
        referrerPolicy="no-referrer"
        src={item.image}
        onError={(event) => event.currentTarget.remove()}
      />
    ) : (
      <div className="thumb-placeholder" aria-hidden="true" />
    )}
    <label className="select-row">
      {/* Uncontrolled: a delegated native change listener on the host
          tracks toggles, so programmatic sets fire it too. */}
      <input
        type="checkbox"
        data-title={item.title}
        defaultChecked={initialChecked}
      />
      <span>{item.title}</span>
    </label>
    <div className="card-actions">
      <button
        type="button"
        onClick={() => emit(host, 'scan-guide', { index } satisfies ScanGuideDetail)}
      >
        {msg('scanGuide', item.placeName)}
      </button>
      <button
        type="button"
        className="pin-button"
        aria-pressed={item.pinned}
        onClick={() => emit(host, 'scan-pin', { index } satisfies ScanPinDetail)}
      >
        {msg('pinButton', item.placeName)}
      </button>
    </div>
  </div>
);

export class ScanListElement extends HTMLElement {
  private root: Root | null = null;
  private items: ScanItemView[] = [];
  private checked = new Set<string>();
  private loading = true;
  private epoch = 0;

  connectedCallback(): void {
    this.root ??= createRoot(this);
    this.addEventListener('change', this.onChange);
    this.render();
  }

  disconnectedCallback(): void {
    this.removeEventListener('change', this.onChange);
    this.root?.unmount();
    this.root = null;
  }

  private onChange = (event: Event): void => {
    const box = event.target;
    if (!(box instanceof HTMLInputElement) || box.type !== 'checkbox') {
      return;
    }
    const title = box.dataset.title ?? '';
    if (box.checked) {
      this.checked.add(title);
    } else {
      this.checked.delete(title);
    }
    const selected = this.querySelector('.pin-selected');
    if (selected) {
      selected.textContent = msg('scanPinSelected', String(this.checked.size));
    }
  };

  focusHeading(): void {
    this.querySelector('h2')?.focus();
  }

  setLoading(): void {
    this.items = [];
    this.checked.clear();
    this.loading = true;
    this.epoch += 1;
    this.render();
  }

  setResults(items: ScanItemView[]): void {
    this.items = items;
    for (const name of [...this.checked]) {
      if (!items.some((item) => item.title === name)) {
        this.checked.delete(name);
      }
    }
    this.loading = false;
    this.epoch += 1;
    this.render();
  }

  private render(): void {
    if (this.root) {
      const host = this;
      const { items, checked, loading, epoch } = this;
      flushSync(() => {
        this.root?.render(
          <section aria-busy={loading} aria-labelledby="scan-heading">
            <h2 id="scan-heading" tabIndex={-1}>{msg('scanTitle')}</h2>
            {loading ? (
              <div className="skeleton-grid" aria-hidden="true">
                {[0, 1, 2, 3, 4, 5].map((index) => (
                  <div key={index} className="skeleton-block skeleton-card" />
                ))}
              </div>
            ) : (
              <>
                <div className="scan-results" key={epoch}>
                  {items.map((item, index) => (
                    <ScanCard key={index} host={host} item={item} index={index} initialChecked={checked.has(item.title)} />
                  ))}
                </div>
                {items.length > 0 ? (
                  <PinSelectedButton host={host} items={items} checked={checked} />
                ) : null}
              </>
            )}
          </section>,
        );
      });
    }
  }
}

if (!customElements.get('scan-list')) {
  customElements.define('scan-list', ScanListElement);
}
