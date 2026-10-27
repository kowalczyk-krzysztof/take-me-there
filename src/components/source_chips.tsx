import type { GuideSource } from '../providers/index';
import styles from './source_chips.module.css';
import { msg } from '../utils/i18n';

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

export const SourceChips = ({ sources }: { sources: GuideSource[] }) => (
  <div className={styles.root}>
    {sources.map((source, index) => {
      const href = safeHttpUrl(source.url);
      if (!href) {
        return null;
      }
      return (
        <a key={`${href}-${index}`} href={href} target="_blank" rel="noopener noreferrer" className={styles.chip}>
          {hostnameOf(href)}
          <span className="visually-hidden">{msg('newTabSuffix')}</span>
        </a>
      );
    })}
  </div>
);

