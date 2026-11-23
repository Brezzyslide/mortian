import { Logger } from '@nestjs/common';
import type { IngestResult, LendingService } from '@project/finance';

const log = new Logger('Allocation');

/**
 * After a payment posts to an account, apply it through the waterfall straight away.
 * A failure here never fails the webhook: the money is safely in the account's credit,
 * and the daily due-date job applies it on its next run.
 */
export async function applyAfterPayment(lending: LendingService, r: IngestResult): Promise<void> {
  if (r.outcome !== 'posted') return;
  try {
    await lending.applyCredit(r.financeAccountId, `payment:${r.eventId}`);
  } catch (err) {
    log.error(`Allocation after payment ${r.eventId} failed; daily job will retry: ${(err as Error).message}`);
  }
}
