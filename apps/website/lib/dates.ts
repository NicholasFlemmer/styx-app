/** `29 September 2026` → a Date at UTC midnight. The pages carry their dates in words; the sitemap wants ISO. */
export const dayOf = (words: string): Date => {
  const d = new Date(`${words} UTC`);
  if (Number.isNaN(d.getTime())) throw new Error(`not a date: ${words}`);
  return d;
};
