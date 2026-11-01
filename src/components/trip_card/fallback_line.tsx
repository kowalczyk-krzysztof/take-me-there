import styles from './trip_card.module.css';
import { msg } from '../../utils/i18n';
import { ExternalLink } from '../external_link/external_link';

interface Props {
  fallback: { label: string; href: string };
}

export const FallbackLine = ({ fallback }: Props) => (
  <p className={styles.fallback}>
    <span>{msg('fallbackPrefix')}</span>
    <ExternalLink href={fallback.href}>{fallback.label}</ExternalLink>
  </p>
);
