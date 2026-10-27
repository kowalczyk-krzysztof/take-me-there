// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KeySetup, type KeySetupCallbacks, type NanoSectionState } from './key_setup';
import { installChromeMock, uninstallChromeMock } from '../test/chrome_mock';
import { renderSync, type Rendered } from '../test/render_sync';

interface SetupProps {
  mode?: 'setup' | 'consent';
  pending?: boolean;
  error?: string | null;
  sessionOnly?: boolean;
  nano?: NanoSectionState;
  nanoInstead?: boolean;
  nanoProgress?: number | null;
  resetKey?: number;
}

const noop = () => {};

const renderSetup = (
  props: SetupProps = {},
  callbacks: Partial<KeySetupCallbacks> = {},
): Rendered =>
  renderSync(
    <KeySetup
      mode={props.mode ?? 'setup'}
      pending={props.pending ?? false}
      error={props.error ?? null}
      sessionOnly={props.sessionOnly ?? false}
      nano={props.nano ?? 'hidden'}
      nanoInstead={props.nanoInstead ?? false}
      nanoProgress={props.nanoProgress ?? null}
      resetKey={props.resetKey ?? 0}
      callbacks={{
        onSave: callbacks.onSave ?? noop,
        onError: callbacks.onError ?? noop,
        onSessionOnlyChange: callbacks.onSessionOnlyChange ?? noop,
        onNanoEnable: callbacks.onNanoEnable ?? noop,
        onConsentDecision: callbacks.onConsentDecision ?? noop,
        onDraftChange: callbacks.onDraftChange,
      }}
    />,
  );

const rerenderSetup = (
  rendered: Rendered,
  props: SetupProps = {},
  callbacks: Partial<KeySetupCallbacks> = {},
): void => {
  rendered.rerender(
    <KeySetup
      mode={props.mode ?? 'setup'}
      pending={props.pending ?? false}
      error={props.error ?? null}
      sessionOnly={props.sessionOnly ?? false}
      nano={props.nano ?? 'hidden'}
      nanoInstead={props.nanoInstead ?? false}
      nanoProgress={props.nanoProgress ?? null}
      resetKey={props.resetKey ?? 0}
      callbacks={{
        onSave: callbacks.onSave ?? noop,
        onError: callbacks.onError ?? noop,
        onSessionOnlyChange: callbacks.onSessionOnlyChange ?? noop,
        onNanoEnable: callbacks.onNanoEnable ?? noop,
        onConsentDecision: callbacks.onConsentDecision ?? noop,
        onDraftChange: callbacks.onDraftChange,
      }}
    />,
  );
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
    const root = renderSetup().container;
    expect(root.querySelector('label')?.textContent).toBe('keyLabel');
    expect(root.querySelector('#key-hint')?.textContent).toBe('keyHint');
    expect(root.querySelector('.notice')?.textContent).toBe('securityNotice');
    expect(root.querySelector('.hygiene')?.textContent).toBe('keyHygiene');
    const link = root.querySelector('.dashboard a') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('https://dev.meta.ai');
    expect(link.target).toBe('_blank');
  });

  it('rejects empty submits without emitting', () => {
    const onSave = vi.fn();
    const onError = vi.fn();
    const root = renderSetup({}, { onSave, onError }).container;
    const form = root.querySelector('form') as HTMLFormElement;
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(onSave).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith('keyErrorEmpty');
  });

  it('emits trimmed keys with the session flag', () => {
    const onSave = vi.fn();
    const onSessionOnlyChange = vi.fn();
    let sessionOnly = false;
    const rendered = renderSetup(
      { sessionOnly },
      {
        onSave,
        onSessionOnlyChange: (checked) => {
          sessionOnly = checked;
          onSessionOnlyChange(checked);
        },
      },
    );
    const root = rendered.container;
    (root.querySelector('#key-input') as HTMLInputElement).value = '  LLM_x  ';
    const box = root.querySelector('#session-only') as HTMLInputElement;
    box.checked = true;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    expect(sessionOnly).toBe(true);
    const form = root.querySelector('form') as HTMLFormElement;
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(onSave).toHaveBeenCalledWith('LLM_x');
  });

  it('tracks pending and error states in one root', () => {
    const rendered = renderSetup({ pending: true });
    const root = rendered.container;
    const save = root.querySelector('button.primary') as HTMLButtonElement;
    expect(save.textContent).toBe('validatingButton');
    expect(save.getAttribute('aria-disabled')).toBe('true');
    expect(save.hasAttribute('disabled')).toBe(false);
    rerenderSetup(rendered, { pending: false });
    expect(save.textContent).toBe('saveKeyButton');
    rerenderSetup(rendered, { error: 'bad key' });
    const input = root.querySelector('#key-input') as HTMLInputElement;
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toContain('key-error');
    expect(root.querySelector('#key-error')?.textContent).toBe('bad key');
    rerenderSetup(rendered, { resetKey: 1 });
    const fresh = root.querySelector('#key-input') as HTMLInputElement;
    expect(fresh.value).toBe('');
    expect(fresh.hasAttribute('aria-invalid')).toBe(false);
  });

  it('toggles reveal with a stable button contract', () => {
    const root = renderSetup().container;
    const input = root.querySelector('#key-input') as HTMLInputElement;
    const show = root.querySelector('button.secondary') as HTMLButtonElement;
    expect(show.textContent).toBe('showKeyButton');
    show.click();
    expect(input.type).toBe('text');
    expect(show.getAttribute('aria-pressed')).toBe('true');
    expect(show.textContent).toBe('hideKeyButton');
  });

  it('emits session-only changes', () => {
    const onSessionOnlyChange = vi.fn();
    const rendered = renderSetup({ sessionOnly: true }, { onSessionOnlyChange });
    const root = rendered.container;
    const box = root.querySelector('#session-only') as HTMLInputElement;
    expect(box.checked).toBe(true);
    box.checked = false;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    expect(onSessionOnlyChange).toHaveBeenCalledWith(false);
  });

  it('renders the consent gate and emits decisions', () => {
    const onConsentDecision = vi.fn();
    const root = renderSetup({ mode: 'consent' }, { onConsentDecision }).container;
    expect(root.querySelector('h2')?.textContent).toBe('consentTitle');
    expect(root.querySelector('.consent-body')?.textContent).toBe('consentBody');
    const buttons = [...root.querySelectorAll('.button-row button')];
    expect(buttons.map((button) => button.textContent)).toEqual([
      'agreeButton',
      'declineButton',
    ]);
    (buttons[0] as HTMLButtonElement).click();
    expect(onConsentDecision).toHaveBeenCalledWith(true);
    (buttons[1] as HTMLButtonElement).click();
    expect(onConsentDecision).toHaveBeenCalledWith(false);
  });

  it('renders a focusable consent heading', () => {
    const root = renderSetup({ mode: 'consent' }).container;
    const heading = root.querySelector('h2') as HTMLHeadingElement;
    heading.focus();
    expect(document.activeElement?.tagName).toBe('H2');
  });

  it('hides the Nano section by default', () => {
    const root = renderSetup().container;
    expect(root.querySelector('.nano-section')).toBeNull();
  });

  it('renders the Nano enable button with the download hint', () => {
    const onNanoEnable = vi.fn();
    const rendered = renderSetup({ nano: 'downloadable' }, { onNanoEnable });
    const root = rendered.container;
    (root.querySelector('#key-input') as HTMLInputElement).value = 'LLM_draft';
    const section = root.querySelector('.nano-section');
    expect(section?.querySelector('#nano-hint')?.textContent).toBe('nanoDownloadHint');
    const button = section?.querySelector('button') as HTMLButtonElement;
    expect(button.textContent).toBe('nanoTry');
    expect(button.getAttribute('aria-describedby')).toBe('nano-hint');
    button.click();
    expect(onNanoEnable).toHaveBeenCalledTimes(1);
    // The key draft survives the section rebuild.
    rerenderSetup(rendered, { nano: 'ready', nanoInstead: true }, { onNanoEnable });
    expect((root.querySelector('#key-input') as HTMLInputElement).value).toBe('LLM_draft');
    expect(root.querySelector('.nano-section button')?.textContent).toBe('nanoTryInstead');
  });

  it('renders named progress while downloading and an error with retry', () => {
    const onNanoEnable = vi.fn();
    const rendered = renderSetup({ nano: 'downloading' }, { onNanoEnable });
    const root = rendered.container;
    const bar = root.querySelector('#nano-progress') as HTMLProgressElement;
    expect(bar.getAttribute('aria-label')).toBe('nanoDownloading');
    expect(bar.hasAttribute('value')).toBe(false);
    rerenderSetup(rendered, { nano: 'downloading', nanoProgress: 0.5 }, { onNanoEnable });
    expect(bar.value).toBe(50);
    rerenderSetup(rendered, { nano: 'failed' }, { onNanoEnable });
    expect(root.querySelector('#nano-progress')).toBeNull();
    expect(root.querySelector('.nano-section .error')?.textContent).toBe('nanoDownloadFail');
    (root.querySelector('.nano-section button') as HTMLButtonElement).click();
    expect(onNanoEnable).toHaveBeenCalledTimes(1);
  });
});
