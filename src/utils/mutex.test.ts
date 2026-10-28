import { describe, expect, it } from 'vitest';
import { createMutex } from './mutex';

describe('mutex', () => {
  it('runs tasks in order and propagates results', async () => {
    const mutex = createMutex();

    const order: number[] = [];

    const slow = mutex(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push(1);

      return 'slow';
    });

    const fast = mutex(async () => {
      order.push(2);

      return 'fast';
    });
    await expect(slow).resolves.toBe('slow');
    await expect(fast).resolves.toBe('fast');
    expect(order).toEqual([1, 2]);
  });

  it('keeps the chain alive after a rejection', async () => {
    const mutex = createMutex();
    await expect(
      mutex(async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    await expect(mutex(async () => 'next')).resolves.toBe('next');
  });
});
