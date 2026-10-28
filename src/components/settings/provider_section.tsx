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
      <details id="compat-advanced">
        <summary>{msg('compatAdvanced')}</summary>
        <label className="field-row">
          <span id="compat-structured-label">{msg('compatStructured')}</span>
          <select id="compat-structured" defaultValue={compat?.structured || 'json_schema'}>
            <option value="json_schema" id="compat-structured-schema">
              {msg('compatStructuredSchema')}
            </option>
            <option value="json_object" id="compat-structured-object">
              {msg('compatStructuredObject')}
            </option>
          </select>
        </label>
        <label className="field-row">
          <span id="compat-input-rate-label">{msg('compatInputRate')}</span>
          <input
            type="number"
            id="compat-input-rate"
            min="0"
            step="any"
            defaultValue={compat?.inputRate ?? ''}
          />
        </label>
        <label className="field-row">
          <span id="compat-output-rate-label">{msg('compatOutputRate')}</span>
          <input
            type="number"
            id="compat-output-rate"
            min="0"
            step="any"
            defaultValue={compat?.outputRate ?? ''}
          />
        </label>
        <label className="field-row">
          <span id="compat-cached-rate-label">{msg('compatCachedRate')}</span>
          <input
            type="number"
            id="compat-cached-rate"
            min="0"
            step="any"
            defaultValue={compat?.cachedRate ?? ''}
          />
        </label>
      </details>
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
