interface Props {
  src: string;
}

export const ThumbImage = ({ src }: Props) => (
  <img
    alt=""
    referrerPolicy="no-referrer"
    src={src}
    onError={(event) => event.currentTarget.remove()}
  />
);
