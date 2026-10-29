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
      <p className={styles['item-name']} title={item.title}>
        {item.title}
      </p>
      <p className={styles['item-host']} title={item.host}>
        {item.host}
      </p>
      {item.remoteImage ? <p className={styles['item-remote']}>{msg('boardRemoteImage')}</p> : null}
    </div>
    <button
      type="button"
      className="move-up-button"
      disabled={!item.canMoveUp || undefined}
      aria-label={msg('boardMoveUp', item.placeName)}
      onClick={() => {
        onMovePin({ placeName: item.placeName, country: item.country, direction: 'up' });
      }}
    >
      {msg('boardMoveUpShort')}
    </button>
    <button
      type="button"
      className="move-down-button"
      disabled={!item.canMoveDown || undefined}
      aria-label={msg('boardMoveDown', item.placeName)}
      onClick={() => {
        onMovePin({ placeName: item.placeName, country: item.country, direction: 'down' });
      }}
    >
      {msg('boardMoveDownShort')}
    </button>
    <button
      type="button"
      className="remove-button"
      aria-label={msg('boardRemove', item.placeName)}
      onClick={() => {
        onRemovePin({ placeName: item.placeName, country: item.country });
      }}
    >
      {msg('boardRemoveShort')}
    </button>
  </li>
);
