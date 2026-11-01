import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readMonthSpend } from './pricing';
import type { ExtensionSettings, Provider, Usage } from './providers/index';
import {
  absorbRunUsage,
  activeRun,
  cancelActiveRun,
  cancelRun,
  createEphemeralRun,
  displayedRun,
  markDisplayed,
  ownsUi,
  settleStage,
  startRun,
} from './run_state';
import { installChromeMock, uninstallChromeMock, type ChromeMock } from './test/chrome_mock';
import { routeWorkerMessages } from './test/helpers';
import type { TripRequest } from './types';

let mock: ChromeMock;

beforeEach(() => {
  mock = installChromeMock();
  routeWorkerMessages(mock);
});

afterEach(() => {
  uninstallChromeMock();
});

const usage = (inputTokens: number, outputTokens = 0): Usage => ({
  inputTokens,
  outputTokens,
  searchCount: 0,
  flatFeesUsd: 0,
});

const provider = (rates?: { inputUsdPerMTok: number; outputUsdPerMTok: number }): Provider =>
  ({ getRates: () => rates }) as unknown as Provider;

const settings = (): ExtensionSettings => ({
  activeProviderId: 'muse',
  openaiCompat: { baseURL: '', model: '' },
  imageOnly: false,
  sessionOnly: false,
  skipWebSearch: false,
  cacheTtlDays: 7,
});

const request = (): TripRequest => ({
  requestId: '7-1',
  seq: 7,
  status: 'ready',
  srcUrl: 'https://cdn.example.com/oia.jpg',
  dataPending: false,
  pageUrl: null,
  tabId: 1,
  windowId: 1,
  at: Date.now(),
});

const init = (overrides: Partial<Parameters<typeof startRun>[0]> = {}) => ({
  runId: 'run-a',
  requestId: '7-1',
  kind: 'identify' as const,
  provider: provider({ inputUsdPerMTok: 1, outputUsdPerMTok: 1 }),
  settings: settings(),
  key: 'LLM_x',
  request: request(),
  ...overrides,
});

describe('run lifecycle', () => {
  it('supersedes through the same cancel path and aborts siblings', () => {
    let siblings = 0;

    const first = startRun(init({ runId: 'run-a' }), {
      abortSiblings: () => {
        siblings += 1;
      },
    });
    expect(activeRun()).toBe(first);
    expect(ownsUi(first)).toBe(true);

    const second = startRun(init({ runId: 'run-b' }), {
      abortSiblings: () => {
        siblings += 1;
      },
    });

    expect(first.cancelled).toBe(true);
    expect(first.signal.aborted).toBe(true);
    expect(ownsUi(first)).toBe(false);
    expect(activeRun()).toBe(second);
    expect(ownsUi(second)).toBe(true);
    expect(siblings).toBe(2);
  });

  it('cancels idempotently through the shared path', () => {
    const run = startRun(init());

    expect(cancelActiveRun()).toBe(run);
    expect(cancelActiveRun()).toBeNull();
    cancelRun(run);
    expect(run.cancelled).toBe(true);
    expect(run.signal.aborted).toBe(true);
    expect(activeRun()).toBeNull();
    expect(ownsUi(run)).toBe(false);
  });

  it('inherits usage snapshots for follow-up stages', () => {
    const first = startRun(init({ runId: 'run-a' }));
    absorbRunUsage(first, usage(1000));
    first.recordedUsd = 0.001;

    const second = startRun(init({ runId: 'run-b' }), { inheritFrom: first });
    expect(second.usage).toEqual(first.usage);
    expect(second.recordedUsd).toBe(0.001);
    expect(first.cancelled).toBe(true);
    expect(ownsUi(second)).toBe(true);
  });

  it('inherits cost completeness with the usage snapshot', () => {
    const first = startRun(init({ runId: 'run-a' }));
    expect(first.costComplete).toBe(true);
    first.costComplete = false;

    const second = startRun(init({ runId: 'run-b' }), { inheritFrom: first });
    expect(second.costComplete).toBe(false);

    const fresh = startRun(init({ runId: 'run-c' }));
    expect(fresh.costComplete).toBe(true);
  });

  it('builds ephemeral buckets that never own UI', () => {
    const live = startRun(init({ runId: 'run-a' }));

    const bucket = createEphemeralRun('duel', live.provider, live.settings, live.key);
    expect(activeRun()).toBe(live);
    expect(ownsUi(bucket)).toBe(false);
    expect(bucket.runId).toContain('ephemeral:duel:');
  });

  it('tracks the displayed run for late duel and alternates checks', () => {
    expect(displayedRun()).toBeNull();
    markDisplayed('run-a');
    expect(displayedRun()).toBe('run-a');
    markDisplayed(null);
    expect(displayedRun()).toBeNull();
  });
});

describe('run accounting', () => {
  it('charges each stage once and reports the month total', async () => {
    const run = startRun(init());
    absorbRunUsage(run, usage(1000));

    await expect(settleStage(run, 'identify')).resolves.toBeCloseTo(0.001, 9);
    expect(run.recordedUsd).toBeCloseTo(0.001, 9);

    // A repeated settlement re-reads the total without charging again.
    await expect(settleStage(run, 'identify')).resolves.toBeCloseTo(0.001, 9);
    expect(await readMonthSpend()).toBeCloseTo(0.001, 9);

    absorbRunUsage(run, usage(1000));
    await expect(settleStage(run, 'guide')).resolves.toBeCloseTo(0.002, 9);
    expect(run.recordedUsd).toBeCloseTo(0.002, 9);
  });

  it('settles stale runs without touching the next watermark', async () => {
    const stale = startRun(init({ runId: 'run-a' }));
    absorbRunUsage(stale, usage(1000));

    const pending = settleStage(stale, 'identify');
    const next = startRun(init({ runId: 'run-b' }));
    await pending;

    expect(await readMonthSpend()).toBeCloseTo(0.001, 9);
    expect(next.recordedUsd).toBe(0);
    expect(stale.recordedUsd).toBeCloseTo(0.001, 9);
  });

  it('retries a failed write instead of losing it or charging twice', async () => {
    const run = startRun(init());
    absorbRunUsage(run, usage(1000));

    mock.local.fault = (op) => {
      if (op === 'set') {
        throw new Error('quota');
      }
    };
    await expect(settleStage(run, 'identify')).rejects.toThrow();
    expect(run.recordedUsd).toBe(0);

    mock.local.fault = () => undefined;
    await expect(settleStage(run, 'identify')).resolves.toBeCloseTo(0.001, 9);
    expect(await readMonthSpend()).toBeCloseTo(0.001, 9);
  });

  it('serializes concurrent settles on one run without double-counting', async () => {
    const run = startRun(init());
    absorbRunUsage(run, usage(1000));

    const [a, b] = await Promise.all([settleStage(run, 'duel'), settleStage(run, 'guide')]);

    expect(a).toBeCloseTo(0.001, 9);
    expect(b).toBeCloseTo(0.001, 9);
    expect(await readMonthSpend()).toBeCloseTo(0.001, 9);
  });

  it('records nothing for unpriced providers', async () => {
    const run = startRun(init({ provider: provider(undefined) }));
    absorbRunUsage(run, usage(1000));

    await expect(settleStage(run, 'identify')).resolves.toBe(0);
    expect(run.recordedUsd).toBe(0);
    expect(mock.local.data.has('costTotals')).toBe(false);
  });
});
