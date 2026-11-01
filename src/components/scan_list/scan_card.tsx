import styles from './scan_list.module.css';
import { ThumbImage } from '../thumb_image/thumb_image';
import type { ScanItemView } from './scan_list';

interface Props {
  item: ScanItemView;
}

export const ScanCard = ({ item }: Props) => (
  <div className={styles['scan-card']} role="group" aria-label={item.title}>
    {item.image ? (
      <ThumbImage src={item.image} />
    ) : (
      <div className={styles['thumb-placeholder']} aria-hidden="true" />
    )}
    <p className={styles['scan-title']}>{item.title}</p>
  </div>
);
