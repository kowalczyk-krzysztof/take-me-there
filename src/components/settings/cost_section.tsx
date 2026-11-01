interface Props {
  heading: string;
  headingId: string;
  lineId: string;
  costText: string;
}

export const CostSection = ({ heading, headingId, lineId, costText }: Props) => (
  <>
    <h2 id={headingId}>{heading}</h2>
    <p id={lineId}>{costText}</p>
  </>
);
