import styles from './trip_board.module.css';
import { msg } from '../../utils/i18n';
import { ThumbImage } from '../thumb_image/thumb_image';
import { Monogram } from '../thumb_image/monogram';
import type { BoardItemView, TripMovePinDetail, TripRemovePinDetail } from './trip_board';

interface Props {
  item: BoardItemView;
  onRemovePin: (detail: TripRemovePinDetail) => void;
  onMovePin: (detail: TripMovePinDetail) => void;
}

export const BoardItem = ({ item, onRemovePin, onMovePin }: Props) => (
  <li>
    {item.image ? <ThumbImage src={item.image} /> : <Monogram name={item.title} />}
    <div className={styles['item-text']}>
      <p className={styles['item-name']}>{item.title}</p>
      <p className={styles['item-host']}>{item.host}</p>
      {item.remoteImage ? <p className={styles['item-remote']}>{msg('boardRemoteImage')}</p> : null}
    </div>
    <button
      type="button"
      className="move-up-button"
      disabled={!item.canMoveUp || undefined}
      onClick={() => {
        onMovePin({ placeName: item.placeName, country: item.country, direction: 'up' });
      }}
    >
      {msg('boardMoveUp', item.placeName)}
    </button>
    <button
      type="button"
      className="move-down-button"
      disabled={!item.canMoveDown || undefined}
      onClick={() => {
        onMovePin({ placeName: item.placeName, country: item.country, direction: 'down' });
      }}
    >
      {msg('boardMoveDown', item.placeName)}
    </button>
    <button
      type="button"
      className="remove-button"
      onClick={() => {
        onRemovePin({ placeName: item.placeName, country: item.country });
      }}
    >
      {msg('boardRemove', item.placeName)}
    </button>
  </li>
);
