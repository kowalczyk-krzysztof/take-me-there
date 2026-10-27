// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import './key_setup';
import type {
  ConsentDecisionDetail,
  KeySaveRequestDetail,
  KeySetupElement,
  SessionOnlyChangeDetail,
} from './key_setup';
import { installChromeMock, uninstallChromeMock } from '../test/chrome_mock';

const mount = (): { el: KeySetupElement; root: ShadowRoot } => {
  const el = document.createElement('key-setup') as KeySetupElement;
  document.body.append(el);
  return { el, root: el.shadowRoot as ShadowRoot };
};

beforeEach(() => {
  installChromeMock();
  document.body.innerHTML = '';
});

afterEach(() => {
  document.body.innerHTML = '';
  uninstallChromeMock();
});

describe('key-setup', () => {
  it('renders the setup form with canonical copy', () => {
    const { root } = mount();
    expect(root.querySelector('label')?.textContent).toBe('keyLabel');
    expect(root.querySelector('#key-hint')?.textContent).toBe('keyHint');
    expect(root.querySelector('.notice')?.textContent).toBe('securityNotice');
    expect(root.querySelector('.hygiene')?.textContent).toBe('keyHygiene');
    const link = root.querySelector('.dashboard a') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('https://dev.meta.ai');
    expect(link.target).toBe('_blank');
  });

  it('rejects empty submits without emitting', () => {
    const { el, root } = mount();
    let emitted: KeySaveRequestDetail | null = null;
    el.addEventListener('key-save-request', (event) => {
      emitted = (event as CustomEvent<KeySaveRequestDetail>).detail;
    });
    const form = root.querySelector('form') as HTMLFormElement;
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(emitted).toBeNull();
    expect(root.querySelector('#key-error')?.textContent).toBe('keyErrorEmpty');
  });

  it('emits trimmed keys with the session flag', () => {
    const { el, root } = mount();
    let emitted: KeySaveRequestDetail | null = null;
    el.addEventListener('key-save-request', (event) => {
      emitted = (event as CustomEvent<KeySaveRequestDetail>).detail;
    });
    (root.querySelector('#key-input') as HTMLInputElement).value = '  LLM_x  ';
    const box = root.querySelector('#session-only') as HTMLInputElement;
    box.checked = true;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    const form = root.querySelector('form') as HTMLFormElement;
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(emitted).toEqual({ key: 'LLM_x', sessionOnly: true });
  });

  it('tracks pending and error states in one root', () => {
    const { el, root } = mount();
    el.setPending(true);
    const save = root.querySelector('button.primary') as HTMLButtonElement;
    expect(save.textContent).toBe('validatingButton');
    expect(save.getAttribute('aria-disabled')).toBe('true');
    expect(save.hasAttribute('disabled')).toBe(false);
    el.setPending(false);
    expect(save.textContent).toBe('saveKeyButton');
    el.setError('bad key');
    const input = root.querySelector('#key-input') as HTMLInputElement;
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toContain('key-error');
    expect(root.querySelector('#key-error')?.textContent).toBe('bad key');
    el.clear();
    expect(input.value).toBe('');
    expect(input.hasAttribute('aria-invalid')).toBe(false);
  });

  it('toggles reveal with a stable button contract', () => {
    const { root } = mount();
    const input = root.querySelector('#key-input') as HTMLInputElement;
    const show = root.querySelector('button.secondary') as HTMLButtonElement;
    expect(show.textContent).toBe('showKeyButton');
    show.click();
    expect(input.type).toBe('text');
    expect(show.getAttribute('aria-pressed')).toBe('true');
    expect(show.textContent).toBe('hideKeyButton');
  });

  it('emits session-only changes', () => {
    const { el, root } = mount();
    let emitted: SessionOnlyChangeDetail | null = null;
    el.addEventListener('session-only-change', (event) => {
      emitted = (event as CustomEvent<SessionOnlyChangeDetail>).detail;
    });
    el.setSessionOnly(true);
    const box = root.querySelector('#session-only') as HTMLInputElement;
    expect(box.checked).toBe(true);
    box.checked = false;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    expect(emitted).toEqual({ checked: false });
  });

  it('renders the consent gate and emits decisions', () => {
    const { el, root } = mount();
    el.showConsent();
    expect(root.querySelector('h2')?.textContent).toBe('consentTitle');
    expect(root.querySelector('.consent-body')?.textContent).toBe('consentBody');
    const buttons = [...root.querySelectorAll('.button-row button')];
    expect(buttons.map((button) => button.textContent)).toEqual([
      'agreeButton',
      'declineButton',
    ]);
    let emitted: ConsentDecisionDetail | null = null;
    el.addEventListener('consent-decision', (event) => {
      emitted = (event as CustomEvent<ConsentDecisionDetail>).detail;
    });
    (buttons[0] as HTMLButtonElement).click();
    expect(emitted).toEqual({ agreed: true });
    (buttons[1] as HTMLButtonElement).click();
    expect(emitted).toEqual({ agreed: false });
  });

  it('focuses the consent heading on request', () => {
    const { el, root } = mount();
    el.showConsent();
    el.focusConsentHeading();
    expect((root.activeElement as HTMLElement)?.tagName).toBe('H2');
  });

  it('hides the Nano section by default', () => {
    const { root } = mount();
    expect(root.querySelector('.nano-section')).toBeNull();
  });

  it('renders the Nano enable button with the download hint', () => {
    const { el, root } = mount();
    (root.querySelector('#key-input') as HTMLInputElement).value = 'LLM_draft';
    let enabled = 0;
    el.addEventListener('nano-enable', () => {
      enabled += 1;
    });
    el.setNano('downloadable');
    const section = root.querySelector('.nano-section');
    expect(section?.querySelector('#nano-hint')?.textContent).toBe('nanoDownloadHint');
    const button = section?.querySelector('button') as HTMLButtonElement;
    expect(button.textContent).toBe('nanoTry');
    expect(button.getAttribute('aria-describedby')).toBe('nano-hint');
    button.click();
    expect(enabled).toBe(1);
    // The key draft survives the section rebuild.
    expect((root.querySelector('#key-input') as HTMLInputElement).value).toBe('LLM_draft');
    el.setNano('ready', { instead: true });
    expect(root.querySelector('.nano-section button')?.textContent).toBe('nanoTryInstead');
  });

  it('renders named progress while downloading and an error with retry', () => {
    const { el, root } = mount();
    el.setNano('downloading');
    const bar = root.querySelector('#nano-progress') as HTMLProgressElement;
    expect(bar.getAttribute('aria-label')).toBe('nanoDownloading');
    expect(bar.hasAttribute('value')).toBe(false);
    el.setNanoProgress(0.5);
    expect(bar.value).toBe(50);
    el.setNano('failed');
    expect(root.querySelector('#nano-progress')).toBeNull();
    expect(root.querySelector('.nano-section .error')?.textContent).toBe('nanoDownloadFail');
    let enabled = 0;
    el.addEventListener('nano-enable', () => {
      enabled += 1;
    });
    (root.querySelector('.nano-section button') as HTMLButtonElement).click();
    expect(enabled).toBe(1);
  });
});
