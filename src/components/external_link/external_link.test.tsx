import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExternalLink } from './external_link';
import { installChromeMock, uninstallChromeMock } from '../../test/chrome_mock';
import { renderSync } from '../../test/render_sync';

beforeEach(() => {
  installChromeMock();
  document.body.innerHTML = '';
});

afterEach(() => {
  document.body.innerHTML = '';
  uninstallChromeMock();
});

describe('external-link', () => {
  it('opens in a new tab without opener or referrer', () => {
    const root = renderSync(
      <ExternalLink href="https://example.com" className="tile">
        Example
      </ExternalLink>
    ).container;
    const link = root.querySelector('a');
    expect(link?.href).toBe('https://example.com/');
    expect(link?.target).toBe('_blank');
    expect(link?.rel).toBe('noopener noreferrer');
    expect(link?.className).toBe('tile');
    expect(link?.querySelector('.visually-hidden')?.textContent).toBe('newTabSuffix');
  });

  it('omits the class attribute without a className', () => {
    const root = renderSync(
      <ExternalLink href="https://example.com">Example</ExternalLink>
    ).container;
    expect(root.querySelector('a')?.hasAttribute('class')).toBe(false);
  });
});
