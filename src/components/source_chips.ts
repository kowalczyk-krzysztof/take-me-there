// <source-chips>: the citation chip row. Chip labels are parsed hostnames
// (model-provided titles are never trusted for labels); every URL is
// validated before it becomes an href.
import type { GuideSource } from '../providers/index';
import { adoptSharedStyles } from './shared_styles';
import elementCss from './source_chips.css?raw';

const msg = (key: string, subs?: string | string[]): string =>
  chrome.i18n.getMessage(key, subs);

export class SourceChipsElement extends HTMLElement {
  private root: ShadowRoot;

  constructor() {
    super();
    this.root = this.attachShadow({ mode: 'open' });
    adoptSharedStyles(this.root);
    const style = document.createElement('style');
    style.textContent = elementCss;
    this.root.append(style);
  }

  setSources(sources: GuideSource[]): void {
    for (const child of [...this.root.children]) {
      if (child.tagName !== 'STYLE') {
        child.remove();
      }
    }
    for (const source of sources) {
      const href = safeHttpUrl(source.url);
      if (!href) {
        continue;
      }
      const chip = document.createElement('a');
      chip.href = href;
      chip.target = '_blank';
      chip.rel = 'noopener noreferrer';
      chip.className = 'chip';
      chip.textContent = hostnameOf(href);
      const suffix = document.createElement('span');
      suffix.className = 'visually-hidden';
      suffix.textContent = msg('newTabSuffix');
      chip.append(suffix);
      this.root.append(chip);
    }
  }
}

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

if (!customElements.get('source-chips')) {
  customElements.define('source-chips', SourceChipsElement);
}
