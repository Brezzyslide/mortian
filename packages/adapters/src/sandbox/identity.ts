import type { IdentityCheckRequest, IdentityCheckResult, IdentityVerification } from '../ports.js';

/**
 * Deterministic sandbox. The outcome is driven by the last digit of the NIN (or BVN)
 * so tests and demos can exercise every branch:
 *   ending 0 → failed, ending 9 → manual_review, anything else → verified.
 * No network calls. Never presented as a real verification.
 */
export class SandboxIdentityVerification implements IdentityVerification {
  readonly info = { port: 'IdentityVerification', provider: 'sandbox', mode: 'sandbox' } as const;

  async verify(req: IdentityCheckRequest): Promise<IdentityCheckResult> {
    const id = req.nin ?? req.bvn;
    if (!id) {
      return { outcome: 'failed', providerReference: `sbx-id-${req.personId}`, reasons: ['no_identifier'] };
    }
    const last = id.at(-1);
    if (last === '0') {
      return { outcome: 'failed', providerReference: `sbx-id-${req.personId}`, reasons: ['identity_mismatch'] };
    }
    if (last === '9') {
      return { outcome: 'manual_review', providerReference: `sbx-id-${req.personId}`, reasons: ['low_confidence'] };
    }
    return { outcome: 'verified', providerReference: `sbx-id-${req.personId}`, reasons: [] };
  }
}
