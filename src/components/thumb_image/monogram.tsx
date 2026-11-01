interface Props {
  name: string;
}

export const Monogram = ({ name }: Props) => (
  <div className="thumb-monogram" aria-hidden="true">
    {[...name.trim()][0] ?? ''}
  </div>
);
