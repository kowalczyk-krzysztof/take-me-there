import { msg } from '../../utils/i18n';
import type { CompatFormValues } from '../../settings_ops';

interface Props {
  heading: string;
  ready: boolean;
  providerMuse: boolean;
  compatOpen: boolean;
  compat: CompatFormValues | null;
  compatError: string | null;
  confirmHost: string | null;
  onSave: () => void;
}

export const ProviderSection = ({
  heading,
  ready,
  providerMuse,
  compatOpen,
  compat,
  compatError,
  confirmHost,
  onSave,
}: Props) => (
  <>
    <h2 id="provider-heading">{heading}</h2>
    <div id="provider-group" role="radiogroup" aria-labelledby="provider-heading">
      <label className="radio-row">
        <input
          type="radio"
          name="provider"
          value="muse"
          id="provider-muse"
          defaultChecked={ready && providerMuse}
        />
        <span id="provider-muse-label">{msg('providerMuse')}</span>
      </label>
      <label className="radio-row">
        <input
          type="radio"
          name="provider"
          value="openai_compat"
          id="provider-compat"
          defaultChecked={ready && !providerMuse}
        />
        <span id="provider-compat-label">{msg('providerCompat')}</span>
      </label>
    </div>
    <fieldset id="compat-fields" hidden={!compatOpen || undefined}>
      <legend>{msg('compatLegend')}</legend>
      <label className="field-row">
        <span id="compat-base-url-label">{msg('compatBaseUrl')}</span>
        <input
          type="url"
          id="compat-base-url"
          autoComplete="url"
          defaultValue={compat?.baseURL ?? ''}
        />
      </label>
      <label className="field-row">
        <span id="compat-model-label">{msg('compatModel')}</span>
        <input
          type="text"
          id="compat-model"
          autoComplete="off"
          defaultValue={compat?.model ?? ''}
        />
      </label>
      <div className="button-row">
        <button id="compat-save" type="button" onClick={onSave}>
          {msg(confirmHost ? 'compatSaveAnyway' : 'compatSave')}
        </button>
      </div>
      <p id="compat-error" role="alert" hidden={compatError === null || undefined}>
        {compatError}
      </p>
    </fieldset>
  </>
);
