import type { ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';

export interface Rendered {
  container: HTMLElement;
  rerender: (node: ReactNode) => void;
}

export const renderSync = (node: ReactNode): Rendered => {
  const container = document.createElement('div');
  document.body.append(container);
  const root: Root = createRoot(container);
  flushSync(() => {
    root.render(node);
  });
  return {
    container,
    rerender: (next: ReactNode) => {
      flushSync(() => {
        root.render(next);
      });
    },
  };
};
