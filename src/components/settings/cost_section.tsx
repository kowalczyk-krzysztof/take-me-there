import { msg } from '../../utils/i18n';

interface Props {
  heading: string;
  headingId: string;
  lineId: string;
  buttonId: string;
  costText: string;
  runText: string;
  runLineId: string;
  onReset: () => void;
}

export const CostSection = ({
  heading,
  headingId,
  lineId,
  buttonId,
  costText,
  runText,
  runLineId,
  onReset,
}: Props) => (
  <>
    <h2 id={headingId}>{heading}</h2>
    <p id={lineId}>{costText}</p>
    {runText ? <p id={runLineId}>{runText}</p> : null}
    <div className="button-row">
      <button id={buttonId} type="button" onClick={onReset}>
        {msg('resetCostButton')}
      </button>
    </div>
  </>
);
