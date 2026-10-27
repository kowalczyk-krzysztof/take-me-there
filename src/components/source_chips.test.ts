// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import './source_chips';
import type { SourceChipsElement } from './source_chips';
import elementCss from './source_chips.css?raw';
import { installChromeMock, uninstallChromeMock } from '../test/chrome_mock';

const mount = (): { el: SourceChipsElement; root: ShadowRoot } => {
  const el = document.createElement('source-chips') as SourceChipsElement;
  document.body.append(el);
  return { el, root: el.shadowRoot as ShadowRoot };
};

beforeEach(() => {
  installChromeMock();
  document.body.innerHTML = '';
});

afterEach(() => {
  document.body.innerHTML = '';
  uninstallChromeMock();
});

describe('source-chips', () => {
  it('renders hostname chips for valid URLs only', () => {
    const { el, root } = mount();
    el.setSources([
      { title: 'Model title', url: 'https://example.com/article?x=1' },
      { title: '', url: 'http://plain.example.org/' },
      { title: 'Evil', url: 'javascript:alert(1)' },
      { title: 'File', url: 'ftp://files.example.com/x' },
      { title: 'Relative', url: '/relative/path' },
    ]);
    const chips = [...root.querySelectorAll('a.chip')] as HTMLAnchorElement[];
    expect(chips).toHaveLength(2);
    expect(chips[0].textContent).toContain('example.com');
    expect(chips[0].textContent).not.toContain('Model title');
    expect(chips[0].href).toBe('https://example.com/article?x=1');
    expect(chips[0].target).toBe('_blank');
    expect(chips[0].rel).toBe('noopener noreferrer');
    expect(chips[0].querySelector('.visually-hidden')?.textContent).toBe('newTabSuffix');
    expect(chips[1].textContent).toContain('plain.example.org');
  });

  it('never hides its own host', () => {
    // :empty matches light-DOM children, which shadow-rendered hosts never
    // have - such a rule would hide the chips permanently.
    expect(elementCss).not.toContain(':empty');
  });

  it('renders nothing for empty or fully invalid sources', () => {
    const { el, root } = mount();
    el.setSources([]);
    expect(root.querySelectorAll('a.chip')).toHaveLength(0);
    el.setSources([{ title: 'x', url: 'data:text/html,hi' }]);
    expect(root.querySelectorAll('a.chip')).toHaveLength(0);
  });
});
