import { useRef, useState } from 'react';
import styles from './scan_list.module.css';
import { msg } from '../../utils/i18n';
import { PinSelectedButton } from './pin_selected_button';
import { ScanCard } from './scan_card';

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
  onCancel: () => void;
}

interface Props extends ScanListCallbacks {
  loading: boolean;
  items: ScanItemView[];
}

export const ScanList = ({ loading, items, onGuide, onPin, onPinSelected, onCancel }: Props) => {
  const checkedRef = useRef<Set<string>>(new Set());

  const [epoch, setEpoch] = useState(0);

  const prevItems = useRef(items);

  if (prevItems.current !== items) {
    prevItems.current = items;
    checkedRef.current = new Set(
      [...checkedRef.current].filter((name) => items.some((item) => item.title === name))
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
        <h2 id="scan-heading" tabIndex={-1}>
          {msg('scanTitle')}
        </h2>
        {loading ? (
          <>
            <div className={styles['skeleton-grid']} aria-hidden="true">
              {[0, 1, 2, 3, 4, 5].map((index) => (
                <div key={index} className={`skeleton-block ${styles['skeleton-card']}`} />
              ))}
            </div>
            <button type="button" onClick={onCancel}>
              {msg('cancelButton')}
            </button>
          </>
        ) : (
          <div ref={attach}>
            <ul className={styles['scan-results']} key={epoch}>
              {items.map((item, index) => (
                <li key={index}>
                  <ScanCard
                    item={item}
                    index={index}
                    initialChecked={checked.has(item.title)}
                    onGuide={onGuide}
                    onPin={onPin}
                  />
                </li>
              ))}
            </ul>
            {items.length > 0 ? (
              <PinSelectedButton items={items} checked={checked} onPinSelected={onPinSelected} />
            ) : null}
          </div>
        )}
      </section>
    </div>
  );
};
