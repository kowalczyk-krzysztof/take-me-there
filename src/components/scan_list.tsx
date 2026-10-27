import { useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import styles from './scan_list.module.css';
import { msg } from '../utils/i18n';
import { emit } from '../utils/events';

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

export interface ScanListCallbacks {
  onGuide: (index: number) => void;
  onPin: (index: number) => void;
  onPinSelected: (indices: number[]) => void;
}

// Own component so the label lookup runs in tree order (after the cards),
// matching the old render sequence.
const PinSelectedButton = ({
  items, checked, onPinSelected,
}: {
  items: ScanItemView[];
  checked: Set<string>;
  onPinSelected: (indices: number[]) => void;
}) => (
  <button
    type="button"
    className={`${styles.primary} ${styles['pin-selected']}`}
    onClick={() => {
      const indices = items
        .map((item, index) => ({ item, index }))
        .filter(({ item }) => checked.has(item.title))
        .map(({ index }) => index);
      if (indices.length > 0) {
        onPinSelected(indices);
      }
    }}
  >
    {msg('scanPinSelected', String(checked.size))}
  </button>
);

const ScanCard = ({
  item, index, initialChecked, onGuide, onPin,
}: {
  item: ScanItemView;
  index: number;
  initialChecked: boolean;
  onGuide: (index: number) => void;
  onPin: (index: number) => void;
}) => (
  <div className={styles['scan-card']} role="group" aria-label={item.title}>
    {item.image ? (
      <img
        alt=""
        referrerPolicy="no-referrer"
        src={item.image}
        onError={(event) => event.currentTarget.remove()}
      />
    ) : (
      <div className={styles['thumb-placeholder']} aria-hidden="true" />
    )}
    <label className={styles['select-row']}>
      {/* Uncontrolled: a delegated native change listener tracks toggles,
          so programmatic sets fire it too. */}
      <input
        type="checkbox"
        data-title={item.title}
        defaultChecked={initialChecked}
      />
      <span>{item.title}</span>
    </label>
    <div className={styles['card-actions']}>
      <button type="button" onClick={() => onGuide(index)}>
        {msg('scanGuide', item.placeName)}
      </button>
      <button
        type="button"
        className="pin-button"
        aria-pressed={item.pinned}
        onClick={() => onPin(index)}
      >
        {msg('pinButton', item.placeName)}
      </button>
    </div>
  </div>
);

export const ScanList = ({
  loading, items, onGuide, onPin, onPinSelected,
}: {
  loading: boolean;
  items: ScanItemView[];
} & ScanListCallbacks) => {
  const checkedRef = useRef<Set<string>>(new Set());
  const [epoch, setEpoch] = useState(0);
  const prevItems = useRef(items);
  if (prevItems.current !== items) {
    prevItems.current = items;
    checkedRef.current = new Set(
      [...checkedRef.current].filter((name) => items.some((item) => item.title === name)),
    );
    setEpoch((current) => current + 1);
  }
  const boxRef = useRef<HTMLDivElement | null>(null);
  const attach = (el: HTMLDivElement | null): (() => void) | void => {
    boxRef.current = el;
    if (!el) {
      return;
    }
    const onChange = (event: Event): void => {
      const box = event.target;
      if (!(box instanceof HTMLInputElement) || box.type !== 'checkbox') {
        return;
      }
      const title = box.dataset.title ?? '';
      if (box.checked) {
        checkedRef.current.add(title);
      } else {
        checkedRef.current.delete(title);
      }
      const selected = boxRef.current?.querySelector(`.${styles['pin-selected']}`);
      if (selected) {
        selected.textContent = msg('scanPinSelected', String(checkedRef.current.size));
      }
    };
    el.addEventListener('change', onChange);
    return () => el.removeEventListener('change', onChange);
  };
  const checked = checkedRef.current;
  return (
    <div className={styles.root}>
      <section aria-busy={loading} aria-labelledby="scan-heading">
        <h2 id="scan-heading" tabIndex={-1}>{msg('scanTitle')}</h2>
        {loading ? (
          <div className={styles['skeleton-grid']} aria-hidden="true">
            {[0, 1, 2, 3, 4, 5].map((index) => (
              <div key={index} className={`skeleton-block ${styles['skeleton-card']}`} />
            ))}
          </div>
        ) : (
          <div ref={attach}>
            <div className={styles['scan-results']} key={epoch}>
              {items.map((item, index) => (
                <ScanCard
                  key={index}
                  item={item}
                  index={index}
                  initialChecked={checked.has(item.title)}
                  onGuide={onGuide}
                  onPin={onPin}
                />
              ))}
            </div>
            {items.length > 0 ? (
              <PinSelectedButton items={items} checked={checked} onPinSelected={onPinSelected} />
            ) : null}
          </div>
        )}
      </section>
    </div>
  );
};

export class ScanListElement extends HTMLElement {
  private root: Root | null = null;
  private items: ScanItemView[] = [];
  private loading = true;

  connectedCallback(): void {
    this.root ??= createRoot(this);
    this.render();
  }

  disconnectedCallback(): void {
    this.root?.unmount();
    this.root = null;
  }

  focusHeading(): void {
    this.querySelector('h2')?.focus();
  }

  setLoading(): void {
    this.items = [];
    this.loading = true;
    this.render();
  }

  setResults(items: ScanItemView[]): void {
    this.items = items;
    this.loading = false;
    this.render();
  }

  private render(): void {
    if (this.root) {
      const host = this;
      const { items, loading } = this;
      flushSync(() => {
        this.root?.render(
          <ScanList
            loading={loading}
            items={items}
            onGuide={(index) => emit(host, 'scan-guide', { index } satisfies ScanGuideDetail)}
            onPin={(index) => emit(host, 'scan-pin', { index } satisfies ScanPinDetail)}
            onPinSelected={(indices) => emit(host, 'scan-pin-selected', { indices } satisfies ScanPinSelectedDetail)}
          />,
        );
      });
    }
  }
}

if (!customElements.get('scan-list')) {
  customElements.define('scan-list', ScanListElement);
}
