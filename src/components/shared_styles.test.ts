import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const css = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'shared_styles.css'),
  'utf8'
);

const token = (name: string, block: string): string => {
  const match = new RegExp(`${name}:\\s*(#[0-9a-f]{6})`).exec(block);

  if (!match?.[1]) {
    throw new Error(`missing token ${name}`);
  }

  return match[1];
};

const luminance = (hex: string): number => {
  const channels = [1, 3, 5].map((at) => {
    const value = parseInt(hex.slice(at, at + 2), 16) / 255;

    return value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
  });

  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
};

const ratio = (foreground: string, background: string): number => {
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);

  return (light + 0.05) / (dark + 0.05);
};

describe('shared_styles contrast', () => {
  const light = css.split('@media')[0];

  const dark = css.split('@media (prefers-color-scheme: dark)')[1].split('@media')[0];

  it.each([
    ['light', light],
    ['dark', dark],
  ])('keeps muted text at 4.5:1 or better in %s mode', (_mode, block) => {
    const muted = token('--muted', block);

    for (const surface of ['--background', '--card', '--surface']) {
      expect(ratio(muted, token(surface, block))).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each([
    ['light', light],
    ['dark', dark],
  ])('keeps action labels at 4.5:1 or better in %s mode', (_mode, block) => {
    expect(ratio(token('--on-action', block), token('--action', block))).toBeGreaterThanOrEqual(
      4.5
    );
    expect(
      ratio(token('--on-action', block), token('--action-hover', block))
    ).toBeGreaterThanOrEqual(4.5);
  });

  it.each([
    ['light', light],
    ['dark', dark],
  ])('keeps control boundaries and focus visible in %s mode', (_mode, block) => {
    expect(ratio(token('--action', block), token('--card', block))).toBeGreaterThanOrEqual(3);
    expect(
      ratio(token('--focus-color', block), token('--background', block))
    ).toBeGreaterThanOrEqual(3);
    expect(ratio(token('--focus-color', block), token('--card', block))).toBeGreaterThanOrEqual(3);
  });

  it.each([
    ['light', light],
    ['dark', dark],
  ])('keeps error text at 4.5:1 or better in %s mode', (_mode, block) => {
    expect(ratio(token('--error', block), token('--card', block))).toBeGreaterThanOrEqual(4.5);
  });

  it.each([
    ['light', light],
    ['dark', dark],
  ])('keeps essential control boundaries at 3:1 or better in %s mode', (_mode, block) => {
    expect(ratio(token('--border-control', block), token('--card', block))).toBeGreaterThanOrEqual(
      3
    );
  });

  it.each([
    ['light', light],
    ['dark', dark],
  ])('keeps neutral metadata text at 4.5:1 or better in %s mode', (_mode, block) => {
    expect(ratio(token('--meta', block), token('--meta-surface', block))).toBeGreaterThanOrEqual(
      4.5
    );
  });

  it.each([
    ['light', light],
    ['dark', dark],
  ])('keeps brand-accent foreground at 4.5:1 or better in %s mode', (_mode, block) => {
    expect(
      ratio(token('--on-brand-accent', block), token('--brand-accent', block))
    ).toBeGreaterThanOrEqual(4.5);
  });

  it('pins placeholder text to the muted token at full opacity', () => {
    expect(css).toContain('::placeholder');

    const block = /::placeholder\s*{([^}]*)}/.exec(css)?.[1] ?? '';
    expect(block).toContain('color: var(--muted)');
    expect(block).toContain('opacity: 1');
  });
});
