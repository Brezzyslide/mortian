/** Every product line in the programme. All are built; each is switched live independently. */
export const PRODUCT_CODES = [
  'motorcycle_ride_to_own',
  'phone_financing',
  'school_fee_financing',
  'business_equipment_finance',
  'dispatch',
  'purchase_and_deliver',
] as const;

export type ProductCode = (typeof PRODUCT_CODES)[number];

/** Ledger books. A single entry may post to exactly one book. */
export const BOOKS = ['financing', 'dispatch', 'merchant', 'platform'] as const;
export type Book = (typeof BOOKS)[number];

/** Customer-facing product names and one-line descriptions (not brand strings). */
export const PRODUCT_INFO: Record<Exclude<ProductCode, 'dispatch'>, { readonly name: string; readonly summary: string }> = {
  motorcycle_ride_to_own: { name: 'Motorcycle ride-to-own', summary: 'Ride a motorcycle for work and pay it off weekly until you own it.' },
  phone_financing: { name: 'Phone on instalments', summary: 'Get a smartphone now and spread the cost.' },
  school_fee_financing: { name: 'School fees', summary: 'We pay the school; you repay in instalments.' },
  business_equipment_finance: { name: 'Business equipment', summary: 'Finance tools and equipment for your business.' },
  purchase_and_deliver: { name: 'Buy and deliver', summary: 'We buy an item for you and deliver it; you repay in instalments.' },
};
