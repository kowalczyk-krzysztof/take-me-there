// One constructable stylesheet shared by every document and shadow root:
// the focus style, contrast tokens (light and dark), minimum target sizes,
// skeleton treatment, reduced-motion overrides, and utilities.
import sharedCss from './shared_styles.css?raw';

let sheet: CSSStyleSheet | null = null;

export const sharedSheet = (): CSSStyleSheet | null => {
  if (typeof CSSStyleSheet === 'undefined') {
    return null;
  }
  if (!sheet) {
    sheet = new CSSStyleSheet();
    sheet.replaceSync(sharedCss);
  }
  return sheet;
};

export const adoptSharedStyles = (root: Document | ShadowRoot): void => {
  const shared = sharedSheet();
  if (!shared || !('adoptedStyleSheets' in root)) {
    return;
  }
  if (!root.adoptedStyleSheets.includes(shared)) {
    root.adoptedStyleSheets = [...root.adoptedStyleSheets, shared];
  }
};

export const sharedCssText = (): string => sharedCss;

export const prefersReducedMotion = (): boolean =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
