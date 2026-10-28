import { describe, expect, it } from 'vitest';
import { dirForLanguage, truncateCodePoints, wellFormed } from './text';

describe('truncateCodePoints', () => {
  it('passes short strings through untouched', () => {
    expect(truncateCodePoints('Oia, Greece', 120)).toBe('Oia, Greece');
  });

  it('never splits a surrogate pair at the cut', () => {
    const name = `${'x'.repeat(119)}😀`;

    const capped = truncateCodePoints(name, 120);
    expect([...capped]).toHaveLength(120);
    expect(() => encodeURIComponent(capped)).not.toThrow();
  });

  it('repairs lone surrogates already in the input', () => {
    const capped = truncateCodePoints('ab\ud800cd', 120);
    expect(() => encodeURIComponent(capped)).not.toThrow();
    expect(wellFormed('ab\ud800cd')).toBe('ab�cd');
  });

  it('counts code points, not UTF-16 units', () => {
    expect(truncateCodePoints('😀😀😀', 2)).toBe('😀😀');
  });
});

describe('dirForLanguage', () => {
  it('marks right-to-left languages', () => {
    expect(dirForLanguage('ar-EG')).toBe('rtl');
    expect(dirForLanguage('he')).toBe('rtl');
    expect(dirForLanguage('fa-IR')).toBe('rtl');
  });

  it('defaults everything else to left-to-right', () => {
    expect(dirForLanguage('en-US')).toBe('ltr');
    expect(dirForLanguage('en')).toBe('ltr');
    expect(dirForLanguage('')).toBe('ltr');
  });
});
