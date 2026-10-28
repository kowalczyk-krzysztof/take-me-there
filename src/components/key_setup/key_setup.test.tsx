import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { KeySetup, type KeySetupCallbacks } from './key_setup';
import { installChromeMock, uninstallChromeMock } from '../../test/chrome_mock';
import { renderSync, type Rendered } from '../../test/render_sync';

interface SetupProps {
  mode?: 'setup' | 'consent';
  pending?: boolean;
  error?: string | null;
  sessionOnly?: boolean;
  resetKey?: number;
  customHost?: string | null;
}

const noop = () => {};

const renderSetup = (
  props: SetupProps = {},
  callbacks: Partial<KeySetupCallbacks> = {}
): Rendered =>
  renderSync(
    <KeySetup
      mode={props.mode ?? 'setup'}
      pending={props.pending ?? false}
      error={props.error ?? null}
      sessionOnly={props.sessionOnly ?? false}
      resetKey={props.resetKey ?? 0}
      customHost={props.customHost ?? null}
      callbacks={{
        onSave: callbacks.onSave ?? noop,
        onError: callbacks.onError ?? noop,
        onSessionOnlyChange: callbacks.onSessionOnlyChange ?? noop,
        onConsentDecision: callbacks.onConsentDecision ?? noop,
        onDraftChange: callbacks.onDraftChange,
      }}
    />
  );

const rerenderSetup = (
  rendered: Rendered,
  props: SetupProps = {},
  callbacks: Partial<KeySetupCallbacks> = {}
): void => {
  rendered.rerender(
    <KeySetup
      mode={props.mode ?? 'setup'}
      pending={props.pending ?? false}
      error={props.error ?? null}
      sessionOnly={props.sessionOnly ?? false}
      resetKey={props.resetKey ?? 0}
      customHost={props.customHost ?? null}
      callbacks={{
        onSave: callbacks.onSave ?? noop,
        onError: callbacks.onError ?? noop,
        onSessionOnlyChange: callbacks.onSessionOnlyChange ?? noop,
        onConsentDecision: callbacks.onConsentDecision ?? noop,
        onDraftChange: callbacks.onDraftChange,
      }}
    />
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
    act(() => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
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
      }
    );
    const root = rendered.container;
    (root.querySelector('#key-input') as HTMLInputElement).value = '  LLM_x  ';
    const box = root.querySelector('#session-only') as HTMLInputElement;
    box.checked = true;
    act(() => {
      box.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(sessionOnly).toBe(true);
    const form = root.querySelector('form') as HTMLFormElement;
    act(() => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
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
    expect(show.hasAttribute('aria-pressed')).toBe(false);
    expect(show.getAttribute('aria-controls')).toBe('key-input');
    act(() => {
      show.click();
    });
    expect(input.type).toBe('text');
    expect(show.hasAttribute('aria-pressed')).toBe(false);
    expect(show.textContent).toBe('hideKeyButton');
  });

  it('emits session-only changes', () => {
    const onSessionOnlyChange = vi.fn();
    const rendered = renderSetup({ sessionOnly: true }, { onSessionOnlyChange });
    const root = rendered.container;
    const box = root.querySelector('#session-only') as HTMLInputElement;
    expect(box.checked).toBe(true);
    box.checked = false;
    act(() => {
      box.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(onSessionOnlyChange).toHaveBeenCalledWith(false);
  });

  it('renders the consent gate and emits decisions', () => {
    const onConsentDecision = vi.fn();
    const root = renderSetup({ mode: 'consent' }, { onConsentDecision }).container;
    expect(root.querySelector('h2')?.textContent).toBe('consentTitle');
    expect(root.querySelector('.consent-body')?.textContent).toBe('consentBody');
    const buttons = [...root.querySelectorAll('.button-row button')];
    expect(buttons.map((button) => button.textContent)).toEqual(['agreeButton', 'declineButton']);
    act(() => {
      (buttons[0] as HTMLButtonElement).click();
    });
    expect(onConsentDecision).toHaveBeenCalledWith(true);
    act(() => {
      (buttons[1] as HTMLButtonElement).click();
    });
    expect(onConsentDecision).toHaveBeenCalledWith(false);
  });

  it('names the custom host instead of the Muse dashboard', () => {
    const root = renderSetup({ customHost: 'my-server.example' }).container;
    expect(root.querySelector('#key-hint')?.textContent).toBe('keyHintCustom');
    expect(root.querySelector('.notice')?.textContent).toBe(
      'securityNoticeCustom(my-server.example)'
    );
    expect(root.querySelector('.hygiene')?.textContent).toBe('keyHygieneCustom');
    expect(root.querySelector('.dashboard')).toBeNull();
    const consent = renderSetup({ mode: 'consent', customHost: 'my-server.example' }).container;
    expect(consent.querySelector('.consent-body')?.textContent).toBe(
      'consentBodyCustom(my-server.example)'
    );
  });

  it('renders a focusable consent heading', () => {
    const root = renderSetup({ mode: 'consent' }).container;
    const heading = root.querySelector('h2') as HTMLHeadingElement;
    heading.focus();
    expect(document.activeElement?.tagName).toBe('H2');
  });
});
