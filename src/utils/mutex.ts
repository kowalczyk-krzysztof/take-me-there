export type Mutex = <T>(task: () => Promise<T>) => Promise<T>;

// Serializes async read-modify-write cycles against one storage key.
// Tasks run in call order; a rejection reaches its own caller while the
// chain stays alive for the next task.
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
