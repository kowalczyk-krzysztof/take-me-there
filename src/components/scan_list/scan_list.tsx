import styles from './scan_list.module.css';
import { msg } from '../../utils/i18n';
import { ScanCard } from './scan_card';

export interface ScanItemView {
  placeName: string;
  country: string;
  title: string;
  image: string | null;
}

export interface ScanListCallbacks {
  onCancel: () => void;
}

interface Props extends ScanListCallbacks {
  loading: boolean;
  items: ScanItemView[];
}

export const ScanList = ({ loading, items, onCancel }: Props) => (
  <div className={styles.root}>
    <section aria-busy={loading} aria-labelledby="scan-heading">
      <h2 id="scan-heading" tabIndex={-1}>
        {msg('scanTitle')}
      </h2>
      {loading ? (
        <>
          <div className={styles['skeleton-grid']} aria-hidden="true">
            {[0, 1, 2].map((index) => (
              <div key={index} className={styles['scan-card']}>
                <div className={`skeleton-block ${styles['skeleton-thumb']}`} />
                <div className="skeleton-block" style={{ width: '70%' }} />
                <div className="skeleton-block" style={{ width: '45%' }} />
              </div>
            ))}
          </div>
          <button type="button" onClick={onCancel}>
            {msg('cancelButton')}
          </button>
        </>
      ) : (
        <ul className={styles['scan-results']}>
          {items.map((item) => (
            <li key={item.title}>
              <ScanCard item={item} />
            </li>
          ))}
        </ul>
      )}
    </section>
  </div>
);
