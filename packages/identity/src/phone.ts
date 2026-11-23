/**
 * Normalises a Nigerian mobile number to E.164 (+234XXXXXXXXXX).
 * Accepts 0803..., 803..., 234803..., +234 803 ... with spaces or dashes.
 * Returns null when the input is not a Nigerian mobile number.
 */
export function normalizeNigerianMobile(input: string): string | null {
  const digits = input.replace(/[\s\-().]/g, '');
  let national: string;
  if (/^\+234\d{10}$/.test(digits)) national = digits.slice(4);
  else if (/^234\d{10}$/.test(digits)) national = digits.slice(3);
  else if (/^0\d{10}$/.test(digits)) national = digits.slice(1);
  else if (/^\d{10}$/.test(digits)) national = digits;
  else return null;
  return /^(70|80|81|90|91)\d{8}$/.test(national) ? `+234${national}` : null;
}

/** "+2348031234567" → "+234 803 *** 4567" for messages and logs. */
export function maskPhone(e164: string): string {
  return `${e164.slice(0, 4)} ${e164.slice(4, 7)} *** ${e164.slice(-4)}`;
}
