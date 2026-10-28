import type { GuideSource } from '../../providers/index';
import styles from './source_chips.module.css';
import { ExternalLink } from '../external_link/external_link';

const safeHttpUrl = (raw: string): string | null => {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return parsed.href;
  } catch {
    return null;
  }
};

const hostnameOf = (href: string): string => {
  try {
    return new URL(href).hostname;
  } catch {
    return href;
  }
};

interface Props {
  sources: GuideSource[];
}

export const SourceChips = ({ sources }: Props) => (
  <div className={styles.root}>
    {sources.map((source, index) => {
      const href = safeHttpUrl(source.url);

      if (!href) {
        return null;
      }

      return (
        <ExternalLink key={`${href}-${index}`} href={href} className={styles.chip}>
          {hostnameOf(href)}
        </ExternalLink>
      );
    })}
  </div>
);
