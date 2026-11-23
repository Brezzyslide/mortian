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
