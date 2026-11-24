import { createHmac, timingSafeEqual } from 'node:crypto';
import { kobo, type Kobo } from '@project/domain';
import {
  InvalidWebhookPayloadError,
  InvalidWebhookSignatureError,
  type ChargePaid,
  type Checkout,
  type CheckoutCharge,
  type Point,
  type RouteEstimate,
  type Routes,
} from '../ports.js';
import { SANDBOX_SIGNATURE_HEADER } from './collections.js';

/** Great-circle distance in metres. */
export function haversineMeters(a: Point, b: Point): number {
  const R = 6_371_000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Simulated routing: straight-line distance times 1.3, a common allowance for roads. Good enough
 * to price test jobs; a maps provider replaces it before real customers are charged by distance.
 */
export class SandboxRoutes implements Routes {
  readonly info = { port: 'Routes', provider: 'sandbox', mode: 'sandbox' } as const;
  async estimate(from: Point, to: Point): Promise<RouteEstimate> {
    return { distanceMeters: Math.max(1, Math.round(haversineMeters(from, to) * 1.3)), source: 'sandbox: straight line x1.3' };
  }
}

/**
 * Our own simulated checkout. Webhook format and HMAC-SHA512 signature are ours, not any real
 * provider's; a real adapter is written from the provider's published docs.
 */
export class SandboxCheckout implements Checkout {
  readonly info = { port: 'Checkout', provider: 'sandbox', mode: 'sandbox' } as const;

  constructor(private readonly webhookSecret: string) {
    if (webhookSecret.length < 16) throw new Error('webhookSecret must be at least 16 characters');
  }

  async createCharge(input: { reference: string; amount: Kobo }): Promise<CheckoutCharge> {
    return { reference: input.reference, payUrl: `sandbox://checkout/${input.reference}?amount=${input.amount}` };
  }

  sign(body: Buffer | string): string {
    return createHmac('sha512', this.webhookSecret).update(body).digest('hex');
  }

  buildWebhook(e: { reference: string; amountKobo: string; paidAt: string; eventId: string }): { body: Buffer; headers: Record<string, string> } {
    const body = Buffer.from(JSON.stringify({ event: 'charge.succeeded', ...e }));
    return { body, headers: { 'content-type': 'application/json', [SANDBOX_SIGNATURE_HEADER]: this.sign(body) } };
  }

  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): ChargePaid | null {
    const given = headers[SANDBOX_SIGNATURE_HEADER];
    if (typeof given !== 'string' || !/^[0-9a-f]{128}$/.test(given)) throw new InvalidWebhookSignatureError();
    if (!timingSafeEqual(Buffer.from(this.sign(rawBody), 'hex'), Buffer.from(given, 'hex'))) throw new InvalidWebhookSignatureError();
    let b: Record<string, unknown>;
    try {
      b = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
    } catch {
      throw new InvalidWebhookPayloadError('not JSON');
    }
    if (b['event'] !== 'charge.succeeded') return null;
    const ref = b['reference'];
    const amount = b['amountKobo'];
    const id = b['eventId'];
    if (typeof ref !== 'string' || !/^[A-Za-z0-9_\-.]{1,100}$/.test(ref)) throw new InvalidWebhookPayloadError('reference');
    if (typeof amount !== 'string' || !/^[1-9][0-9]{0,17}$/.test(amount)) throw new InvalidWebhookPayloadError('amountKobo');
    if (typeof id !== 'string' || !/^[A-Za-z0-9_\-.]{1,100}$/.test(id)) throw new InvalidWebhookPayloadError('eventId');
    const paidAt = new Date(String(b['paidAt']));
    if (Number.isNaN(paidAt.getTime())) throw new InvalidWebhookPayloadError('paidAt');
    return { reference: ref, amount: kobo(BigInt(amount)), paidAt, providerEventId: id };
  }
}
