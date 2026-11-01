// Surrogate-safe; every result is safe to pass to encodeURIComponent.
export const truncateCodePoints = (value: string, max: number): string => {
  const well = value.toWellFormed();

  return well.length <= max ? well : [...well].slice(0, max).join('');
};
