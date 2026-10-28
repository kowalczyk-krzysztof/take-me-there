import styles from './scan_list.module.css';
import { msg } from '../../utils/i18n';
import type { ScanItemView } from './scan_list';

interface Props {
  items: ScanItemView[];
  checked: Set<string>;
  onPinSelected: (indices: number[]) => void;
}

export const PinSelectedButton = ({ items, checked, onPinSelected }: Props) => (
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
