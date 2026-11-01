import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { resolve } from './ts-extension-loader.mjs';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const missing = async (): Promise<never> => {
  throw Object.assign(new Error('not found'), { code: 'ERR_MODULE_NOT_FOUND' });
};

const plant = async (label: string): Promise<{ entryUrl: string; helperUrl: string }> => {
  const dir = mkdtempSync(join(tmpdir(), label));
  dirs.push(dir);

  const entry = join(dir, 'entry.mjs');
  const helper = join(dir, 'helper.ts');
  writeFileSync(entry, 'export const entry = 1;\n');
  writeFileSync(helper, 'export const helper = 1;\n');

  return { entryUrl: pathToFileURL(entry).href, helperUrl: pathToFileURL(helper).href };
};

describe('ts-extension-loader', () => {
  it('resolves extensionless siblings from ordinary paths', async () => {
    const { entryUrl, helperUrl } = await plant('take-me-there-loader-');

    await expect(resolve('./helper', { parentURL: entryUrl }, missing)).resolves.toEqual({
      url: helperUrl,
      shortCircuit: true,
    });
  });

  it('resolves extensionless siblings from checkout paths with spaces', async () => {
    const { entryUrl, helperUrl } = await plant('take me there loader ');

    expect(entryUrl).toContain('%20');

    await expect(resolve('./helper', { parentURL: entryUrl }, missing)).resolves.toEqual({
      url: helperUrl,
      shortCircuit: true,
    });
  });
});
