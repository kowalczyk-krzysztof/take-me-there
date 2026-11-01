// Resolves bundler-style extensionless relative imports for Node-run scripts
// (the eval harness imports TypeScript sources directly). Only handles
// relative specifiers; everything else passes through untouched.
import { existsSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

export const resolve = async (specifier, context, next) => {
  try {
    return await next(specifier, context);
  } catch (err) {
    if (err?.code !== 'ERR_MODULE_NOT_FOUND') throw err;
    if (!specifier.startsWith('.')) throw err;
  }

  const parentDir = dirname(new URL(context.parentURL).pathname);
  const base = resolvePath(parentDir, specifier);
  const candidates = [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`];

  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return { url: pathToFileURL(candidate).href, shortCircuit: true };
    }
  }

  throw new Error(`cannot resolve ${specifier} from ${context.parentURL}`);
};
