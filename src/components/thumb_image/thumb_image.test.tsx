import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Monogram } from './monogram';
import { ThumbImage } from './thumb_image';
import { renderSync } from '../../test/render_sync';

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('thumb-image', () => {
  it('renders a decorative thumbnail without a referrer', () => {
    const root = renderSync(<ThumbImage src="https://example.com/thumb.jpg" />).container;
    const img = root.querySelector('img');
    expect(img?.alt).toBe('');
    expect(img?.referrerPolicy).toBe('no-referrer');
    expect(img?.getAttribute('src')).toBe('https://example.com/thumb.jpg');
  });
});

describe('monogram', () => {
  it('renders the first letter of the trimmed name', () => {
    const root = renderSync(<Monogram name="  Oia" />).container;
    const mono = root.querySelector('.thumb-monogram');
    expect(mono?.textContent).toBe('O');
    expect(mono?.getAttribute('aria-hidden')).toBe('true');
  });
});
