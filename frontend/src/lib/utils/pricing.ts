import type { BillingProduct } from '$lib/services/api';

/**
 * Shared reading of the Polar product list. Two surfaces price the same plans —
 * the landing page's ledger and the /supporter pitch — and when each carried its
 * own copy of these rules they drifted (the Believer filter did, in a way that
 * could have put a patronage price on the Supporter card). Prices themselves
 * still live in exactly one place: the Polar dashboard.
 */

export function formatCents(cents: number, currency: string): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    maximumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);
}

/**
 * Both surfaces frame plans as a monthly price; an annual plan's headline is its
 * per-month equivalent, with the real charge named on the billing line beside it.
 */
export function monthlyPrice(product: BillingProduct): string {
  const cents =
    product.interval === 'year' ? Math.round(product.priceAmount / 12) : product.priceAmount;
  return formatCents(cents, product.priceCurrency);
}

/**
 * The actual charge cadence, always stating the true billed amount so the
 * per-month framing never hides what the card is charged.
 */
export function billingLine(product: BillingProduct): string {
  return product.interval === 'year'
    ? `${formatCents(product.priceAmount, product.priceCurrency)} billed annually`
    : 'Billed monthly';
}

/** The cadence as it reads mid-sentence: "the standard price is $99 a year". */
export function intervalNoun(product: BillingProduct): string {
  return product.interval === 'year' ? 'a year' : 'a month';
}

function isBeliever(product: BillingProduct): boolean {
  return /believer/i.test(product.name);
}

/**
 * Believer is patronage, not a competing plan. Every Believer product is pulled
 * out before any supporter-plan logic runs — every one, not just the first
 * match: Believer can carry a founding and a standard product at once exactly
 * like Supporter does, and a leftover one would become the dearest product of
 * its cadence and be printed as the Supporter card's "standard price".
 */
export function supporterPlans(products: BillingProduct[]): BillingProduct[] {
  return products.filter((p) => !isBeliever(p));
}

/** The Believer product to offer, cheapest first for the same founding reason. */
export function believerPlan(products: BillingProduct[]): BillingProduct | undefined {
  return cheapest(products.filter(isBeliever));
}

export function cheapest(list: BillingProduct[]): BillingProduct | undefined {
  return list.length > 0
    ? list.reduce((a, b) => (a.priceAmount <= b.priceAmount ? a : b))
    : undefined;
}

/**
 * Polar may carry two live supporter products per cadence at once: the standard
 * price and a discounted founding price. Whichever is offered, the dearest of
 * the same cadence becomes the "normally" reference. When the founding product
 * is archived, its cadence collapses to one product and the framing disappears
 * on its own.
 */
export function compareAt(
  list: BillingProduct[],
  offer: BillingProduct | undefined
): BillingProduct | null {
  if (!offer || list.length < 2) return null;
  const dearest = list.reduce((a, b) => (a.priceAmount >= b.priceAmount ? a : b));
  return dearest.priceAmount > offer.priceAmount ? dearest : null;
}
