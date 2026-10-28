import { flushSync } from 'react-dom';

export interface Store<T extends object> {
  get: () => T;
  subscribe: (listener: () => void) => () => void;
  set: (patch: Partial<T>) => void;
}

export const createStore = <T extends object>(initial: T): Store<T> => {
  let state = initial;

  const listeners = new Set<() => void>();

  return {
    get: () => state,
    subscribe: (listener) => {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
    set: (patch) => {
      state = { ...state, ...patch };
      flushSync(() => {
        for (const listener of [...listeners]) {
          listener();
        }
      });
    },
  };
};
