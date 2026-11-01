interface Props {
  heading: string;
  headingId: string;
  lineId: string;
  costText: string;
  runText: string;
  runLineId: string;
}

export const CostSection = ({
  heading,
  headingId,
  lineId,
  costText,
  runText,
  runLineId,
}: Props) => (
  <>
    <h2 id={headingId}>{heading}</h2>
    <p id={lineId}>{costText}</p>
    {runText ? <p id={runLineId}>{runText}</p> : null}
  </>
);
