import styles from './trip_board.module.css';
import { msg } from '../../utils/i18n';
import { ThumbImage } from '../thumb_image/thumb_image';
import { Monogram } from '../thumb_image/monogram';
import type { BoardItemView, TripRemovePinDetail } from './trip_board';

interface Props {
  item: BoardItemView;
  onRemovePin: (detail: TripRemovePinDetail) => void;
}

export const BoardItem = ({ item, onRemovePin }: Props) => (
  <li>
    {item.image ? <ThumbImage src={item.image} /> : <Monogram name={item.title} />}
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
