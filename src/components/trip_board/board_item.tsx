import styles from './trip_board.module.css';
import { msg } from '../../utils/i18n';
import type { BoardItemView, TripRemovePinDetail } from './trip_board';

interface Props {
  item: BoardItemView;
  onRemovePin: (detail: TripRemovePinDetail) => void;
}

export const BoardItem = ({ item, onRemovePin }: Props) => (
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
        onRemovePin({ placeName: item.placeName, country: item.country });
      }}
    >
      {msg('boardRemove', item.placeName)}
    </button>
  </li>
);
