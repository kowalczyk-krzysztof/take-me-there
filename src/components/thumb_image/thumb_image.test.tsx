import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Monogram } from './monogram';
import { renderSync } from '../../test/render_sync';

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('monogram', () => {
  it('renders the first letter of the trimmed name', () => {
    const root = renderSync(<Monogram name="  Oia" />).container;

    const mono = root.querySelector('.thumb-monogram');
    expect(mono?.textContent).toBe('O');
    expect(mono?.getAttribute('aria-hidden')).toBe('true');
  });
});
