// <key-setup>: the shared key-entry form plus the canonical security notice
// and the first-analysis consent gate. Rendered on all three key surfaces
// (onboarding page, panel inline setup, options) so wording never drifts.
import { adoptSharedStyles } from './shared_styles';
import elementCss from './key_setup.css?raw';

const DASHBOARD_URL = 'https://dev.meta.ai';

export interface KeySaveRequestDetail {
  key: string;
  sessionOnly: boolean;
}

export interface ConsentDecisionDetail {
  agreed: boolean;
}

export interface SessionOnlyChangeDetail {
  checked: boolean;
}

export type NanoSectionState = 'hidden' | 'ready' | 'downloadable' | 'downloading' | 'failed';

const msg = (key: string, subs?: string | string[]): string =>
  chrome.i18n.getMessage(key, subs);

export class KeySetupElement extends HTMLElement {
  private root: ShadowRoot;
  private sessionOnly = false;
  private pending = false;
  private form?: HTMLFormElement;
  private input?: HTMLInputElement;
  private errorEl?: HTMLParagraphElement;
  private saveButton?: HTMLButtonElement;
  private showButton?: HTMLButtonElement;
  private revealed = false;
  private nano: NanoSectionState = 'hidden';
  private nanoInstead = false;
  private nanoProgress: number | null = null;

  constructor() {
    super();
    this.root = this.attachShadow({ mode: 'open', delegatesFocus: true });
    adoptSharedStyles(this.root);
    const style = document.createElement('style');
    style.textContent = elementCss;
    this.root.append(style);
    this.renderSetup();
  }

  showSetup(): void {
    this.nano = 'hidden';
    this.nanoProgress = null;
    this.renderSetup();
  }

  showConsent(): void {
    this.renderConsent();
  }

  focusConsentHeading(): void {
    this.root.querySelector('h2')?.focus();
  }

  setPending(pending: boolean): void {
    this.pending = pending;
    if (!this.saveButton) {
      return;
    }
    this.saveButton.textContent = msg(pending ? 'validatingButton' : 'saveKeyButton');
    if (pending) {
      this.saveButton.setAttribute('aria-disabled', 'true');
    } else {
      this.saveButton.removeAttribute('aria-disabled');
    }
  }

  setError(text: string): void {
    if (!this.input || !this.errorEl) {
      return;
    }
    this.errorEl.textContent = text;
    this.errorEl.hidden = false;
    this.input.setAttribute('aria-invalid', 'true');
    this.input.setAttribute('aria-describedby', 'key-hint key-error');
    this.input.focus();
  }

  clearError(): void {
    if (!this.input || !this.errorEl) {
      return;
    }
    this.errorEl.textContent = '';
    this.errorEl.hidden = true;
    this.input.removeAttribute('aria-invalid');
    this.input.setAttribute('aria-describedby', 'key-hint');
  }

  clear(): void {
    if (this.input) {
      this.input.value = '';
    }
    this.clearError();
    this.setPending(false);
  }

  setSessionOnly(checked: boolean): void {
    this.sessionOnly = checked;
    const box = this.root.querySelector<HTMLInputElement>('#session-only');
    if (box) {
      box.checked = checked;
    }
  }

  getDraft(): KeySaveRequestDetail {
    return { key: (this.input?.value ?? '').trim(), sessionOnly: this.sessionOnly };
  }

  setNano(state: NanoSectionState, opts: { instead?: boolean } = {}): void {
    this.nano = state;
    this.nanoInstead = opts.instead ?? false;
    if (state !== 'downloading') {
      this.nanoProgress = null;
    }
    // Rebuilds the form, so the key draft rides along.
    const draft = this.input?.value ?? '';
    this.renderSetup();
    if (this.input) {
      this.input.value = draft;
    }
  }

  setNanoProgress(frac: number | null): void {
    this.nanoProgress = frac;
    const bar = this.root.querySelector<HTMLProgressElement>('#nano-progress');
    if (!bar) {
      return;
    }
    if (frac === null) {
      bar.removeAttribute('value');
    } else {
      bar.value = Math.min(1, Math.max(0, frac)) * 100;
    }
  }

  private clearView(): void {
    for (const child of [...this.root.children]) {
      if (child.tagName !== 'STYLE') {
        child.remove();
      }
    }
    this.form = undefined;
    this.input = undefined;
    this.errorEl = undefined;
    this.saveButton = undefined;
    this.showButton = undefined;
  }

  private renderSetup(): void {
    this.clearView();
    const form = document.createElement('form');
    form.setAttribute('novalidate', '');

    const label = document.createElement('label');
    label.className = 'field-label';
    label.setAttribute('for', 'key-input');
    label.textContent = msg('keyLabel');

    const input = document.createElement('input');
    input.id = 'key-input';
    input.type = this.revealed ? 'text' : 'password';
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('autocapitalize', 'off');
    input.setAttribute('spellcheck', 'false');
    input.setAttribute('aria-describedby', 'key-hint');
    input.placeholder = msg('keyPlaceholder');

    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.id = 'key-hint';
    hint.textContent = msg('keyHint');

    const dashboard = document.createElement('p');
    dashboard.className = 'dashboard';
    const dashboardLink = document.createElement('a');
    dashboardLink.href = DASHBOARD_URL;
    dashboardLink.target = '_blank';
    dashboardLink.rel = 'noopener noreferrer';
    dashboardLink.textContent = msg('dashboardLink');
    const suffix = document.createElement('span');
    suffix.className = 'visually-hidden';
    suffix.textContent = msg('newTabSuffix');
    dashboardLink.append(suffix);
    dashboard.append(dashboardLink);

    const error = document.createElement('p');
    error.className = 'error';
    error.id = 'key-error';
    error.hidden = true;

    const checkRow = document.createElement('label');
    checkRow.className = 'checkbox-row';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.id = 'session-only';
    box.checked = this.sessionOnly;
    box.addEventListener('change', () => {
      this.sessionOnly = box.checked;
      this.dispatchEvent(
        new CustomEvent<SessionOnlyChangeDetail>('session-only-change', {
          bubbles: true,
          composed: true,
          detail: { checked: box.checked },
        }),
      );
    });
    const checkText = document.createElement('span');
    checkText.textContent = msg('sessionOnlyLabel');
    checkRow.append(box, checkText);

    const buttons = document.createElement('div');
    buttons.className = 'button-row';
    const save = document.createElement('button');
    save.type = 'submit';
    save.className = 'primary';
    save.textContent = msg(this.pending ? 'validatingButton' : 'saveKeyButton');
    if (this.pending) {
      save.setAttribute('aria-disabled', 'true');
    }
    const show = document.createElement('button');
    show.type = 'button';
    show.className = 'secondary';
    show.setAttribute('aria-pressed', this.revealed ? 'true' : 'false');
    show.textContent = msg(this.revealed ? 'hideKeyButton' : 'showKeyButton');
    show.addEventListener('click', () => {
      this.revealed = !this.revealed;
      input.type = this.revealed ? 'text' : 'password';
      show.setAttribute('aria-pressed', this.revealed ? 'true' : 'false');
      show.textContent = msg(this.revealed ? 'hideKeyButton' : 'showKeyButton');
    });
    buttons.append(save, show);

    const notice = document.createElement('p');
    notice.className = 'notice';
    notice.textContent = msg('securityNotice');

    const hygiene = document.createElement('p');
    hygiene.className = 'hygiene';
    hygiene.textContent = msg('keyHygiene');

    form.append(label, input, hint, dashboard, error, checkRow, buttons);
    const nano = this.renderNano();
    if (nano) {
      form.append(nano);
    }
    form.append(notice, hygiene);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (this.pending) {
        return;
      }
      const key = input.value.trim();
      if (!key) {
        this.setError(msg('keyErrorEmpty'));
        return;
      }
      this.clearError();
      this.dispatchEvent(
        new CustomEvent<KeySaveRequestDetail>('key-save-request', {
          bubbles: true,
          composed: true,
          detail: { key, sessionOnly: this.sessionOnly },
        }),
      );
    });

    this.root.append(form);
    this.form = form;
    this.input = input;
    this.errorEl = error;
    this.saveButton = save;
    this.showButton = show;
  }

  private renderNano(): HTMLElement | null {
    if (this.nano === 'hidden') {
      return null;
    }
    const section = document.createElement('div');
    section.className = 'nano-section';
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.id = 'nano-hint';
    hint.textContent = msg('nanoDownloadHint');
    section.append(hint);
    if (this.nano === 'downloading') {
      const bar = document.createElement('progress');
      bar.id = 'nano-progress';
      bar.max = 100;
      bar.setAttribute('aria-label', msg('nanoDownloading'));
      if (this.nanoProgress !== null) {
        bar.value = Math.min(1, Math.max(0, this.nanoProgress)) * 100;
      }
      section.append(bar);
      return section;
    }
    if (this.nano === 'failed') {
      const error = document.createElement('p');
      error.className = 'error';
      error.textContent = msg('nanoDownloadFail');
      section.append(error);
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'secondary';
    button.setAttribute('aria-describedby', 'nano-hint');
    button.textContent = msg(this.nanoInstead ? 'nanoTryInstead' : 'nanoTry');
    button.addEventListener('click', () => {
      this.dispatchEvent(new CustomEvent('nano-enable', { bubbles: true, composed: true }));
    });
    section.append(button);
    return section;
  }

  private renderConsent(): void {
    this.clearView();
    const heading = document.createElement('h2');
    heading.tabIndex = -1;
    heading.textContent = msg('consentTitle');
    const body = document.createElement('p');
    body.className = 'consent-body';
    body.textContent = msg('consentBody');
    const buttons = document.createElement('div');
    buttons.className = 'button-row';
    const agree = document.createElement('button');
    agree.type = 'button';
    agree.className = 'primary';
    agree.textContent = msg('agreeButton');
    agree.addEventListener('click', () => this.decide(true));
    const decline = document.createElement('button');
    decline.type = 'button';
    decline.className = 'secondary';
    decline.textContent = msg('declineButton');
    decline.addEventListener('click', () => this.decide(false));
    buttons.append(agree, decline);
    this.root.append(heading, body, buttons);
  }

  private decide(agreed: boolean): void {
    this.dispatchEvent(
      new CustomEvent<ConsentDecisionDetail>('consent-decision', {
        bubbles: true,
        composed: true,
        detail: { agreed },
      }),
    );
  }
}

if (!customElements.get('key-setup')) {
  customElements.define('key-setup', KeySetupElement);
}
