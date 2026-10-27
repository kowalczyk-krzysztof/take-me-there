import styles from './trip_card.module.css';
import { msg } from '../../utils/i18n';

interface Props {
  fallback: { label: string; href: string };
}

export const FallbackLine = ({ fallback }: Props) => (
  <p className={styles.fallback}>
    <span>{`${msg('fallbackPrefix')} `}</span>
    <a href={fallback.href} target="_blank" rel="noopener">
      {fallback.label}
      <span className="visually-hidden">{msg('newTabSuffix')}</span>
    </a>
  </p>
);
