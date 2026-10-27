// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { createGuideRenderer } from './render_markdown';

let container: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.append(container);
});

function tagNames(): string[] {
  return [...container.children].map((el) => el.tagName);
}

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
