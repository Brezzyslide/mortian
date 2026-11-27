/**
 * Fee types staff can charge on a financing account. Starting list: edit labels or add codes
 * here (codes are stored on fee_charge rows, so never rename a code once it has been used).
 */
export const FEE_TYPES = {
  processing_fee: 'Processing fee',
  documentation_fee: 'Documentation fee',
  tracker_installation: 'Tracker installation',
  vehicle_registration: 'Vehicle registration and papers',
  insurance: 'Insurance',
  recovery_cost: 'Recovery cost',
  late_documentation: 'Late documents',
} as const;

export type FeeCode = keyof typeof FEE_TYPES;
export const FEE_CODES = Object.keys(FEE_TYPES) as [FeeCode, ...FeeCode[]];
export const isFeeCode = (c: string): c is FeeCode => Object.hasOwn(FEE_TYPES, c);
