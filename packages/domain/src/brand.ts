/**
 * The only place brand strings live. Replace PROJECT_NAME values when a name is chosen.
 * Values can be overridden per environment through BRAND_* variables at build time.
 */
export interface BrandConfig {
  /** Product name shown to customers and staff. */
  readonly name: string;
  /**
   * The registered company that is party to every agreement, exactly as registered with CAC.
   * Not the product name: contracts are between the customer and the company.
   */
  readonly legalName: string;
  readonly shortName: string;
  readonly supportPhone: string;
  readonly supportEmail: string;
  readonly primaryColor: string;
}

export const brand: BrandConfig = {
  name: 'PROJECT_NAME',
  legalName: 'PROJECT_LEGAL_NAME',
  shortName: 'PROJECT_NAME',
  supportPhone: '+234 000 000 0000',
  supportEmail: 'support@example.com',
  primaryColor: '#1F4E79',
};
