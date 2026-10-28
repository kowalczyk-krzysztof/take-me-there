import { msg } from '../../utils/i18n';

interface Props {
  heading: string;
  headingId: string;
  lineId: string;
  buttonId: string;
  costText: string;
  onReset: () => void;
}

export const CostSection = ({ heading, headingId, lineId, buttonId, costText, onReset }: Props) => (
  <>
    <h2 id={headingId}>{heading}</h2>
    <p id={lineId}>{costText}</p>
    <div className="button-row">
      <button id={buttonId} type="button" onClick={onReset}>
        {msg('resetCostButton')}
      </button>
    </div>
  </>
);
