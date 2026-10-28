import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TEMP_GRANT_KEY,
  TEMP_GRANT_TTL_MS,
  getDurableOrigins,
  reconcileTempGrants,
  withTempGrant,
} from './grants';
import { installChromeMock, uninstallChromeMock, type ChromeMock } from './test/chrome_mock';

let mock: ChromeMock;

const permsContains = vi.fn();
const permsRequest = vi.fn();
const permsRemove = vi.fn();

const seedSettings = async (settings: unknown): Promise<void> => {
  await mock.local.set({ settings: { v: 1, settings } });
};

beforeEach(() => {
  mock = installChromeMock();
  permsContains.mockReset();
  permsRequest.mockReset();
  permsRemove.mockReset();
  permsContains.mockResolvedValue(false);
  (chrome as unknown as { permissions: unknown }).permissions = {
    contains: permsContains,
    request: permsRequest,
    remove: permsRemove,
  };
});

afterEach(() => {
  delete (chrome as unknown as { permissions?: unknown }).permissions;
  uninstallChromeMock();
});

describe('temp grants', () => {
  it('borrows and revokes a fresh origin around the task', async () => {
    permsRequest.mockResolvedValue(true);
    const task = vi.fn().mockResolvedValue('bytes');

    const outcome = await withTempGrant('https://cdn.example.com', false, task);

    expect(outcome).toEqual({ granted: true, result: 'bytes' });
    expect(task).toHaveBeenCalledTimes(1);
    expect(permsContains).toHaveBeenCalledWith({ origins: ['https://cdn.example.com/*'] });
    expect(permsRequest).toHaveBeenCalledWith({ origins: ['https://cdn.example.com/*'] });
    expect(permsRemove).toHaveBeenCalledWith({ origins: ['https://cdn.example.com/*'] });
    expect(await mock.session.get(TEMP_GRANT_KEY)).toEqual({ [TEMP_GRANT_KEY]: {} });
  });

  it('uses pre-existing grants without requesting or revoking', async () => {
    permsContains.mockResolvedValue(true);
    const task = vi.fn().mockResolvedValue('bytes');

    const outcome = await withTempGrant('https://cdn.example.com', false, task);

    expect(outcome).toEqual({ granted: true, result: 'bytes' });
    expect(permsRequest).not.toHaveBeenCalled();
    expect(permsRemove).not.toHaveBeenCalled();
  });

  it('reports denial without running the task', async () => {
    permsRequest.mockResolvedValue(false);
    const task = vi.fn();

    const outcome = await withTempGrant('https://cdn.example.com', false, task);

    expect(outcome).toEqual({ granted: false });
    expect(task).not.toHaveBeenCalled();
    expect(permsRemove).not.toHaveBeenCalled();
  });

  it('skips permission calls for loopback fetches', async () => {
    const task = vi.fn().mockResolvedValue('bytes');

    const outcome = await withTempGrant('http://127.0.0.1:8000', true, task);

    expect(outcome).toEqual({ granted: true, result: 'bytes' });
    expect(permsContains).not.toHaveBeenCalled();
    expect(permsRequest).not.toHaveBeenCalled();
    expect(permsRemove).not.toHaveBeenCalled();
  });

  it('never revokes the configured provider origin', async () => {
    await seedSettings({
      activeProviderId: 'openai_compat',
      openaiCompat: { baseURL: 'https://llm.example.com/v1', model: 'm' },
    });
    permsRequest.mockResolvedValue(true);

    const outcome = await withTempGrant('https://llm.example.com', false, async () => 'bytes');

    expect(outcome.granted).toBe(true);
    expect(permsRemove).not.toHaveBeenCalled();
    expect(await mock.session.get(TEMP_GRANT_KEY)).toEqual({ [TEMP_GRANT_KEY]: {} });
  });

  it('revokes on task failure too', async () => {
    permsRequest.mockResolvedValue(true);

    await expect(
      withTempGrant('https://cdn.example.com', false, async () => {
        throw new Error('fetch failed');
      })
    ).rejects.toThrow('fetch failed');
    expect(permsRemove).toHaveBeenCalledWith({ origins: ['https://cdn.example.com/*'] });
  });
});

describe('durable origins', () => {
  it('derives the configured custom provider origin', async () => {
    await seedSettings({
      activeProviderId: 'openai_compat',
      openaiCompat: { baseURL: 'https://llm.example.com:8443/v1/', model: 'm' },
    });
    expect(await getDurableOrigins()).toEqual(new Set(['https://llm.example.com:8443']));
  });

  it('reports nothing durable for Muse or garbage', async () => {
    await seedSettings({ activeProviderId: 'muse', openaiCompat: { baseURL: '', model: '' } });
    expect(await getDurableOrigins()).toEqual(new Set());

    await seedSettings({
      activeProviderId: 'openai_compat',
      openaiCompat: { baseURL: 'not a url', model: 'm' },
    });
    expect(await getDurableOrigins()).toEqual(new Set());
  });
});

describe('startup reconcile', () => {
  it('revokes abandoned ledger entries and keeps fresh ones', async () => {
    const now = 1_700_000_000_000;
    await mock.session.set({
      [TEMP_GRANT_KEY]: {
        'https://old.example.com': now - TEMP_GRANT_TTL_MS - 1,
        'https://fresh.example.com': now - 1000,
      },
    });

    await reconcileTempGrants(now);

    expect(permsRemove).toHaveBeenCalledTimes(1);
    expect(permsRemove).toHaveBeenCalledWith({ origins: ['https://old.example.com/*'] });
    expect(await mock.session.get(TEMP_GRANT_KEY)).toEqual({
      [TEMP_GRANT_KEY]: { 'https://fresh.example.com': now - 1000 },
    });
  });

  it('unledgers stale durable origins without revoking them', async () => {
    await seedSettings({
      activeProviderId: 'openai_compat',
      openaiCompat: { baseURL: 'https://llm.example.com/v1', model: 'm' },
    });
    const now = 1_700_000_000_000;
    await mock.session.set({
      [TEMP_GRANT_KEY]: { 'https://llm.example.com': now - TEMP_GRANT_TTL_MS - 1 },
    });

    await reconcileTempGrants(now);

    expect(permsRemove).not.toHaveBeenCalled();
    expect(await mock.session.get(TEMP_GRANT_KEY)).toEqual({ [TEMP_GRANT_KEY]: {} });
  });

  it('tolerates a corrupt ledger', async () => {
    await mock.session.set({ [TEMP_GRANT_KEY]: 'garbage' });

    await reconcileTempGrants();

    expect(permsRemove).not.toHaveBeenCalled();
  });
});
