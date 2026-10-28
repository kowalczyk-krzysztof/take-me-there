import { describe, expect, it } from 'vitest';
import { cleanupRenderSync, renderSync } from './render_sync';

describe('renderSync', () => {
  it('unmounts containers without leaking them into later tests', () => {
    const before = document.body.children.length;

    const rendered = renderSync(<p>hello</p>);
    expect(rendered.container.textContent).toBe('hello');
    expect(document.body.children.length).toBe(before + 1);
    rendered.unmount();
    expect(document.body.children.length).toBe(before);
  });

  it('cleans up roots left mounted by earlier tests', () => {
    renderSync(<p>leaked</p>);
    expect(document.body.textContent).toContain('leaked');
    cleanupRenderSync();
    expect(document.body.textContent).not.toContain('leaked');
  });
});
