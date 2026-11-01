export type Mutex = <T>(task: () => Promise<T>) => Promise<T>;

// Tasks run in call order; a rejection reaches its own caller while the chain stays alive.
export const createMutex = (): Mutex => {
  let tail: Promise<void> = Promise.resolve();

  return (task) => {
    const run = tail.then(task);
    tail = run.then(
      () => undefined,
      () => undefined
    );

    return run;
  };
};
