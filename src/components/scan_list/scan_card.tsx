import styles from './scan_list.module.css';
import { msg } from '../../utils/i18n';
import { ThumbImage } from '../thumb_image/thumb_image';
import type { ScanItemView } from './scan_list';

interface Props {
  item: ScanItemView;
  index: number;
  initialChecked: boolean;
  onGuide: (index: number) => void;
  onPin: (index: number) => void;
}

export const ScanCard = ({ item, index, initialChecked, onGuide, onPin }: Props) => (
  <div className={styles['scan-card']} role="group" aria-label={item.title}>
    {item.image ? (
      <ThumbImage src={item.image} />
    ) : (
      <div className={styles['thumb-placeholder']} aria-hidden="true" />
    )}
    <label className={styles['select-row']}>
      <input type="checkbox" data-title={item.title} defaultChecked={initialChecked} />
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
