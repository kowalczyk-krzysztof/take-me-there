interface Props {
  lineId: string;
  costText: string;
  runText: string;
  runLineId: string;
}

export const CostSection = ({ lineId, costText, runText, runLineId }: Props) => (
  <>
    <p id={lineId}>{costText}</p>
    {runText ? <p id={runLineId}>{runText}</p> : null}
  </>
);
