export const wellFormed = (value: string): string => value.toWellFormed();

// Truncates without splitting surrogate pairs, and repairs any lone
// surrogates already in the input (model JSON and page text can carry
// them). Every result is safe to pass to encodeURIComponent.
export const truncateCodePoints = (value: string, max: number): string => {
  const well = value.toWellFormed();
  return well.length <= max ? well : [...well].slice(0, max).join('');
};
