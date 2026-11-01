import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Every rendered key must exist with enough $n placeholders, or Chrome renders a literal "$1".

const TEST_DIR = dirname(fileURLToPath(import.meta.url));

const SRC = join(TEST_DIR, '..');

const CATALOG_PATH = join(TEST_DIR, '../../public/_locales/en/messages.json');

interface CatalogEntry {
  message: string;
  placeholders?: Record<string, { content: string }>;
}

const catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf8')) as Record<string, CatalogEntry>;

const sourceFiles = (): string[] => {
  const out: string[] = [];

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);

      if (entry.isDirectory()) {
        if (entry.name !== 'test') {
          walk(full);
        }

        continue;
      }

      if (/\.test\.[jt]sx?$/.test(entry.name) || !/\.[jt]sx?$/.test(entry.name)) {
        continue;
      }
      out.push(full);
    }
  };
  walk(SRC);

  return out;
};

interface KeyUse {
  key: string;
  subs: number;
  where: string;
}

const KEY = '[A-Za-z0-9_]+';

// Counts substitutions after msg('key': absent -> 0, [...] -> elements, anything else -> 1.
const parseSubs = (text: string, from: number): number | null => {
  let at = from;

  while (at < text.length && /\s/.test(text[at] ?? '')) {
    at += 1;
  }

  if (text[at] !== ',') {
    return 0;
  }
  at += 1;

  while (at < text.length && /\s/.test(text[at] ?? '')) {
    at += 1;
  }

  if (text[at] === '[') {
    let depth = 0;

    let count = 1;

    let quote: string | null = null;

    for (let i = at; i < text.length; i += 1) {
      const ch = text[i];

      if (quote) {
        if (ch === quote && text[i - 1] !== '\\') {
          quote = null;
        }

        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        quote = ch;
        continue;
      }
      if (ch === '[' || ch === '(' || ch === '{') {
        depth += 1;
      } else if (ch === ']' || ch === ')' || ch === '}') {
        depth -= 1;
        if (depth === 0) {
          return count;
        }
      } else if (ch === ',' && depth === 1) {
        count += 1;
      }
    }
    return null;
  }
  const ident = /^(subs?)\b/.exec(text.slice(at));
  return ident ? null : 1;
};

const collect = (): { uses: KeyUse[]; unknownSubs: string[] } => {
  const uses: KeyUse[] = [];
  const unknownSubs: string[] = [];
  const files = sourceFiles();
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const short = file.slice(SRC.length + 1);
    const direct = new RegExp(`(?:msg|announceStatus|announceAlert)\\(\\s*'(${KEY})'`, 'g');
    for (let m = direct.exec(text); m; m = direct.exec(text)) {
      const subs = parseSubs(text, m.index + m[0].length);
      if (subs === null) {
        unknownSubs.push(`${short}: cannot count subs for '${m[1]}'`);
        continue;
      }
      uses.push({ key: m[1], subs, where: short });
    }
    const errCard = new RegExp(`renderErrorCard\\(\\s*'(${KEY})'\\s*,\\s*'(${KEY})'`, 'g');
    for (let m = errCard.exec(text); m; m = errCard.exec(text)) {
      uses.push({ key: m[1], subs: 0, where: short });
      uses.push({ key: m[2], subs: 0, where: short });
    }
    const header = new RegExp(`renderResultHeader\\([^)]*,\\s*'(${KEY})'\\s*\\)`, 'g');
    for (let m = header.exec(text); m; m = header.exec(text)) {
      uses.push({ key: m[1], subs: 1, where: short });
    }
    const foundDefault = new RegExp(`foundKey\\s*=\\s*'(${KEY})'`, 'g');
    for (let m = foundDefault.exec(text); m; m = foundDefault.exec(text)) {
      uses.push({ key: m[1], subs: 1, where: short });
    }
    const chipKey = new RegExp(`[^a-zA-Z0-9_$]key:\\s*'(${KEY})'`, 'g');
    for (let m = chipKey.exec(text); m; m = chipKey.exec(text)) {
      uses.push({ key: m[1], subs: 0, where: short });
    }
    const failureAnchor = text.indexOf('failureKey =');
    if (failureAnchor >= 0) {
      const window = text.slice(failureAnchor, failureAnchor + 400);
      const lit = new RegExp(`[?:]\\s*'(${KEY})'`, 'g');
      for (let m = lit.exec(window); m; m = lit.exec(window)) {
        uses.push({ key: m[1], subs: 0, where: short });
      }
    }
    for (const [name, subs] of [
      ['FINDING_KEYS', 0],
      ['PRIVACY_KEYS', 1],
      ['ERROR_CARD_KEYS', 0],
      ['ERROR_CARD_FALLBACK', 0],
      ['LOADING_LINES', 0],
      ['GRANT_BODY_KEYS', 1],
    ] as Array<[string, number]>) {
      const anchor = text.indexOf(`const ${name}`);
      if (anchor < 0) {
        continue;
      }
      const start = Math.min(
        ...['{', '['].map((ch) => text.indexOf(ch, anchor)).filter((at) => at >= 0)
      );
      let depth = 0;
      let end = start;
      let quote: string | null = null;
      for (let i = start; i < text.length; i += 1) {
        const ch = text[i];
        if (quote) {
          if (ch === quote && text[i - 1] !== '\\') {
            quote = null;
          }
          continue;
        }
        if (ch === '"' || ch === "'") {
          quote = ch;
          continue;
        }
        if (ch === '{' || ch === '[') {
          depth += 1;
        } else if (ch === '}' || ch === ']') {
          depth -= 1;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      const body = text.slice(start, end + 1);
      const lit = new RegExp(`'(${KEY})'`, 'g');
      for (let m = lit.exec(body); m; m = lit.exec(body)) {
        uses.push({ key: m[1], subs, where: `${short}#${name}` });
      }
    }
  }
  return { uses, unknownSubs };
};

describe('message catalog integrity', () => {
  it('declares every key the source can render', () => {
    const { uses, unknownSubs } = collect();
    expect(unknownSubs).toEqual([]);
    expect(uses.length).toBeGreaterThan(50);
    const missing = uses.filter(({ key }) => !Object.hasOwn(catalog, key));
    expect(missing.map(({ key, where }) => `${key} (${where})`)).toEqual([]);
  });

  it('provides a placeholder for every call-site substitution', () => {
    const { uses } = collect();
    const bad: string[] = [];
    for (const { key, subs, where } of uses) {
      const entry = catalog[key];
      if (!entry) {
        continue;
      }
      const found = new Set([...entry.message.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
      const max = found.size === 0 ? 0 : Math.max(...found);
      for (let n = 1; n <= max; n += 1) {
        if (!found.has(n)) {
          bad.push(`${key} (${where}): message skips $${n}`);
        }
      }
      if (max > subs) {
        bad.push(`${key} (${where}): message needs $${max} but the call passes ${subs}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('keeps placeholder declarations consistent with message text', () => {
    const bad: string[] = [];
    for (const [key, entry] of Object.entries(catalog)) {
      for (const [name, placeholder] of Object.entries(entry.placeholders ?? {})) {
        for (const m of placeholder.content.matchAll(/\$(\d+)/g)) {
          if (!entry.message.includes(m[0])) {
            bad.push(`${key}.${name}: declares ${m[0]} missing from the message`);
          }
        }
      }
    }
    expect(bad).toEqual([]);
  });
});
