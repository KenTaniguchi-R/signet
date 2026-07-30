const USD = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
});

/** Cents to "$2,800.00". Always two decimals so columns align. */
export function formatCents(cents: number): string {
  return USD.format(cents / 100);
}

const CATEGORY_LABEL: Record<string, string> = {
  venue: 'Venue',
  catering: 'Catering',
  drinks: 'Drinks',
  av: 'AV',
  prizes: 'Prizes',
  supplies: 'Supplies',
};

/** The model emits lowercase enum values; the UI shows them as words. */
export function formatCategory(category: string): string {
  return CATEGORY_LABEL[category] ?? category;
}
