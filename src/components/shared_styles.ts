import sharedCss from './shared_styles.css?raw';

const injected = new Set<string>();

export const injectStyleOnce = (id: string, cssText: string): void => {
  if (typeof document === 'undefined' || injected.has(id)) {
    return;
  }
  injected.add(id);
  const style = document.createElement('style');
  style.setAttribute('data-component', id);
  style.textContent = cssText;
  document.head.append(style);
};

export const ensureSharedStyles = (): void => injectStyleOnce('shared', sharedCss);

export const injectComponentStyles = (tag: string, cssText: string): void => {
  ensureSharedStyles();
  injectStyleOnce(tag, cssText);
};

export const prefersReducedMotion = (): boolean =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
