import { RepoContext } from '../types.js';
import type { PaymentMethodRecord } from '../../../src/types.js';
import {
  type Refund,
  type Payout,
  mapRefundRow,
  mapPayoutRow,
  mapPaymentMethodRow
} from '../../store.js';
import { encryptSecret } from './paymentGateways.js';
import {
  isBankLikePaymentMethod,
  isCardLikePaymentMethod,
  normalizePaymentMethodType
} from './checkoutLogic.js';

export type { PaymentMethodRecord };

export function sanitizePaymentMethodForClient<T extends Record<string, any>>(pm: T): T {
  if (!pm || typeof pm !== 'object') return pm;
  const details = pm.details && typeof pm.details === 'object' ? { ...pm.details } : pm.details;
  if (details && typeof details === 'object') {
    delete details.encryptedAccountNumber;
    delete details.encryptedRoutingNumber;
    delete details.iban;
    delete details.account_number;
    delete details.routing_number;
    delete details.cardNumber;
    delete details.number;
    delete details.cvv;
    delete details.cvc;
    delete details.pin;
    delete details.password;
    delete details.secret;
    if (typeof details.accountNumber === 'string' && details.accountNumber.length > 4 && !details.accountNumber.includes('••••')) {
      details.accountNumber = `••••${details.accountNumber.slice(-4)}`;
    }
    if (typeof details.routingNumber === 'string' && details.routingNumber.length > 4 && !details.routingNumber.includes('••••')) {
      details.routingNumber = `••••${details.routingNumber.slice(-4)}`;
    }
  }
  return { ...pm, details };
}

export class FinanceRepo {
  constructor(private ctx: RepoContext) {}

  // --- REFUNDS ---
  async saveRefunds(refunds: Refund[]): Promise<void> {
    return this.ctx.withLock('refunds', async () => {
      if (!refunds) return;
      const client = await this.ctx.getPool().connect();
      try {
        await client.query('BEGIN');
        const seen = new Set<string>();
        for (const ref of refunds) {
          if (!ref?.id || seen.has(ref.id)) continue;
          seen.add(ref.id);

          const existing = await client.query('SELECT * FROM refunds WHERE id = $1 FOR UPDATE', [ref.id]);
          if (existing.rows.length > 0) {
            const row = existing.rows[0];
            if (Math.abs(Number(row.amount) - Number(ref.amount)) > 0.001 || row.order_id !== ref.orderId || row.buyer_id !== ref.buyerId) {
              throw new Error(`Immutable financial record violation: Cannot modify amount, order_id, or buyer_id for refund ${ref.id}`);
            }
          }

          await client.query(
            `INSERT INTO refunds (id, order_id, buyer_id, amount, reason, status, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (id) DO UPDATE SET
               status = EXCLUDED.status,
               reason = COALESCE(EXCLUDED.reason, refunds.reason)`,
            [ref.id, ref.orderId, ref.buyerId, ref.amount, ref.reason || null, ref.status, ref.createdAt]
          );
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    });
  }

  async saveRefund(ref: Refund): Promise<void> {
    return this.saveRefunds([ref]);
  }

  async listRefunds(): Promise<Refund[]> {
    const res = await this.ctx.getPool().query('SELECT * FROM refunds');
    return res.rows.map(mapRefundRow);
  }

  async getRefundById(id: string): Promise<Refund | null> {
    const res = await this.ctx.getPool().query('SELECT * FROM refunds WHERE id = $1', [id]);
    return res.rows.length > 0 ? mapRefundRow(res.rows[0]) : null;
  }

  async listRefundsForOrder(orderId: string): Promise<Refund[]> {
    const res = await this.ctx.getPool().query('SELECT * FROM refunds WHERE order_id = $1 ORDER BY created_at DESC', [orderId]);
    return res.rows.map(mapRefundRow);
  }

  // --- PAYOUTS ---
  async savePayout(p: Payout): Promise<void> {
    if (!p?.id) return;
    return this.ctx.withLock(`payout_${p.id}`, async () => {
      const client = await this.ctx.getPool().connect();
      try {
        await client.query('BEGIN');
        const existing = await client.query('SELECT * FROM payouts WHERE id = $1 FOR UPDATE', [p.id]);
        if (existing.rows.length > 0) {
          const row = existing.rows[0];
          if (
            Math.abs(Number(row.amount) - Number(p.amount)) > 0.001 ||
            row.freelancer_id !== p.freelancerId ||
            (row.method && p.method && row.method !== p.method) ||
            (row.account_details && p.accountDetails && String(row.account_details).trim() !== String(p.accountDetails).trim())
          ) {
            throw new Error(`Immutable financial record violation: Cannot modify core payout parameters for payout ${p.id}`);
          }
        }
        await client.query(
          `INSERT INTO payouts (id, freelancer_id, amount, method, status, created_at, processed_at, account_details)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (id) DO UPDATE SET
             status = EXCLUDED.status,
             processed_at = COALESCE(EXCLUDED.processed_at, payouts.processed_at),
             updated_at = NOW()`,
          [p.id, p.freelancerId, p.amount, p.method, p.status, p.createdAt, p.processedAt || null, p.accountDetails || null]
        );
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    });
  }

  async savePayouts(payouts: Payout[]): Promise<void> {
    return this.ctx.withLock('payouts', async () => {
      if (!payouts) return;
      const client = await this.ctx.getPool().connect();
      try {
        await client.query('BEGIN');
        for (const p of payouts) {
          if (!p?.id) continue;
          const existing = await client.query('SELECT * FROM payouts WHERE id = $1 FOR UPDATE', [p.id]);
          if (existing.rows.length > 0) {
            const row = existing.rows[0];
            if (
              Math.abs(Number(row.amount) - Number(p.amount)) > 0.001 ||
              row.freelancer_id !== p.freelancerId ||
              (row.method && p.method && row.method !== p.method) ||
              (row.account_details && p.accountDetails && String(row.account_details).trim() !== String(p.accountDetails).trim())
            ) {
              throw new Error(`Immutable financial record violation: Cannot modify core payout parameters for payout ${p.id}`);
            }
          }
          await client.query(
            `INSERT INTO payouts (id, freelancer_id, amount, method, status, created_at, processed_at, account_details)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (id) DO UPDATE SET
               status = EXCLUDED.status,
               processed_at = COALESCE(EXCLUDED.processed_at, payouts.processed_at),
               updated_at = NOW()`,
            [p.id, p.freelancerId, p.amount, p.method, p.status, p.createdAt, p.processedAt || null, p.accountDetails || null]
          );
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    });
  }

  async listPayouts(): Promise<Payout[]> {
    const res = await this.ctx.getPool().query('SELECT * FROM payouts ORDER BY created_at DESC');
    return res.rows.map(mapPayoutRow);
  }

  async getPayoutById(id: string): Promise<Payout | null> {
    const res = await this.ctx.getPool().query('SELECT * FROM payouts WHERE id = $1', [id]);
    return res.rows.length > 0 ? mapPayoutRow(res.rows[0]) : null;
  }

  async listPayoutsForUser(freelancerId: string): Promise<Payout[]> {
    const res = await this.ctx.getPool().query(
      'SELECT * FROM payouts WHERE freelancer_id = $1 ORDER BY created_at DESC',
      [freelancerId]
    );
    return res.rows.map(mapPayoutRow);
  }

  // --- PAYMENT METHODS ---
  mapPaymentMethodRow(r: any): PaymentMethodRecord {
    return mapPaymentMethodRow(r);
  }

  async getPaymentMethodById(id: string): Promise<PaymentMethodRecord | null> {
    const res = await this.ctx.getPool().query('SELECT * FROM payment_methods WHERE id = $1', [id]);
    return res.rows.length > 0 ? this.mapPaymentMethodRow(res.rows[0]) : null;
  }

  async listPaymentMethodsForUser(userId: string): Promise<PaymentMethodRecord[]> {
    const res = await this.ctx.getPool().query(
      'SELECT * FROM payment_methods WHERE user_id = $1 ORDER BY is_default DESC, created_at DESC',
      [userId]
    );
    return res.rows.map(r => this.mapPaymentMethodRow(r));
  }

  async listPaymentMethods(): Promise<PaymentMethodRecord[]> {
    const res = await this.ctx.getPool().query('SELECT * FROM payment_methods ORDER BY created_at DESC');
    return res.rows.map(r => this.mapPaymentMethodRow(r));
  }

  private validateAndNormalizePaymentMethodDetails(type: string, details: any): Record<string, any> {
    const rawType = (type || '').trim();
    if (!rawType) {
      throw new Error('Payment method type is required.');
    }
    const normType = normalizePaymentMethodType(rawType);

    const rawDetails = details && typeof details === 'object' ? { ...details } : {};

    // Strip sensitive secrets from stored details
    delete rawDetails.cvv;
    delete rawDetails.cvc;
    delete rawDetails.pin;
    delete rawDetails.password;
    delete rawDetails.secret;

    if (normType === 'paypal') {
      const email = String(rawDetails.email || rawDetails.paypalEmail || rawDetails.handle || '').trim().toLowerCase();
      if (!email || !email.includes('@')) {
        throw new Error('Invalid PayPal payment method: a valid email address is required.');
      }
      return { ...rawDetails, email };
    } else if (isBankLikePaymentMethod(normType)) {
      const acct = String(rawDetails.accountNumber || rawDetails.iban || rawDetails.account_number || '').trim();
      if (!acct || acct.length < 4) {
        throw new Error('Invalid bank transfer method: account number or IBAN is required.');
      }
      const maskedAcct = acct.length > 4 ? `••••${acct.slice(-4)}` : acct;
      const encryptedAcct = !acct.includes('••••') ? encryptSecret(acct) : (rawDetails.encryptedAccountNumber || undefined);
      const rawRouting = String(rawDetails.routingNumber || rawDetails.routing_number || '').trim();
      const maskedRouting = rawRouting
        ? (rawRouting.length > 4 && !rawRouting.includes('••••') ? `••••${rawRouting.slice(-4)}` : rawRouting)
        : undefined;
      const encryptedRouting = rawRouting && !rawRouting.includes('••••')
        ? encryptSecret(rawRouting)
        : (rawDetails.encryptedRoutingNumber || undefined);

      delete rawDetails.iban;
      delete rawDetails.account_number;
      delete rawDetails.routing_number;
      delete rawDetails.cardNumber;
      delete rawDetails.number;
      return {
        ...rawDetails,
        accountNumber: maskedAcct,
        accountLast4: acct.slice(-4),
        encryptedAccountNumber: encryptedAcct,
        routingNumber: maskedRouting,
        encryptedRoutingNumber: encryptedRouting,
        bankName: rawDetails.bankName ? String(rawDetails.bankName).trim() : undefined
      };
    } else if (normType === 'crypto') {
      const address = String(rawDetails.address || rawDetails.walletAddress || '').trim();
      if (!address || address.length < 10) {
        throw new Error('Invalid crypto payment method: a valid wallet address is required.');
      }
      return { ...rawDetails, address };
    } else if (isCardLikePaymentMethod(normType)) {
      const rawCard = String(rawDetails.cardNumber || rawDetails.number || '').replace(/\D/g, '');
      const last4 = String(rawDetails.last4 || rawDetails.cardLast4 || (rawCard.length >= 4 ? rawCard.slice(-4) : '')).trim();
      delete rawDetails.cardNumber;
      delete rawDetails.number;
      return {
        ...rawDetails,
        last4: last4 || '••••',
        brand: rawDetails.brand ? String(rawDetails.brand).trim() : 'card'
      };
    }

    delete rawDetails.cardNumber;
    delete rawDetails.number;
    return rawDetails;
  }

  async savePaymentMethod(pm: PaymentMethodRecord | any): Promise<void> {
    if (!pm?.id) return;
    const validatedDetails = this.validateAndNormalizePaymentMethodDetails(pm.type, pm.details);
    return this.ctx.withLock(`pm_${pm.userId}`, async () => {
      const client = await this.ctx.getPool().connect();
      try {
        await client.query('BEGIN');
        const existing = await client.query('SELECT user_id FROM payment_methods WHERE id = $1 FOR UPDATE', [pm.id]);
        if (existing.rows.length > 0 && existing.rows[0].user_id !== pm.userId) {
          throw new Error('Forbidden: Payment method ID belongs to another user.');
        }
        if (pm.isDefault) {
          await client.query('UPDATE payment_methods SET is_default = false WHERE user_id = $1', [pm.userId]);
        }
        await client.query(
          `INSERT INTO payment_methods (id, user_id, type, name, details, is_default, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (id) DO UPDATE SET
             type = EXCLUDED.type,
             name = EXCLUDED.name,
             details = EXCLUDED.details,
             is_default = EXCLUDED.is_default
           WHERE payment_methods.user_id = EXCLUDED.user_id`,
          [pm.id, pm.userId, pm.type, pm.name, JSON.stringify(validatedDetails), Boolean(pm.isDefault), pm.createdAt || new Date().toISOString().substring(0, 10)]
        );
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    });
  }

  async savePaymentMethods(methods: PaymentMethodRecord[]): Promise<void> {
    for (const m of methods) {
      await this.savePaymentMethod(m);
    }
  }

  async deletePaymentMethod(id: string): Promise<void> {
    const client = await this.ctx.getPool().connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query('SELECT user_id, is_default FROM payment_methods WHERE id = $1 FOR UPDATE', [id]);
      if (existing.rows.length > 0) {
        const { user_id: userId, is_default: wasDefault } = existing.rows[0];
        await client.query('DELETE FROM payment_methods WHERE id = $1', [id]);
        if (wasDefault && userId) {
          await client.query(
            `UPDATE payment_methods SET is_default = true
             WHERE id = (SELECT id FROM payment_methods WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1)`,
            [userId]
          );
        }
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async setDefaultPaymentMethod(userId: string, id: string): Promise<void> {
    return this.ctx.withLock(`pm_${userId}`, async () => {
      const client = await this.ctx.getPool().connect();
      try {
        await client.query('BEGIN');
        await client.query('UPDATE payment_methods SET is_default = false WHERE user_id = $1', [userId]);
        await client.query('UPDATE payment_methods SET is_default = true WHERE id = $1 AND user_id = $2', [id, userId]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    });
  }

  // --- PAYMENT GATEWAYS ---
  async savePaymentGateways(gateways: any): Promise<void> {
    return this.ctx.withLock('payment_gateways', async () => {
      await this.ctx.getPool().query(
        `INSERT INTO payment_gateways (key, value, updated_at)
         VALUES ('primary', $1, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [JSON.stringify(gateways)]
      );
    });
  }

  async loadPaymentGateways(): Promise<any | null> {
    const res = await this.ctx.getPool().query("SELECT value FROM payment_gateways WHERE key = 'primary'");
    return res.rows.length > 0 ? res.rows[0].value : null;
  }

  // --- FINANCIAL LEDGER STATE (DEPRECATED: Normalized PostgreSQL tables are sole source of truth) ---
  async saveLedgerState(_state: any): Promise<void> {
    // No-op: Legacy in-memory ledger snapshot persistence is disabled to prevent overwriting normalized PostgreSQL financial tables.
    return Promise.resolve();
  }

  async loadLedgerState(): Promise<any | null> {
    // No-op: Legacy in-memory ledger snapshot hydration is disabled; PostgreSQL normalized tables are authoritative.
    return null;
  }
}

