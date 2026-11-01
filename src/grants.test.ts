import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GRANT_RETRY_ALARM,
  TEMP_GRANT_KEY,
  TEMP_GRANT_TTL_MS,
  addGrantJournal,
  cancelGrantJournal,
  reconcileTempGrants,
  releaseGrantJournal,
  removeGrantVerified,
  requestHostAccess,
} from './grants';
import { installChromeMock, uninstallChromeMock, type ChromeMock } from './test/chrome_mock';

let mock: ChromeMock;

const permsContains = vi.fn();
const permsRequest = vi.fn();
const permsRemove = vi.fn();
const permsGetAll = vi.fn();

const ORIGIN = 'https://cdn.example.com';

beforeEach(() => {
  mock = installChromeMock();
  permsContains.mockReset();
  permsRequest.mockReset();
  permsRemove.mockReset();
  permsGetAll.mockReset();
  permsContains.mockResolvedValue(false);
  permsGetAll.mockResolvedValue({ origins: [] });
  (chrome as unknown as { permissions: unknown }).permissions = {
    contains: permsContains,
    request: permsRequest,
    remove: permsRemove,
    getAll: permsGetAll,
  };
});

afterEach(() => {
  delete (chrome as unknown as { permissions?: unknown }).permissions;
  uninstallChromeMock();
});

const readJournal = async (): Promise<Record<string, { count: number; at: number }>> =>
  (
    (await mock.local.get(TEMP_GRANT_KEY)) as Record<
      string,
      Record<string, { count: number; at: number }>
    >
  )[TEMP_GRANT_KEY] ?? {};

describe('requestHostAccess', () => {
  it('maps an approval to granted', async () => {
    permsRequest.mockResolvedValue(true);

    await expect(requestHostAccess(ORIGIN)).resolves.toBe('granted');
    expect(permsRequest).toHaveBeenCalledWith({ origins: [`${ORIGIN}/*`] });
  });

  it('maps a denial to denied', async () => {
    permsRequest.mockResolvedValue(false);

    await expect(requestHostAccess(ORIGIN)).resolves.toBe('denied');
  });

  it('maps an API failure to error', async () => {
    permsRequest.mockRejectedValue(new Error('no gesture'));

    await expect(requestHostAccess(ORIGIN)).resolves.toBe('error');
  });
});

describe('grant journal', () => {
  it('revokes at zero and deletes the verified entry', async () => {
    await addGrantJournal(ORIGIN);
    expect(await readJournal()).toEqual({ [ORIGIN]: { count: 1, at: expect.any(Number) } });

    await releaseGrantJournal(ORIGIN);

    expect(permsRemove).toHaveBeenCalledWith({ origins: [`${ORIGIN}/*`] });
    expect(await readJournal()).toEqual({});
  });

  it('holds revocation until every borrower releases', async () => {
    await addGrantJournal(ORIGIN);
    await addGrantJournal(ORIGIN);

    await releaseGrantJournal(ORIGIN);

    expect(permsRemove).not.toHaveBeenCalled();
    expect((await readJournal())[ORIGIN]?.count).toBe(1);

    await releaseGrantJournal(ORIGIN);

    expect(permsRemove).toHaveBeenCalledTimes(1);
    expect(await readJournal()).toEqual({});
  });

  it('retains failed revocations for later reconciliation', async () => {
    permsContains.mockResolvedValue(true);

    await addGrantJournal(ORIGIN);
    await releaseGrantJournal(ORIGIN);

    expect(permsRemove).toHaveBeenCalledTimes(1);
    expect((await readJournal())[ORIGIN]?.count).toBe(0);

    permsContains.mockResolvedValue(false);

    await reconcileTempGrants();

    expect(permsRemove).toHaveBeenCalledTimes(2);
    expect(await readJournal()).toEqual({});
  });

  it('cleans unjournaled grants without touching the journal', async () => {
    await releaseGrantJournal(ORIGIN);

    expect(permsRemove).toHaveBeenCalledWith({ origins: [`${ORIGIN}/*`] });
    expect(await readJournal()).toEqual({});
  });

  it('cancels a speculative entry without touching permissions', async () => {
    await addGrantJournal(ORIGIN);
    await addGrantJournal(ORIGIN);

    await cancelGrantJournal(ORIGIN);

    expect(permsRemove).not.toHaveBeenCalled();
    expect((await readJournal())[ORIGIN]?.count).toBe(1);

    await cancelGrantJournal(ORIGIN);

    expect(permsRemove).not.toHaveBeenCalled();
    expect(await readJournal()).toEqual({});

    await expect(cancelGrantJournal(ORIGIN)).resolves.toBeUndefined();
  });

  it('reports verification truthfully', async () => {
    permsContains.mockResolvedValue(false);

    await expect(removeGrantVerified(ORIGIN)).resolves.toBe(true);

    permsContains.mockResolvedValue(true);

    await expect(removeGrantVerified(ORIGIN)).resolves.toBe(false);

    permsContains.mockRejectedValue(new Error('down'));

    await expect(removeGrantVerified(ORIGIN)).resolves.toBe(false);
  });
});

describe('reconcileTempGrants', () => {
  it('leaves fresh entries alone', async () => {
    await addGrantJournal(ORIGIN);

    await reconcileTempGrants();

    expect(permsRemove).not.toHaveBeenCalled();
    expect((await readJournal())[ORIGIN]?.count).toBe(1);
  });

  it('revokes stale entries past the TTL', async () => {
    const now = Date.now();
    await mock.local.set({
      [TEMP_GRANT_KEY]: { [ORIGIN]: { count: 3, at: now - TEMP_GRANT_TTL_MS - 1000 } },
    });

    await reconcileTempGrants(now);

    expect(permsRemove).toHaveBeenCalledWith({ origins: [`${ORIGIN}/*`] });
    expect(await readJournal()).toEqual({});
  });

  it('merges the legacy session ledger once', async () => {
    await mock.session.set({ [TEMP_GRANT_KEY]: { [ORIGIN]: Date.now() } });

    await reconcileTempGrants();

    expect((await readJournal())[ORIGIN]?.count).toBe(1);
    expect(await mock.session.get(TEMP_GRANT_KEY)).toEqual({});
  });

  it('sweeps held but unjournaled origins', async () => {
    await addGrantJournal(ORIGIN);
    permsGetAll.mockResolvedValue({
      origins: [`${ORIGIN}/*`, 'https://leak.example/*'],
    });

    await reconcileTempGrants();

    expect(permsRemove).toHaveBeenCalledTimes(1);
    expect(permsRemove).toHaveBeenCalledWith({ origins: ['https://leak.example/*'] });
    expect((await readJournal())[ORIGIN]?.count).toBe(1);
  });

  it('never throws when storage is down', async () => {
    mock.local.fault = () => {
      throw new Error('locked');
    };
    mock.session.fault = () => {
      throw new Error('locked');
    };

    await expect(reconcileTempGrants()).resolves.toBeUndefined();

    mock.local.fault = () => undefined;
    mock.session.fault = () => undefined;
  });

  it('serializes reconciliation with a racing acquisition', async () => {
    const OTHER = 'https://other.example.com';
    await mock.local.set({ [TEMP_GRANT_KEY]: { [OTHER]: { count: 0, at: 0 } } });

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    permsRemove.mockImplementationOnce(async () => {
      await gate;
    });

    const reconciling = reconcileTempGrants();
    const adding = addGrantJournal(ORIGIN);
    release();
    await Promise.all([reconciling, adding]);

    expect((await readJournal())[ORIGIN]).toEqual({ count: 1, at: expect.any(Number) });
    expect(await readJournal()).not.toHaveProperty(OTHER);
  });

  it('schedules an expiry retry while a fresh orphan remains', async () => {
    const alarmsCreate = vi.fn();
    const alarmsClear = vi.fn();
    (chrome as unknown as { alarms: unknown }).alarms = {
      create: alarmsCreate,
      clear: alarmsClear,
    };

    const at = Date.now();
    await mock.local.set({ [TEMP_GRANT_KEY]: { [ORIGIN]: { count: 1, at } } });

    await reconcileTempGrants(at + 1000);

    expect((await readJournal())[ORIGIN]?.count).toBe(1);
    expect(alarmsCreate).toHaveBeenCalledTimes(1);
    expect(alarmsCreate.mock.calls[0][0]).toBe(GRANT_RETRY_ALARM);
    const when = (alarmsCreate.mock.calls[0][1] as { when: number }).when;
    expect(Math.abs(when - (at + TEMP_GRANT_TTL_MS))).toBeLessThan(5000);
    expect(alarmsClear).not.toHaveBeenCalled();

    delete (chrome as unknown as { alarms?: unknown }).alarms;
  });

  it('cleans a failed revocation after recovery without another user action', async () => {
    const alarmsCreate = vi.fn();
    const alarmsClear = vi.fn();
    (chrome as unknown as { alarms: unknown }).alarms = {
      create: alarmsCreate,
      clear: alarmsClear,
    };
    permsContains.mockResolvedValue(true);

    await mock.local.set({ [TEMP_GRANT_KEY]: { [ORIGIN]: { count: 0, at: 0 } } });

    await reconcileTempGrants();

    expect((await readJournal())[ORIGIN]?.count).toBe(0);
    expect(alarmsCreate).toHaveBeenCalledTimes(1);

    permsContains.mockResolvedValue(false);

    // The scheduled alarm fires: the worker reconciles again on its own.
    await reconcileTempGrants();

    expect(await readJournal()).toEqual({});
    expect(alarmsClear).toHaveBeenCalledWith(GRANT_RETRY_ALARM);

    delete (chrome as unknown as { alarms?: unknown }).alarms;
  });
});
