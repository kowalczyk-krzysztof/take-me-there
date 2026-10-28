import type { ReactNode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

export interface Rendered {
  container: HTMLElement;
  rerender: (node: ReactNode) => void;
  unmount: () => void;
}

const liveRoots = new Set<{ root: Root; container: HTMLElement }>();

export const cleanupRenderSync = (): void => {
  for (const entry of liveRoots) {
    act(() => {
      entry.root.unmount();
    });
    entry.container.remove();
  }
  liveRoots.clear();
};

export const renderSync = (node: ReactNode): Rendered => {
  const container = document.createElement('div');
  document.body.append(container);

  const root: Root = createRoot(container);

  const entry = { root, container };
  liveRoots.add(entry);
  act(() => {
    root.render(node);
  });

  return {
    container,
    rerender: (next: ReactNode) => {
      act(() => {
        root.render(next);
      });
    },
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
      liveRoots.delete(entry);
    },
  };
};
