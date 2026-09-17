export interface Item {
  name: string;
  priceCents: number;
  qty: number;
}

const DISCOUNT_PERCENT: Record<string, number> = { SAVE10: 10, SAVE25: 25 };

export function subtotal(items: Item[]): number {
  return items.reduce((sum, item) => sum + item.priceCents * item.qty, 0);
}

/** Total in cents after an optional percentage discount code. Unknown codes change nothing. */
export function total(items: Item[], code?: string): number {
  const sum = subtotal(items);
  const percent = code ? DISCOUNT_PERCENT[code] : undefined;
  if (percent === undefined) return sum;
  return sum - percent;
}
