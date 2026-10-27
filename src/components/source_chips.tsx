import type { GuideSource } from '../providers/index';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
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

const SourceChipsView = ({ sources }: { sources: GuideSource[] }) => (
  <>
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
  </>
);

export class SourceChipsElement extends HTMLElement {
  private root: Root | null = null;
  private sources: GuideSource[] = [];

  setSources(sources: GuideSource[]): void {
    this.sources = sources;
    this.classList.add(styles.root);
    this.root ??= createRoot(this);
    flushSync(() => {
      this.root?.render(<SourceChipsView sources={this.sources} />);
    });
  }
}

if (!customElements.get('source-chips')) {
  customElements.define('source-chips', SourceChipsElement);
}
