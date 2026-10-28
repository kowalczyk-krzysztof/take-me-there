import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MUSE_SPARK_RATES,
  estimateCachedSavingUsd,
  estimateCostUsd,
  formatUsd,
  readMonthSpend,
  recordMonthSpend,
  resetMonthSpend,
} from './pricing';
import { installChromeMock, uninstallChromeMock, type ChromeMock } from './test/chrome_mock';

let mock: ChromeMock;

beforeEach(() => {
  mock = installChromeMock();
});

afterEach(() => {
  uninstallChromeMock();
});

describe('pricing', () => {
  it('prices tokens, searches, and flat fees', () => {
    const rates = MUSE_SPARK_RATES['muse-spark-1.3'];
    expect(
      estimateCostUsd(
        { inputTokens: 1_000_000, outputTokens: 1_000_000, searchCount: 0, flatFeesUsd: 0 },
        rates
      )
    ).toBeCloseTo(5.5, 10);
    expect(
      estimateCostUsd(
        { inputTokens: 0, outputTokens: 0, searchCount: 2, flatFeesUsd: 0.0025 },
        rates
      )
    ).toBeCloseTo(0.0075, 10);
  });

  it('buckets a fixed instant in the zones local month', async () => {
    // 2026-03-01T00:30Z is still February west of UTC: a UTC bucket would
    // file it under March there, while the local-month rule follows the zone.
    const instant = new Date('2026-03-01T00:30:00Z');
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const expected = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
    }).format(instant);
    await recordMonthSpend(0.5, instant);
    const record = mock.local.data.get('costTotals') as { months: Record<string, number> };
    expect(Object.keys(record.months)).toEqual([expected]);
    expect(await readMonthSpend(instant)).toBeCloseTo(0.5, 10);
  });

  it('buckets a local wall-clock boundary in its own month', async () => {
    // Feb 28 23:30 local is already March in UTC east of here: the bucket
    // must follow the wall clock, not the UTC date.
    const instant = new Date(2026, 1, 28, 23, 30);
    await recordMonthSpend(0.5, instant);
    const record = mock.local.data.get('costTotals') as { months: Record<string, number> };
    expect(Object.keys(record.months)).toEqual(['2026-02']);
  });

  it('bills cached input below the full input rate', () => {
    const rates = MUSE_SPARK_RATES['muse-spark-1.3'];
    expect(
      estimateCostUsd(
        {
          inputTokens: 1_000_000,
          outputTokens: 1_000_000,
          searchCount: 0,
          flatFeesUsd: 0,
          cachedInputTokens: 1_000_000,
        },
        rates
      )
    ).toBeCloseTo(0.15 + 4.25, 10);
    expect(
      estimateCachedSavingUsd(
        {
          inputTokens: 1_000_000,
          outputTokens: 0,
          searchCount: 0,
          flatFeesUsd: 0,
          cachedInputTokens: 1_000_000,
        },
        rates
      )
    ).toBeCloseTo(1.1, 10);
  });

  it('clamps cached tokens to the reported input', () => {
    const rates = MUSE_SPARK_RATES['muse-spark-1.3'];
    const usage = {
      inputTokens: 100,
      outputTokens: 0,
      searchCount: 0,
      flatFeesUsd: 0,
      cachedInputTokens: 999,
    };
    expect(estimateCostUsd(usage, rates)).toBeCloseTo((100 * 0.15) / 1_000_000, 12);
    expect(estimateCachedSavingUsd(usage, rates)).toBeCloseTo((100 * 1.1) / 1_000_000, 12);
  });

  it('returns null without a rate table so the UI shows tokens', () => {
    expect(
      estimateCostUsd({ inputTokens: 10, outputTokens: 10, searchCount: 0, flatFeesUsd: 0 })
    ).toBeNull();
  });

  it('accumulates, reads, and resets the monthly total', async () => {
    const day = new Date('2026-03-15T12:00:00Z');
    expect(await recordMonthSpend(0.5, day)).toBeCloseTo(0.5, 10);
    expect(await recordMonthSpend(0.25, day)).toBeCloseTo(0.75, 10);
    expect(await readMonthSpend(day)).toBeCloseTo(0.75, 10);
    expect(await readMonthSpend(new Date('2026-04-15T12:00:00Z'))).toBe(0);
    await resetMonthSpend(day);
    expect(await readMonthSpend(day)).toBe(0);
  });

  it('prunes totals to the most recent 24 months', async () => {
    for (let n = 0; n < 25; n += 1) {
      await recordMonthSpend(0.01, new Date(Date.UTC(2024, n, 2)));
    }
    const record = mock.local.data.get('costTotals') as {
      v: number;
      months: Record<string, number>;
    };
    expect(record.v).toBe(1);
    expect(Object.keys(record.months)).toHaveLength(24);
    expect(record.months['2024-01']).toBeUndefined();
    expect(record.months['2026-01']).toBe(0.01);
  });

  it('migrates legacy flat totals to the versioned record', async () => {
    await mock.local.set({ costTotals: { '2026-03': 1.5 } });
    expect(await readMonthSpend(new Date('2026-03-15T12:00:00Z'))).toBeCloseTo(1.5, 10);
    expect(await recordMonthSpend(0.5, new Date('2026-03-15T12:00:00Z'))).toBeCloseTo(2, 10);
    expect(mock.local.data.get('costTotals')).toEqual({ v: 1, months: { '2026-03': 2 } });
  });

  it('fails closed on a read error instead of erasing history', async () => {
    await mock.local.set({ costTotals: { v: 1, months: { '2026-03': 1.5 } } });
    vi.spyOn(mock.local, 'get').mockRejectedValueOnce(new Error('io'));
    await expect(recordMonthSpend(0.5, new Date('2026-03-15T12:00:00Z'))).rejects.toThrow('io');
    expect(mock.local.data.get('costTotals')).toEqual({ v: 1, months: { '2026-03': 1.5 } });
  });

  it('serializes concurrent records without losing updates', async () => {
    const day = new Date('2026-03-15T12:00:00Z');
    const [first, second] = await Promise.all([
      recordMonthSpend(0.5, day),
      recordMonthSpend(0.25, day),
    ]);
    expect(first + second).toBeCloseTo(1.25, 10);
    expect(await readMonthSpend(day)).toBeCloseTo(0.75, 10);
  });

  it('formats small and large amounts', () => {
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(-1)).toBe('$0.00');
    expect(formatUsd(0.011)).toBe('$0.011');
    expect(formatUsd(1.235)).toBe('$1.24');
  });
});
