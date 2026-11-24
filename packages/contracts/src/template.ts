/**
 * Contract templates: fixed legal wording with {{placeholders}}. Every commercial value comes
 * from the account's frozen term snapshot. Unknown placeholders are rejected when a template is
 * saved; a missing value is rejected when a contract is issued.
 */
export const PLACEHOLDERS = [
  'company.name',
  'company.supportPhone',
  'contract.reference',
  'contract.issueDate',
  'borrower.name',
  'borrower.phone',
  'asset.description',
  'asset.price',
  'deposit.amount',
  'financed.amount',
  'instalment.amount',
  'instalment.count',
  'instalment.frequency',
  'total.payable',
  'interest.annualRate',
  'interest.method',
  'penalty.dailyRate',
  'penalty.graceDays',
  'arrears.reviewDays',
  'arrears.reactivationDays',
  'guarantors.list',
  'guarantor.maxLiability',
  'schedule.summary',
] as const;
export type Placeholder = (typeof PLACEHOLDERS)[number];

const TOKEN = /\{\{\s*([a-zA-Z.]+)\s*\}\}/g;

export function placeholdersIn(body: string): string[] {
  return [...new Set([...body.matchAll(TOKEN)].map((m) => m[1]!))];
}

export function unknownPlaceholders(body: string): string[] {
  return placeholdersIn(body).filter((p) => !(PLACEHOLDERS as readonly string[]).includes(p));
}

export function render(body: string, values: Partial<Record<Placeholder, string>>): string {
  const missing = placeholdersIn(body).filter((p) => values[p as Placeholder] === undefined);
  if (missing.length) throw new Error(`Missing contract values: ${missing.join(', ')}`);
  return body.replace(TOKEN, (_, p: string) => values[p as Placeholder]!);
}

/**
 * PLACEHOLDER wording so the signing flow can run end to end. It has not been reviewed by a
 * lawyer and must be replaced with counsel-approved wording before any real contract is signed.
 * Every contract issued from it is marked is_placeholder.
 */
export const PLACEHOLDER_MOTORCYCLE_TEMPLATE = {
  title: 'Motorcycle hire purchase agreement (PLACEHOLDER WORDING)',
  body: `PLACEHOLDER WORDING. NOT REVIEWED BY A LAWYER. NOT FOR REAL USE.

HIRE PURCHASE AGREEMENT {{contract.reference}}
Date of issue: {{contract.issueDate}}

Between {{company.name}} ("the Company") and {{borrower.name}}, phone {{borrower.phone}} ("the Hirer").

1. Asset. The Company lets the Hirer have the use of: {{asset.description}}, cash price {{asset.price}}.

2. Deposit. The Hirer has paid a deposit of {{deposit.amount}}. The amount financed is {{financed.amount}}.

3. Repayments. The Hirer will pay {{instalment.count}} {{instalment.frequency}} instalments of about {{instalment.amount}} each, a total of {{total.payable}}. Interest is charged at {{interest.annualRate}} a year on a {{interest.method}} basis.
{{schedule.summary}}

4. Late payment. If an instalment is not paid, penalty interest of {{penalty.dailyRate}} a day is charged on the overdue amount after {{penalty.graceDays}} grace day(s).

5. Repossession. If any instalment is {{arrears.reviewDays}} days overdue, the account is placed under review and the Hirer is told the amount needed to bring it up to date. The Hirer then has {{arrears.reactivationDays}} days to pay it. If it is not paid, the Company may recover the asset. Recovery is decided by Company staff; it is never automatic.

6. Ownership. The asset remains the Company's property until every amount due under this agreement is paid.

7. Guarantors. {{guarantors.list}} If the account is placed under review under clause 5, each guarantor is told by SMS the amount needed and the deadline, and told again if the account is brought up to date. Each guarantor agrees to receive these messages.

Questions: {{company.supportPhone}}.
`,
};

/** What each signer must separately acknowledge before signing. */
export function keyTerms(
  role: 'borrower' | 'guarantor' | 'company',
  v: Partial<Record<Placeholder, string>>,
): { key: string; text: string }[] {
  if (role === 'guarantor') {
    return [
      { key: 'guarantor_liability', text: `I guarantee repayment by ${v['borrower.name']} up to ${v['guarantor.maxLiability']}.` },
      { key: 'guarantor_total', text: `The borrower will repay ${v['total.payable']} in ${v['instalment.count']} ${v['instalment.frequency']} instalments.` },
      { key: 'guarantor_arrears', text: `I may be asked to pay if the borrower falls ${v['arrears.reviewDays']} days behind. I agree to be told by SMS when that happens and how much is owed.` },
      { key: 'guarantor_independent', text: 'I am signing for myself, on my own phone, and nobody else is signing for me.' },
    ];
  }
  if (role === 'borrower') {
    return [
      { key: 'financed', text: `Amount financed: ${v['financed.amount']} after a deposit of ${v['deposit.amount']}.` },
      { key: 'instalments', text: `${v['instalment.count']} ${v['instalment.frequency']} instalments of about ${v['instalment.amount']}.` },
      { key: 'total', text: `Total payable: ${v['total.payable']}.` },
      { key: 'penalty', text: `Penalty interest of ${v['penalty.dailyRate']} a day on overdue amounts after ${v['penalty.graceDays']} grace day(s).` },
      { key: 'repossession', text: `After ${v['arrears.reviewDays']} days overdue the asset may be recovered if I do not pay within ${v['arrears.reactivationDays']} days.` },
    ];
  }
  return [{ key: 'company_authority', text: 'I am authorised to sign this agreement for the Company.' }];
}
