import { beforeEach, describe, expect, it } from 'vitest';
import { createGuideRenderer, findGuideStart } from './render_markdown';

let container: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.append(container);
});

const tagNames = (): string[] => [...container.children].map((el) => el.tagName);

describe('render_markdown', () => {
  it('emits real structure and clamps heading levels', () => {
    const render = createGuideRenderer(container, 'truncated');
    render.push('# Big\n\n## Mid\n\n### Small\n\n###### Deep');
    render.finish();
    expect(tagNames()).toEqual(['H3', 'H3', 'H4', 'H4']);
    expect(container.textContent).toContain('Big');
  });

  it('groups bullets into one list and renders bold', () => {
    const render = createGuideRenderer(container, 'truncated');
    render.push('Intro **bold** line.\n\n- first\n- second **strong**\n\nOutro.');
    render.finish();
    expect(tagNames()).toEqual(['P', 'UL', 'P']);
    expect(container.querySelectorAll('li')).toHaveLength(2);
    const strongs = container.querySelectorAll('strong');
    expect(strongs).toHaveLength(2);
    expect(strongs[0].textContent).toBe('bold');
    expect(strongs[1].textContent).toBe('strong');
  });

  it('re-renders on every push so partial markup never strands structure', () => {
    const render = createGuideRenderer(container, 'truncated');
    render.push('Half a **bold');
    expect(container.querySelector('strong')).toBeNull();
    render.push(' thought** done.');
    render.finish();
    expect(container.querySelector('strong')?.textContent).toBe('bold thought');
  });

  it('treats model text as text only, never markup', () => {
    const render = createGuideRenderer(container, 'truncated');
    render.push('<img src=x onerror="alert(1)">\n\n[click](javascript:alert(1))');
    render.finish();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror="alert(1)">');
    for (const el of container.querySelectorAll('*')) {
      expect(el.attributes.length).toBe(0);
    }
  });

  it('enforces the character cap with a notice', () => {
    const render = createGuideRenderer(container, 'Guide truncated.', 10);
    render.push('0123456789abcdef');
    expect(render.truncated).toBe(true);
    expect(render.charCount).toBe(16);
    render.finish();
    expect(container.textContent).toContain('Guide truncated.');
    expect(container.querySelector('.guide-truncated')?.tagName).toBe('P');
  });

  it('ignores pushes after finish', () => {
    const render = createGuideRenderer(container, 'truncated');
    render.push('Hello');
    render.finish();
    render.push(' ignored');
    expect(render.charCount).toBe(5);
    expect(container.textContent).toBe('Hello');
  });
});

describe('hostile model output', () => {
  it('renders without throwing and creates no active elements', () => {
    const hostile = [
      '# Title\ud800\n\nBody \udc00 text',
      `${'**unclosed bold\n\n- item \ud800\n- '}\n`.repeat(50),
      '<script>alert(1)</script>\n\n[click](javascript:alert(1))',
      'x'.repeat(50000),
      '\0\0\0',
      '\u202Ereversed',
    ].join('\n\n');
    const render = createGuideRenderer(container, 'truncated');
    expect(() => {
      render.push(hostile);
      render.finish();
    }).not.toThrow();
    expect(container.querySelector('script, a, img, iframe')).toBeNull();
  });
});

describe('findGuideStart', () => {
  it('cuts throat-clearing before the first heading', () => {
    const glued = "I'll research Martissant to build your factual trip guide.## Martissant";
    expect(findGuideStart(glued)).toBe(glued.indexOf('## Martissant'));
    const spaced = 'One moment please. ## Martissant, Port-au-Prince';
    expect(findGuideStart(spaced)).toBe(spaced.indexOf('## Martissant'));
  });

  it('returns zero for heading-first guides and -1 without headings', () => {
    expect(findGuideStart('## Oia\nHello')).toBe(0);
    expect(findGuideStart('# Oia')).toBe(0);
    expect(findGuideStart('Hello world')).toBe(-1);
    expect(findGuideStart('')).toBe(-1);
  });

  it('ignores hashtag lookalikes and bare markers', () => {
    expect(findGuideStart('#hashtag\n## Real')).toBe('#hashtag\n'.length);
    expect(findGuideStart('## \n## Real')).toBe('## \n'.length);
    expect(findGuideStart('C# notes\nno heading')).toBe(-1);
    expect(findGuideStart('100# coverage')).toBe(-1);
  });

  it('finds headings past blank lines and CRLF endings', () => {
    expect(findGuideStart('preamble\n\n### Day 1\r\ntext')).toBe('preamble\n\n'.length);
  });
});
