import { Router, Request, Response } from 'express';
import express from 'express';
import { wrapRouter } from '../../middleware/asyncHandler.js';
import { randomUUID, createHmac, timingSafeEqual } from 'crypto';
import {
  store,
  cleanAllStoreData,
  mapDisputeRow,
  mapPayoutRow,
  mapPaymentMethodRow,
  type Message,
  type Payout,
  type Dispute,
  type Refund,
  type Order,
  type CustomInvoice,
  type PaymentMethodRecord
} from '../../store.js';
import { postgresStore, isPostgresEnabled } from '../../db/postgresStore.js';
import { financialTransactionService, financialRepository, checkOrRecordIdempotency, recordIdempotencyResult } from './financial.service.js';
import { diagnosticService } from '../../services/diagnosticService.js';
import { financeLedger, FinanceLedgerEngine } from './financeLedger.js';
import { paymentGatewayManager } from './paymentGateways.js';
import { sanitizePaymentMethodForClient } from './finance.repo.js';
import { computeCheckoutSplit, sanitizeSafeReturnPath } from './checkoutLogic.js';
import { SITE_CONFIG } from '../../../src/siteConfig.js';
import { canManageAgencyPayouts } from '../identity/rbac.js';

import {
  requireAuth,
  requireActiveStatus,
  requireFinancialActiveStatus,
  requireRole,
  requireAdmin,
  adminActor,
  rateLimit,
  resolveAuthenticatedUserId,
  isStaffUser,
  IS_PRODUCTION,
  formatApiError,
  areSimulatedDepositsAllowed
} from '../../middleware/auth.js';
import {
  orderStateLocks,
  tryAcquireOrderLock,
  releaseOrderLock,
  resolveGigOrderPrice,
  enrichOrderWithServiceInfo,
  releaseOrderFunds,
  refundOrderFunds,
  fundOrderEscrowWithEvent,
  topUpOrderEscrowWithEvent,
  recordOrder,
  syncUserBalances,
  ensureWallet,
  LATE_ORDER_PROTECTION_HOURS,
  registerAuditLog,
  validateOrderReleasePreconditions,
  parseDeadlineInstant,
  processAutoAcceptOrders
} from '../../services/orderService.js';
import { siteSettings, DEFAULT_SITE_SETTINGS } from '../../../src/server/siteSettings.js';
import { broadcastMessage } from '../../websocket.js';
import { recordMessage, emitSystemEvent } from '../../services/messagingService.js';
import { closeActiveDispute } from '../../services/disputeService.js';
import {
  handlePayoutRequest,
  approvePayout,
  processPayout,
  rejectPayout,
  failPayout,
  retryPayout,
  formatPayoutRow
} from './payout.service.js';
import { DEFAULT_FEE_CONFIG, calculateOrderFees, quoteOrderWithLiveSettings, toCents } from './fees.js';

let checkoutSchemaInitialized = false;
export async function ensurePaymentCheckoutSchema(pool: any): Promise<void> {
  if (checkoutSchemaInitialized) return;
  try {
    await pool.query(`
      ALTER TABLE payment_checkout_sessions ADD COLUMN IF NOT EXISTS environment VARCHAR(32) NOT NULL DEFAULT 'sandbox';
      ALTER TABLE payment_checkout_sessions ADD COLUMN IF NOT EXISTS paypal_order_id VARCHAR(128);
      ALTER TABLE payment_checkout_sessions ADD COLUMN IF NOT EXISTS paypal_capture_id VARCHAR(128);
      ALTER TABLE payment_checkout_sessions ADD COLUMN IF NOT EXISTS last_webhook_event_id VARCHAR(128);
      ALTER TABLE payment_checkout_sessions ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;
      ALTER TABLE payment_checkout_sessions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
      CREATE TABLE IF NOT EXISTS payment_webhook_events (
        event_id VARCHAR(128) PRIMARY KEY,
        gateway VARCHAR(32) NOT NULL,
        event_type VARCHAR(128) NOT NULL,
        resource_id VARCHAR(128),
        session_id VARCHAR(64),
        status VARCHAR(32) NOT NULL DEFAULT 'received',
        payload JSONB,
        error_message TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        processed_at TIMESTAMPTZ
      );
    `);
    checkoutSchemaInitialized = true;
  } catch {
    // Non-fatal if running against mocked test pool
  }
}

function formatRefundRow(r: any): Refund {
  return {
    id: r.id,
    orderId: r.order_id,
    buyerId: r.buyer_id,
    amount: Number(r.amount),
    reason: r.reason || '',
    status: r.status,
    createdAt: r.created_at
  };
}

function formatPaymentMethodRow(r: any): PaymentMethodRecord {
  return mapPaymentMethodRow(r);
}

const router = Router();

// ==========================================
// PUBLIC FEES & INQUIRIES
// ==========================================

router.get(['/fees/quote', '/payments/quote'], async (req: Request, res: Response) => {
  try {
    let gigPrice: number;
    if (typeof req.query.gigId === 'string' && req.query.gigId) {
      const extraIds = typeof req.query.extraIds === 'string' && req.query.extraIds ? req.query.extraIds.split(',') : [];
      const resolved = await resolveGigOrderPrice(req.query.gigId, extraIds);
      gigPrice = resolved.gigPrice;
    } else {
      gigPrice = Number(req.query.amount);
    }
    if (!Number.isFinite(gigPrice) || gigPrice < 0) return res.status(400).json({ error: 'A valid gigId or amount is required.' });
    
    // Authoritative fee calculation using live admin settings
    const q = await quoteOrderWithLiveSettings(gigPrice);
    const activeSettings = siteSettings.getSettings();
    res.json({
      ...q,
      config: {
        commissionPercent: q.commissionPercent ?? DEFAULT_FEE_CONFIG.commissionPercent,
        buyerFeePercent: q.buyerFeePercent ?? DEFAULT_FEE_CONFIG.buyerFeePercent,
        smallOrderFee: q.smallOrderFee,
        smallOrderThreshold: activeSettings.commission?.smallOrderFeeThreshold ?? DEFAULT_FEE_CONFIG.smallOrderThreshold,
        minimumOrderAmount: activeSettings.commission?.minimumOrderAmount ?? (DEFAULT_FEE_CONFIG.minimumOrderAmount ?? 5.00)
      }
    });
  } catch (err: any) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

router.get('/fees/config', async (_req: Request, res: Response) => {
  try {
    await siteSettings.refreshFromDatabase();
    const settings = siteSettings.getSettings();
    const comm = settings.commission;
    const market = settings.marketplace;
    res.json({
      success: true,
      commissionPercent: comm?.commissionPercent ?? DEFAULT_FEE_CONFIG.commissionPercent,
      buyerFeePercent: comm?.buyerProcessingFeePercent ?? DEFAULT_FEE_CONFIG.buyerFeePercent,
      clientServiceFee: comm?.buyerProcessingFeePercent ?? DEFAULT_FEE_CONFIG.buyerFeePercent,
      smallOrderFee: comm?.smallOrderFeeAmount ?? DEFAULT_FEE_CONFIG.smallOrderFee,
      smallOrderFeeAmount: comm?.smallOrderFeeAmount ?? DEFAULT_FEE_CONFIG.smallOrderFee,
      smallOrderFeeThreshold: comm?.smallOrderFeeThreshold ?? DEFAULT_FEE_CONFIG.smallOrderThreshold,
      smallOrderThreshold: comm?.smallOrderFeeThreshold ?? DEFAULT_FEE_CONFIG.smallOrderThreshold,
      minimumOrderAmount: comm?.minimumOrderAmount ?? (DEFAULT_FEE_CONFIG.minimumOrderAmount ?? 5.00),
      minimumGigPrice: market?.minimumGigPrice ?? 5.00,
      maximumGigPrice: market?.maximumGigPrice ?? 10000.00,
      minimumProjectBudget: market?.minimumProjectBudget ?? 5.00,
      maximumProjectBudget: market?.maximumProjectBudget ?? 50000.00
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/payments/gateways/public', async (_req: Request, res: Response) => {
  try {
    await paymentGatewayManager.refreshFromDatabase(false);
    const data = paymentGatewayManager.getPublicGatewayOptions();
    res.json({
      success: true,
      ...data
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to load available payment gateways.' });
  }
});

router.post('/checkout/start', requireAuth, requireFinancialActiveStatus, rateLimit(20, 60_000), async (req: Request, res: Response) => {
  try {
    const authUserId = (req as any).authenticatedUserId;
    const {
      purpose: rawPurpose,
      gigId,
      extraIds,
      orderId: rawOrderId,
      amount: rawTopupAmount,
      requirements: rawRequirements,
      gateway: rawGateway,
      useWallet = false,
      returnPath: rawReturnPath
    } = req.body || {};

    const pool = postgresStore.getPool();
    await ensurePaymentCheckoutSchema(pool);
    await paymentGatewayManager.refreshFromDatabase(false);

    const callerRes = await pool.query('SELECT id, name, status FROM users WHERE id = $1', [authUserId]);
    const caller = callerRes.rows[0];
    if (!caller) return res.status(401).json({ error: 'Unauthorized' });

    const resolvedKind: 'order_payment' | 'wallet_topup' =
      rawPurpose === 'wallet_topup' || rawPurpose === 'deposit'
        ? 'wallet_topup'
        : (gigId || rawOrderId ? 'order_payment' : 'wallet_topup');

    const explicitGateway = rawGateway !== undefined && rawGateway !== null && String(rawGateway).trim() !== ''
      ? String(rawGateway).trim().toLowerCase()
      : '';
    if (explicitGateway && !['paypal', 'stripe', 'razorpay'].includes(explicitGateway)) {
      return res.status(400).json({ error: `Unsupported payment gateway "${rawGateway}".` });
    }
    const normalizedGateway = paymentGatewayManager.resolveActiveGatewayName(explicitGateway || undefined);

    const activeEnv: 'production' | 'sandbox' = normalizedGateway === 'paypal'
      ? paymentGatewayManager.getActivePayPalEnvironment()
      : (IS_PRODUCTION ? 'production' : 'sandbox');

    // ==============================================
    // PATH 1: Explicit Account Credit / Wallet Top-up
    // ==============================================
    if (resolvedKind === 'wallet_topup') {
      const topupAmount = Number(rawTopupAmount);
      if (!Number.isFinite(topupAmount) || topupAmount < 1.00 || topupAmount > 100_000 || Math.abs(Math.round(topupAmount * 100) - topupAmount * 100) > 1e-6) {
        return res.status(400).json({ error: 'Top-up amount must be between $1.00 and $100,000.00 USD (up to 2 decimal places).' });
      }
      const cleanAmount = Number((toCents(topupAmount) / 100).toFixed(2));
      await ensureWallet(authUserId);

      const checkoutId = 'chk_' + randomUUID();
      const safeReturnPath = sanitizeSafeReturnPath(rawReturnPath, '/wallet');

      await pool.query(
        `INSERT INTO payment_checkout_sessions
           (id, user_id, order_id, gateway, expected_amount, currency, purpose, status, environment, metadata, created_at, updated_at)
         VALUES ($1, $2, NULL, $3, $4, 'USD', 'deposit', 'reserving', $5, $6, NOW(), NOW())`,
        [
          checkoutId,
          authUserId,
          normalizedGateway,
          cleanAmount,
          activeEnv,
          JSON.stringify({
            title: 'Account Credit Top-Up',
            returnPath: safeReturnPath,
            walletTopup: true
          })
        ]
      );

      let providerSession;
      try {
        providerSession = await paymentGatewayManager.createCheckoutSession({
          gateway: normalizedGateway,
          amount: cleanAmount,
          currency: 'USD',
          userId: authUserId,
          purpose: 'deposit',
          description: `${SITE_CONFIG.brandName} Account Credit ($${cleanAmount.toFixed(2)})`,
          checkoutId,
          env: activeEnv
        });
      } catch (providerErr: any) {
        await pool.query("UPDATE payment_checkout_sessions SET status = 'failed', updated_at = NOW() WHERE id = $1", [checkoutId]).catch(() => {});
        throw providerErr;
      }

      const paypalOrderId = normalizedGateway === 'paypal' ? providerSession.providerSessionId : null;
      await pool.query(
        `UPDATE payment_checkout_sessions
            SET status = 'pending',
                provider_tx_id = $1::text,
                paypal_order_id = $2::text,
                updated_at = NOW()
          WHERE id = $3::text`,
        [providerSession.providerSessionId, paypalOrderId, checkoutId]
      );

      return res.json({
        success: true,
        paidImmediately: false,
        purpose: 'deposit',
        checkoutId,
        sessionId: checkoutId,
        gateway: normalizedGateway,
        orderTotal: cleanAmount,
        walletApplied: 0,
        gatewayAmount: cleanAmount,
        amount: cleanAmount,
        currency: 'USD',
        environment: activeEnv,
        redirectUrl: providerSession.checkoutUrl
      });
    }

    // ==============================================
    // PATH 2: Direct, 100% Wallet, or Split Order Payment
    // ==============================================
    await ensureWallet(authUserId);

    const existingOrderId = rawOrderId ? String(rawOrderId).trim() : null;
    let orderIdToUse = existingOrderId || ('ord_' + randomUUID().slice(0, 12));
    let workspaceIdToUse = 'ws_' + randomUUID().slice(0, 12);
    let orderTitle = '';
    let sellerId = '';
    let baseOrderAmount = 0;
    let feeBreakdown: any = null;
    let selectedExtrasDetails: any[] = [];
    let deliveryDays = 7;
    let isExistingOrder = false;

    if (existingOrderId) {
      const ordRes = await pool.query('SELECT * FROM orders WHERE id = $1', [existingOrderId]);
      if (ordRes.rows.length === 0) {
        return res.status(404).json({ error: 'Order not found.' });
      }
      const ord = ordRes.rows[0];
      if (ord.buyer_id !== authUserId) {
        return res.status(403).json({ error: 'Forbidden: You can only pay for your own order.' });
      }
      if (!['payment_pending', 'pending'].includes(ord.status)) {
        return res.status(400).json({ error: `Order is already in status "${ord.status}" and is not awaiting payment.` });
      }
      const existingEsc = await pool.query('SELECT status FROM escrows WHERE order_id = $1', [existingOrderId]);
      if (existingEsc.rows.length > 0) {
        return res.status(400).json({ error: 'Order escrow is already funded.' });
      }
      isExistingOrder = true;
      orderIdToUse = ord.id;
      workspaceIdToUse = ord.workspace_id || workspaceIdToUse;
      orderTitle = ord.title;
      sellerId = ord.seller_id;
      baseOrderAmount = Number(ord.amount);
      const parsedBreakdown = typeof ord.fee_breakdown === 'string'
        ? (() => { try { return JSON.parse(ord.fee_breakdown); } catch { return null; } })()
        : ord.fee_breakdown;
      feeBreakdown = parsedBreakdown || await quoteOrderWithLiveSettings(baseOrderAmount);
    } else {
      if (!gigId || typeof gigId !== 'string') {
        return res.status(400).json({ error: 'Either gigId or orderId is required for order checkout.' });
      }
      const normalizedExtraIds = Array.isArray(extraIds)
        ? Array.from(new Set(extraIds.map(String).filter(Boolean))).sort()
        : [];
      const resolved = await resolveGigOrderPrice(gigId, normalizedExtraIds);
      sellerId = String(resolved.gig.freelancer_id || resolved.gig.freelancerId || '');
      if (!sellerId) {
        return res.status(400).json({ error: 'Service seller could not be determined.' });
      }
      if (sellerId === authUserId) {
        return res.status(400).json({ error: 'You cannot place an order on your own service.' });
      }
      const sellerRes = await pool.query('SELECT id, status FROM users WHERE id = $1', [sellerId]);
      if (sellerRes.rows.length === 0 || sellerRes.rows[0].status !== 'active') {
        return res.status(403).json({ error: 'This seller account is currently unavailable for new orders.' });
      }
      await ensureWallet(sellerId);

      const activeSettings = siteSettings.getSettings();
      const minOrderAmount = Number(activeSettings.marketplace?.minimumGigPrice ?? activeSettings.commission?.minimumOrderAmount ?? 5);
      if (!Number.isFinite(resolved.gigPrice) || resolved.gigPrice < minOrderAmount) {
        return res.status(400).json({ error: `Minimum order amount is $${minOrderAmount.toFixed(2)}.` });
      }

      baseOrderAmount = resolved.gigPrice;
      orderTitle = resolved.extrasTitles.length > 0
        ? `${resolved.gig.title} (+ ${resolved.extrasTitles.join(', ')})`
        : String(resolved.gig.title || 'Service Order');
      selectedExtrasDetails = resolved.selectedExtrasDetails || [];
      deliveryDays = Math.max(1, Math.min(365, resolved.totalDeliveryDays || 7));
      feeBreakdown = await quoteOrderWithLiveSettings(baseOrderAmount).catch(() => calculateOrderFees(baseOrderAmount));
    }

    const orderTotal = Number((feeBreakdown?.clientTotal ?? baseOrderAmount).toFixed(2));
    const currentWalletBalance = await financialRepository.getWalletBalance(authUserId);
    let split = computeCheckoutSplit({
      orderTotal,
      walletBalance: currentWalletBalance,
      useWallet: Boolean(useWallet)
    });

    // Gateways require a $1.00 minimum charge; if split leaves < $1.00 for the gateway, adjust walletApplied slightly
    if (!split.payFullyWithWallet && split.gatewayAmount > 0 && split.gatewayAmount < 1.00 && orderTotal >= 1.00) {
      const adjustedWallet = Math.max(0, Number(((toCents(orderTotal) - 100) / 100).toFixed(2)));
      split = {
        orderTotal,
        walletApplied: adjustedWallet,
        gatewayAmount: Number(((toCents(orderTotal) - toCents(adjustedWallet)) / 100).toFixed(2)),
        payFullyWithWallet: false
      };
    }

    const today = new Date().toISOString().split('T')[0];
    const serverDerivedDueDate = new Date(Date.now() + deliveryDays * 86400000).toISOString();
    const requirements = typeof rawRequirements === 'string' ? rawRequirements.trim().slice(0, 2000) : '';
    const serviceFee = Number(feeBreakdown?.buyerFee ?? 0);
    const smallOrderFee = Number(feeBreakdown?.smallOrderFee ?? 0);
    const escrowProtectionEndDate = new Date(
      Date.now() + (siteSettings.getSettings().commission.escrowProtectionDays || DEFAULT_SITE_SETTINGS.commission.escrowProtectionDays) * 86400000
    ).toISOString().split('T')[0];

    const ensureOrderCreatedInTx = async (client: any) => {
      if (isExistingOrder) {
        const ordLock = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderIdToUse]);
        if (ordLock.rows.length === 0) throw { status: 404, message: 'Order not found.' };
        if (!['payment_pending', 'pending'].includes(ordLock.rows[0].status)) {
          throw { status: 400, message: `Order is already in status "${ordLock.rows[0].status}".` };
        }
        return ordLock.rows[0];
      }

      await client.query(
        `INSERT INTO workspaces (workspace_id, buyer_id, seller_id, order_ids, title, created_at, updated_at, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (workspace_id) DO NOTHING`,
        [
          workspaceIdToUse,
          authUserId,
          sellerId,
          JSON.stringify([orderIdToUse]),
          orderTitle,
          today,
          new Date().toISOString(),
          JSON.stringify({ originType: 'gig', originId: gigId || orderIdToUse, status: 'active', activeOrderId: orderIdToUse, isInquiry: false })
        ]
      );

      await client.query(
        `INSERT INTO orders (
          id, title, buyer_id, seller_id, client_id, freelancer_id, amount, status, created_at, due_date,
          requirements, deliverable_files, revisions, is_muted,
          escrow_protection_start_date, escrow_protection_end_date, gig_id,
          is_timer_paused, fee_breakdown, delivery_history,
          workspace_id, order_type, gig_order_id,
          extension_requests, free_extension_used, cancellation_history,
          service_fee, small_order_fee, selected_extras, updated_at
        ) VALUES (
          $1, $2, $3, $4, $3, $4, $5, 'payment_pending', $6, $7,
          $8, '[]'::jsonb, '[]'::jsonb, false,
          $9, $10, $11,
          false, $12, '[]'::jsonb,
          $13, 'gig', $1,
          '[]'::jsonb, false, '[]'::jsonb,
          $14, $15, $16, NOW()
        )`,
        [
          orderIdToUse,
          orderTitle,
          authUserId,
          sellerId,
          baseOrderAmount,
          today,
          serverDerivedDueDate,
          requirements || null,
          today,
          escrowProtectionEndDate,
          gigId || null,
          JSON.stringify(feeBreakdown),
          workspaceIdToUse,
          serviceFee,
          smallOrderFee,
          JSON.stringify(selectedExtrasDetails)
        ]
      );

      const created = await client.query('SELECT * FROM orders WHERE id = $1', [orderIdToUse]);
      return created.rows[0];
    };

    // CASE A: 100% Covered by Account Credit (Wallet)
    if (split.payFullyWithWallet) {
      await postgresStore.executeInTransaction(async (client) => {
        const ordRow = await ensureOrderCreatedInTx(client);
        await financialTransactionService.fundEscrow({
          orderId: ordRow.id,
          orderTitle: ordRow.title,
          amount: Number(ordRow.amount),
          buyerId: ordRow.buyer_id,
          sellerId: ordRow.seller_id,
          actor: `user:${authUserId}`,
          idempotencyKey: `CHK-WALLET-${ordRow.id}`
        }, client);
        await client.query("UPDATE orders SET status = 'funded_in_escrow', updated_at = NOW() WHERE id = $1", [ordRow.id]);
      });

      await syncUserBalances([authUserId, sellerId]);
      const newBalance = await financialRepository.getWalletBalance(authUserId);
      const savedOrder = await store.getOrder(orderIdToUse);

      return res.status(201).json({
        success: true,
        paidImmediately: true,
        purpose: 'order_payment',
        gateway: 'wallet',
        orderId: orderIdToUse,
        workspaceId: workspaceIdToUse,
        order: savedOrder ? enrichOrderWithServiceInfo(savedOrder) : null,
        orderTotal: split.orderTotal,
        walletApplied: split.walletApplied,
        gatewayAmount: 0,
        availableBalance: newBalance,
        redirectUrl: `/workstream/${orderIdToUse}`
      });
    }

    // CASE B: Hosted Gateway Payment (Direct or Split Wallet + Gateway)
    if (normalizedGateway === 'paypal' && activeEnv === 'production') {
      const prodGw = paymentGatewayManager.getGateway('paypal', 'production');
      if (!prodGw || !prodGw.enabled || !prodGw.clientId || !prodGw.clientSecret) {
        return res.status(400).json({
          error: 'PayPal Live mode is active, but PayPal Live credentials are not configured in Super Admin Panel.'
        });
      }
    }

    const checkoutId = 'chk_' + randomUUID();
    const safeReturnPath = sanitizeSafeReturnPath(rawReturnPath, `/workstream/${orderIdToUse}`);

    await postgresStore.executeInTransaction(async (client) => {
      await ensureOrderCreatedInTx(client);
      await client.query(
        `INSERT INTO payment_checkout_sessions
           (id, user_id, order_id, gateway, expected_amount, currency, purpose, status, environment, metadata, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, 'USD', 'order_payment', 'reserving', $6, $7, NOW(), NOW())`,
        [
          checkoutId,
          authUserId,
          orderIdToUse,
          normalizedGateway,
          split.gatewayAmount,
          activeEnv,
          JSON.stringify({
            directOrderCheckout: true,
            title: orderTitle,
            orderTotal: split.orderTotal,
            walletApplied: split.walletApplied,
            gatewayAmount: split.gatewayAmount,
            returnPath: safeReturnPath
          })
        ]
      );
    });

    let providerSession;
    try {
      providerSession = await paymentGatewayManager.createCheckoutSession({
        gateway: normalizedGateway,
        amount: split.gatewayAmount,
        currency: 'USD',
        userId: authUserId,
        orderId: orderIdToUse,
        purpose: 'order_payment',
        description: `${SITE_CONFIG.brandName} Order: ${orderTitle.slice(0, 90)}`,
        checkoutId,
        env: activeEnv
      });
    } catch (providerErr: any) {
      await pool.query("UPDATE payment_checkout_sessions SET status = 'failed', updated_at = NOW() WHERE id = $1", [checkoutId]).catch(() => {});
      throw providerErr;
    }

    const paypalOrderId = normalizedGateway === 'paypal' ? providerSession.providerSessionId : null;
    await pool.query(
      `UPDATE payment_checkout_sessions
          SET status = 'pending',
              provider_tx_id = $1::text,
              paypal_order_id = $2::text,
              updated_at = NOW()
        WHERE id = $3::text`,
      [providerSession.providerSessionId, paypalOrderId, checkoutId]
    );

    return res.json({
      success: true,
      paidImmediately: false,
      purpose: 'order_payment',
      checkoutId,
      sessionId: checkoutId,
      orderId: orderIdToUse,
      workspaceId: workspaceIdToUse,
      gateway: normalizedGateway,
      paypalOrderId: paypalOrderId || undefined,
      providerOrderId: providerSession.providerSessionId,
      orderTotal: split.orderTotal,
      walletApplied: split.walletApplied,
      gatewayAmount: split.gatewayAmount,
      amount: split.gatewayAmount,
      currency: 'USD',
      environment: activeEnv,
      redirectUrl: providerSession.checkoutUrl
    });
  } catch (err: any) {
    const statusCode = typeof err?.status === 'number' ? err.status : 500;
    res.status(statusCode).json(statusCode >= 500 ? formatApiError(err) : { error: err?.message || 'Checkout initialization failed.' });
  }
});

router.get('/disputes', requireAuth, async (req: Request, res: Response) => {
  try {
    const authUserId = (req as any).authenticatedUserId;
    const pool = postgresStore.getPool();
    const callerRes = await pool.query('SELECT role FROM users WHERE id = $1', [authUserId]);
    const caller = callerRes.rows[0];
    const isAdmin = caller?.role === 'admin' || caller?.role === 'super_admin' || caller?.role === 'support';

    let result;
    if (isAdmin) {
      result = await pool.query('SELECT * FROM disputes ORDER BY created_at DESC');
    } else {
      result = await pool.query(
        `SELECT d.* FROM disputes d
         LEFT JOIN orders o ON d.order_id = o.id
         WHERE d.raised_by = $1 OR d.buyer_id = $1 OR d.seller_id = $1 OR o.buyer_id = $1 OR o.seller_id = $1
         ORDER BY d.created_at DESC`,
        [authUserId]
      );
    }
    res.json(result.rows.map(mapDisputeRow));
  } catch (err: any) {
    res.status(500).json(formatApiError(err));
  }
});

router.get('/refunds', requireAuth, async (req: Request, res: Response) => {
  try {
    const authUserId = (req as any).authenticatedUserId;
    const pool = postgresStore.getPool();
    const callerRes = await pool.query('SELECT role FROM users WHERE id = $1', [authUserId]);
    const caller = callerRes.rows[0];
    const isAdmin = caller?.role === 'admin' || caller?.role === 'super_admin' || caller?.role === 'support';

    let result;
    if (isAdmin) {
      result = await pool.query('SELECT * FROM refunds ORDER BY created_at DESC');
    } else {
      result = await pool.query(
        `SELECT r.* FROM refunds r
         LEFT JOIN orders o ON r.order_id = o.id
         WHERE r.buyer_id = $1 OR o.buyer_id = $1 OR o.seller_id = $1
         ORDER BY r.created_at DESC`,
        [authUserId]
      );
    }
    res.json(result.rows.map(formatRefundRow));
  } catch (err: any) {
    res.status(500).json(formatApiError(err));
  }
});

router.get('/payouts', requireAuth, async (req: Request, res: Response) => {
  try {
    const authUserId = (req as any).authenticatedUserId;
    const pool = postgresStore.getPool();
    const callerRes = await pool.query('SELECT role FROM users WHERE id = $1', [authUserId]);
    const caller = callerRes.rows[0];
    if (!canManageAgencyPayouts(caller, SITE_CONFIG.AGENCY_MODE)) {
      return res.status(403).json({ error: 'Forbidden: Payout history is restricted to agency administrators and staff.' });
    }
    const canViewAllPayouts = caller?.role === 'admin' || caller?.role === 'super_admin' || caller?.role === 'finance_manager' || caller?.role === 'support';

    const payoutsList = canViewAllPayouts
      ? await store.listPayouts()
      : await store.listPayoutsForUser(authUserId);
    res.json(payoutsList);
  } catch (err: any) {
    res.status(500).json(formatApiError(err));
  }
});

router.post('/payouts', requireAuth, requireFinancialActiveStatus, rateLimit(10, 60_000), handlePayoutRequest);

// ==========================================
// USER PAYMENTS SNAPSHOT & ESCROW APIS
// ==========================================

router.get('/payments/user/:userId', requireAuth, async (req: Request, res: Response) => {
  try {
    const authUserId = (req as any).authenticatedUserId;
    const targetUserId = req.params.userId;
    const caller = await store.getUser(authUserId);
    const isAdmin = caller?.role === 'admin' || caller?.role === 'super_admin';
    if (!isAdmin && authUserId !== targetUserId) {
      return res.status(403).json({ error: 'Forbidden: Access to another user financial snapshot is not allowed.' });
    }

    const userId = targetUserId;
    await processAutoAcceptOrders();
    await financialTransactionService.processEarningsClearing();

    const u = await store.getUser(userId);
    
    if (u) {
      await financialTransactionService.ensureWallet(u.id);
    }

    const wallet = await financialRepository.getWallet(userId);
    const availableBalance = wallet?.availableBalance ?? Number(u?.walletBalance || 0);
    
    const userOrders = await store.listOrdersForUser(userId);
    const allUsers = await store.listUsers();
    const userMap = new Map(allUsers.map(usr => [usr.id, usr]));
    const orderById = new Map(userOrders.map(ord => [ord.id, ord]));
    const userOrderIds = userOrders.map(ord => ord.id);

    const buyerEscrowAmount = await financialRepository.getBuyerHeldEscrowTotal(userId);
    const freelancerEscrowAmount = await financialRepository.getFreelancerHeldEscrowTotal(userId);

    const currentSettings = siteSettings.getSettings();
    const commSettings = currentSettings?.commission;
    const walletSettings = currentSettings?.wallets;
    const clearingPeriodDays = Number(commSettings?.escrowProtectionDays ?? 14) || 14;
    const commissionPercent = Number(commSettings?.commissionPercent ?? 20);
    const buyerFeePercent = Number(commSettings?.buyerProcessingFeePercent ?? 1);
    const smallOrderFeeAmount = Number(commSettings?.smallOrderFeeAmount ?? 1);
    const smallOrderFeeThreshold = Number(commSettings?.smallOrderFeeThreshold ?? 200);
    const minimumWithdrawalAmount = Number(walletSettings?.minimumWithdrawalAmount ?? 3);
    const maximumWithdrawalPerTransaction = Number(walletSettings?.maximumWithdrawalPerTransaction ?? 5000);
    const dailyWithdrawalLimit = Number(walletSettings?.dailyWithdrawalLimit ?? 10000);

    const currentYearMonth = new Date().toISOString().slice(0, 7);
    const twoMonthsAgoDate = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);

    const pool = postgresStore.getPool();

    // 1. Authoritative Buyer Ledger Entries (Account 2010: Buyer Wallets Payable)
    // Debits on 2010 with order_id represent actual buyer escrow funding & top-ups (including buyer fees).
    // Credits on 2010 with order_id represent actual buyer refunds (including refunded buyer fees).
    const buyerLedgerRes = await pool.query(
      `SELECT le.user_id, le.order_id, le.debit, le.credit, lj.event_type, lj.created_at
       FROM ledger_entries le
       JOIN ledger_journals lj ON lj.id = le.journal_id
       WHERE le.account_code = '2010'
         AND le.order_id IS NOT NULL
         AND (le.user_id = $1 OR le.order_id = ANY($2::varchar[]))`,
      [userId, userOrderIds]
    );

    const orderBuyerDebitsCents = new Map<string, number>();
    const orderBuyerCreditsCents = new Map<string, number>();
    let userBuyerTotalDebitsCents = 0;
    let userBuyerTotalCreditsCents = 0;
    let userBuyerMonthlyDebitsCents = 0;
    let userBuyerMonthlyCreditsCents = 0;

    for (const row of buyerLedgerRes.rows) {
      const ordId = String(row.order_id || '');
      if (!ordId) continue;
      const debitCents = Math.round(Number(row.debit || 0) * 100);
      const creditCents = Math.round(Number(row.credit || 0) * 100);

      orderBuyerDebitsCents.set(ordId, (orderBuyerDebitsCents.get(ordId) || 0) + debitCents);
      orderBuyerCreditsCents.set(ordId, (orderBuyerCreditsCents.get(ordId) || 0) + creditCents);

      if (row.user_id === userId) {
        userBuyerTotalDebitsCents += debitCents;
        userBuyerTotalCreditsCents += creditCents;

        let journalYm = '';
        if (row.created_at) {
          try {
            journalYm = new Date(row.created_at).toISOString().slice(0, 7);
          } catch {}
        }
        if (!journalYm && row.timestamp) {
          journalYm = String(row.timestamp).slice(0, 7);
        }
        if (journalYm === currentYearMonth) {
          userBuyerMonthlyDebitsCents += debitCents;
          userBuyerMonthlyCreditsCents += creditCents;
        }
      }
    }

    // 2. Authoritative Seller Earnings from earnings_clearing (strictly status 'clearing' or 'completed')
    const clearingRes = await pool.query(
      `SELECT id, order_id, seller_id, amount, clearance_start, clearance_end, status, payout_eligible
       FROM earnings_clearing
       WHERE status IN ('clearing', 'completed')
         AND (seller_id = $1 OR order_id = ANY($2::varchar[]))`,
      [userId, userOrderIds]
    );

    const orderSellerEarnedCents = new Map<string, number>();
    const orderSellerPendingClearanceCents = new Map<string, number>();
    let userEarnedToDateCents = 0;
    let userEarnedThisMonthCents = 0;
    let userEarnedPastTwoMonthsCents = 0;
    let userPendingClearanceCents = 0;
    let userGigEarnedToDateCents = 0;
    let userGigEarnedThisMonthCents = 0;
    let userProjectEarnedToDateCents = 0;
    let userProjectEarnedThisMonthCents = 0;

    for (const row of clearingRes.rows) {
      const rowStatus = String(row.status || '').toLowerCase();
      if (rowStatus !== 'clearing' && rowStatus !== 'completed') continue;

      const ordId = String(row.order_id || '');
      const amountCents = Math.round(Number(row.amount || 0) * 100);
      if (amountCents <= 0) continue;

      if (ordId) {
        orderSellerEarnedCents.set(ordId, (orderSellerEarnedCents.get(ordId) || 0) + amountCents);
        if (rowStatus === 'clearing') {
          orderSellerPendingClearanceCents.set(ordId, (orderSellerPendingClearanceCents.get(ordId) || 0) + amountCents);
        }
      }

      if (row.seller_id === userId) {
        userEarnedToDateCents += amountCents;
        if (rowStatus === 'clearing') {
          userPendingClearanceCents += amountCents;
        }

        const linkedOrder = orderById.get(ordId);
        let startIso = '';
        if (row.clearance_start) {
          try {
            startIso = new Date(row.clearance_start).toISOString();
          } catch {}
        }
        if (!startIso && row.clearance_end) {
          try {
            const endMs = new Date(row.clearance_end).getTime();
            if (!isNaN(endMs)) {
              startIso = new Date(endMs - 14 * 86400000).toISOString();
            }
          } catch {}
        }
        if (!startIso && linkedOrder?.completedAt) {
          try {
            startIso = new Date(linkedOrder.completedAt).toISOString();
          } catch {}
        }
        const startYm = startIso.slice(0, 7);
        const startDate = startIso.slice(0, 10);

        if (startYm === currentYearMonth) {
          userEarnedThisMonthCents += amountCents;
        }
        if (startDate && startDate >= twoMonthsAgoDate) {
          userEarnedPastTwoMonthsCents += amountCents;
        }

        const isProjectOrder = linkedOrder
          ? (linkedOrder.orderType === 'project' || (linkedOrder as any).type === 'project' || Boolean(linkedOrder.projectId))
          : false;
        if (isProjectOrder) {
          userProjectEarnedToDateCents += amountCents;
          if (startYm === currentYearMonth) {
            userProjectEarnedThisMonthCents += amountCents;
          }
        } else {
          userGigEarnedToDateCents += amountCents;
          if (startYm === currentYearMonth) {
            userGigEarnedThisMonthCents += amountCents;
          }
        }
      }
    }

    // 3. Authoritative Escrows & Active Disputes for user's orders
    const [escrowsRes, disputesRes] = await Promise.all([
      userOrderIds.length > 0
        ? pool.query('SELECT * FROM escrows WHERE order_id = ANY($1::varchar[])', [userOrderIds])
        : Promise.resolve({ rows: [] as any[] }),
      userOrderIds.length > 0
        ? pool.query(
            "SELECT order_id, status FROM disputes WHERE order_id = ANY($1::varchar[]) AND status IN ('open', 'under_investigation', 'under_review')",
            [userOrderIds]
          )
        : Promise.resolve({ rows: [] as any[] })
    ]);

    const escrowRowMap = new Map<string, any>();
    for (const r of escrowsRes.rows) {
      escrowRowMap.set(r.order_id, r);
    }
    const activeDisputedOrderIds = new Set<string>(disputesRes.rows.map((r: any) => String(r.order_id)));

    const enrichOrderFinancialRow = async (o: Order) => {
      const escRow = escrowRowMap.get(o.id);
      const esc = escRow ? financialRepository.formatEscrowRow(escRow) : null;
      const offers = await store.listOffersForOrder(o.id);

      const inEscrow = esc ? Number(Number(esc.remaining || 0).toFixed(2)) : 0;
      const releasedGross = esc ? Number(Number(esc.releasedGross || 0).toFixed(2)) : 0;
      const refundedGross = esc ? Number(Number(esc.refundedTotal || 0).toFixed(2)) : 0;
      const totalEscrowGross = esc
        ? Number(
            Math.max(
              Number(esc.amount || 0),
              releasedGross + inEscrow + refundedGross
            ).toFixed(2)
          )
        : 0;
      const escrowFunded = totalEscrowGross;

      const buyerDebitsCents = orderBuyerDebitsCents.get(o.id) || 0;
      const buyerCreditsCents = orderBuyerCreditsCents.get(o.id) || 0;
      const buyerGrossFunded = Number((buyerDebitsCents / 100).toFixed(2));
      const buyerRefundedAmount = Number((buyerCreditsCents / 100).toFixed(2));
      const netPaidByBuyer = Number(Math.max(0, (buyerDebitsCents - buyerCreditsCents) / 100).toFixed(2));

      const feesRefundedAmount = Number(
        Math.max(0, (buyerCreditsCents - Math.round(refundedGross * 100)) / 100).toFixed(2)
      );
      const feesRefunded = Boolean(escRow?.fees_refunded) || feesRefundedAmount > 0;

      const freelancerNetEarned = Number(((orderSellerEarnedCents.get(o.id) || 0) / 100).toFixed(2));
      const freelancerPendingClearance = Number(((orderSellerPendingClearanceCents.get(o.id) || 0) / 100).toFixed(2));

      const depositRequests = offers.filter(off => (off.kind === 'deposit' || off.kind === 'proposal') && off.status === 'pending');
      const pendingInvoices = offers.filter(off => off.kind === 'invoice' && off.status === 'pending');
      const paidInvoiceOffers = offers.filter(off => off.kind === 'invoice' && off.status === 'paid');
      const paidOffersSum = paidInvoiceOffers.reduce((s, off) => s + Number(off.amount || 0), 0);
      const paidInvoiceAmount = Number(Math.max(paidOffersSum, releasedGross).toFixed(2));
      const hasPaidInvoice = releasedGross > 0 || paidInvoiceOffers.length > 0;
      const buyerUser = userMap.get(o.buyerId);
      const sellerUser = userMap.get(o.sellerId);
      const isDisputed = activeDisputedOrderIds.has(o.id) || o.status === 'disputed';

      return {
        ...enrichOrderWithServiceInfo(o),
        buyerName: buyerUser?.name || (o as any).buyerName || o.buyerUsername || 'Buyer',
        sellerName: sellerUser?.name || (o as any).sellerName || o.sellerUsername || 'Freelancer',
        inEscrow,
        escrowFunded,
        releasedGross,
        refundedGross,
        escrowStatus: esc?.status || 'not_funded',
        buyerGrossFunded,
        buyerRefundedAmount,
        netPaidByBuyer,
        feesRefunded,
        feesRefundedAmount,
        freelancerNetEarned,
        freelancerPendingClearance,
        isDisputed,
        depositRequests,
        pendingInvoices,
        paidInvoiceAmount,
        hasPaidInvoice
      };
    };

    const allEnrichedOrders = await Promise.all(userOrders.map(enrichOrderFinancialRow));
    const orderFinancials: Record<string, any> = {};
    for (const row of allEnrichedOrders) {
      orderFinancials[row.id] = row;
    }

    const buyerEscrowOrders = allEnrichedOrders.filter(o => o.buyerId === userId && o.inEscrow > 0);
    const freelancerEscrowOrders = allEnrichedOrders.filter(o => o.sellerId === userId && o.inEscrow > 0);

    const hasOrderFinancialActivity = (row: any) =>
      row.inEscrow > 0 ||
      row.releasedGross > 0 ||
      row.refundedGross > 0 ||
      row.buyerGrossFunded > 0 ||
      row.buyerRefundedAmount > 0 ||
      row.freelancerNetEarned > 0;

    const buyerOrdersSummary = allEnrichedOrders.filter(
      o => o.buyerId === userId && (o.status !== 'cancelled' || hasOrderFinancialActivity(o))
    );
    const freelancerOrdersSummary = allEnrichedOrders.filter(
      o => o.sellerId === userId && (o.status !== 'cancelled' || hasOrderFinancialActivity(o))
    );

    const paidToDate = Number(Math.max(0, (userBuyerTotalDebitsCents - userBuyerTotalCreditsCents) / 100).toFixed(2));
    const paidThisMonth = Number((userBuyerMonthlyDebitsCents / 100).toFixed(2));
    const buyerRefundedToDate = Number((userBuyerTotalCreditsCents / 100).toFixed(2));
    const buyerRefundedThisMonth = Number((userBuyerMonthlyCreditsCents / 100).toFixed(2));
    const buyerNetPaidThisMonth = Number(Math.max(0, (userBuyerMonthlyDebitsCents - userBuyerMonthlyCreditsCents) / 100).toFixed(2));

    const buyerReleasedGrossTotal = Number(
      (
        allEnrichedOrders
          .filter(o => o.buyerId === userId)
          .reduce((sumCents, o) => sumCents + Math.round(Number(o.releasedGross || 0) * 100), 0) / 100
      ).toFixed(2)
    );

    const earnedToDate = Number((userEarnedToDateCents / 100).toFixed(2));
    const earnedThisMonth = Number((userEarnedThisMonthCents / 100).toFixed(2));
    const earnedPastTwoMonths = Number((userEarnedPastTwoMonthsCents / 100).toFixed(2));
    const pendingClearance = Number((userPendingClearanceCents / 100).toFixed(2));
    const gigEarnedToDate = Number((userGigEarnedToDateCents / 100).toFixed(2));
    const gigEarnedThisMonth = Number((userGigEarnedThisMonthCents / 100).toFixed(2));
    const projectEarnedToDate = Number((userProjectEarnedToDateCents / 100).toFixed(2));
    const projectEarnedThisMonth = Number((userProjectEarnedThisMonthCents / 100).toFixed(2));

    let userMethods: PaymentMethodRecord[] = [];
    if (canManageAgencyPayouts(caller, SITE_CONFIG.AGENCY_MODE)) {
      try {
        userMethods = await store.listPaymentMethodsForUser(userId);
      } catch {}
    }

    res.json({
      userId,
      availableBalance,
      withdrawableBalance: availableBalance,
      pendingClearance,
      buyerEscrowAmount,
      freelancerEscrowAmount,
      buyerEscrowOrders,
      freelancerEscrowOrders,
      buyerOrdersSummary,
      freelancerOrdersSummary,
      orderFinancials,
      paidToDate,
      paidThisMonth,
      buyerRefundedToDate,
      buyerRefundedThisMonth,
      buyerNetPaidThisMonth,
      buyerReleasedGrossTotal,
      earnedToDate,
      earnedThisMonth,
      earnedPastTwoMonths,
      gigEarnedToDate,
      gigEarnedThisMonth,
      projectEarnedToDate,
      projectEarnedThisMonth,
      clearingPeriodDays,
      commissionPercent,
      buyerFeePercent,
      smallOrderFeeAmount,
      smallOrderFeeThreshold,
      minimumWithdrawalAmount,
      maximumWithdrawalPerTransaction,
      dailyWithdrawalLimit,
      paymentMethods: userMethods,
      walletStatus: wallet?.status || 'active'
    });
  } catch (err: any) {
    res.status(500).json(formatApiError(err));
  }
});

router.post('/payments/escrow/deposit', requireAuth, requireFinancialActiveStatus, rateLimit(15, 60_000), async (req: Request, res: Response) => {
  const { orderId, amount: rawAmount, title: rawTitle, fundSource = 'wallet', idempotencyKey: rawKey } = req.body || {};
  if (!orderId || typeof orderId !== 'string') {
    return res.status(400).json({ error: 'Order ID is required to fund escrow.' });
  }
  if (!tryAcquireOrderLock(orderId, res)) return;
  try {
    const authUserId = (req as any).authenticatedUserId;
    const caller = await store.getUser(authUserId);
    if (!caller) return res.status(401).json({ error: 'Unauthorized' });

    const order = await store.getOrder(orderId);
    if (!order) return res.status(404).json({ error: 'Order not found.' });

    const isAdmin = caller.role === 'admin' || caller.role === 'super_admin';
    if (!isAdmin && order.buyerId !== authUserId) {
      return res.status(403).json({ error: 'Forbidden: Only the buyer of this order can deposit into its escrow.' });
    }

    const rawNumAmount = Number(rawAmount);
    if (!Number.isFinite(rawNumAmount) || rawNumAmount <= 0 || Math.abs(Math.round(rawNumAmount * 100) - rawNumAmount * 100) > 1e-6) {
      return res.status(400).json({ error: 'Please enter a valid escrow deposit amount greater than $0.00 with at most 2 decimal places.' });
    }
    const amount = Math.round(rawNumAmount * 100) / 100;
    if (amount < 5) {
      return res.status(400).json({ error: 'Minimum escrow deposit amount is $5.00.' });
    }
    if (amount > 100000) {
      return res.status(400).json({ error: 'Amount exceeds maximum limit ($100,000.00).' });
    }

    await ensureWallet(order.buyerId);
    await ensureWallet(order.sellerId);

    const resolvedKey =
      rawKey ||
      req.body?.requestKey ||
      req.headers['x-idempotency-key'] ||
      req.headers['idempotency-key'];
    const idempotencyKey = String(resolvedKey || `escrow-dep-${order.id}-${Date.now()}`);
    const walletBal = await financialRepository.getWalletBalance(order.buyerId);

    // If buyer selected instant card/gateway deposit or needs wallet top-up when simulated deposits are enabled
    if (fundSource === 'instant_deposit' || (walletBal < amount && req.body?.autoDeposit === true)) {
      if (!areSimulatedDepositsAllowed()) {
        const shortfall = fundSource === 'instant_deposit' ? amount : Math.max(1, Number((amount - walletBal).toFixed(2)));
        return res.status(400).json({
          error: 'Insufficient wallet balance. Please deposit funds first.',
          code: 'INSUFFICIENT_FUNDS',
          requiredAmount: amount,
          availableBalance: walletBal,
          shortfall
        });
      }
      const shortfall = fundSource === 'instant_deposit' ? amount : Math.max(0, Number((amount - walletBal).toFixed(2)));
      if (shortfall > 0) {
        if (shortfall > 5000) {
          return res.status(400).json({ error: 'Simulated instant deposits are limited to $5,000.00 per transaction.' });
        }
        await financialTransactionService.creditDeposit({
          userId: order.buyerId,
          amount: shortfall,
          actor: `${caller.name} (Escrow Instant Deposit)`,
          idempotencyKey: `SIM-ESC-${order.buyerId}-${idempotencyKey}`
        });
      }
    }

    const existingEscrow = await financialRepository.getEscrow(order.id);
    const today = new Date().toISOString().split('T')[0];
    const protectionDays = siteSettings.getSettings()?.commission?.escrowProtectionDays || 14;
    const protectionEnd = new Date(Date.now() + protectionDays * 86400000).toISOString().split('T')[0];
    const depositTitle = (typeof rawTitle === 'string' && rawTitle.trim()) ? rawTitle.trim() : `Escrow deposit for ${order.title}`;

    let targetOrder = order;

    if (!existingEscrow && ['payment_pending', 'pending', 'in_progress'].includes(order.status)) {
      await fundOrderEscrowWithEvent({
        orderId: order.id,
        orderTitle: order.title,
        amount,
        buyerId: order.buyerId,
        sellerId: order.sellerId,
        actor: `user:${order.buyerId}`,
        idempotencyKey
      });
      order.amount = amount;
      order.status = 'funded_in_escrow';
      order.escrowProtectionStartDate = today;
      order.escrowProtectionEndDate = protectionEnd;
      await store.saveOrder(order);
      await emitSystemEvent(order.id, 'escrow_funded', `🔒 $${amount.toFixed(2)} USD funded into escrow by ${caller.name}.`, { amount });
    } else if ((order.status as string) === 'completed' || (order.status as string) === 'cancelled' || (existingEscrow && existingEscrow.remaining === 0 && (order.status as string) === 'completed')) {
      const newOrderId = 'ord_' + randomUUID().slice(0, 12);
      const isGigOrder = order.orderType === 'gig' || (Boolean(order.gigId) && !order.projectId);
      const orderType: 'gig' | 'project' = isGigOrder ? 'gig' : 'project';
      const newOrder: Order = {
        id: newOrderId,
        workspaceId: order.workspaceId,
        orderType,
        ...(orderType === 'gig' ? { gigOrderId: newOrderId } : { projectOrderId: newOrderId }),
        title: depositTitle,
        buyerId: order.buyerId,
        sellerId: order.sellerId,
        amount,
        status: 'payment_pending',
        createdAt: today,
        dueDate: new Date(Date.now() + 7 * 86400000).toISOString(),
        escrowProtectionStartDate: today,
        escrowProtectionEndDate: protectionEnd,
        feeBreakdown: calculateOrderFees(amount),
        projectId: order.projectId,
        gigId: order.gigId
      };
      const enrichedNew = enrichOrderWithServiceInfo(newOrder);
      await recordOrder(enrichedNew);
      await store.saveOrder(enrichedNew);

      await fundOrderEscrowWithEvent({
        orderId: newOrder.id,
        orderTitle: newOrder.title,
        amount,
        buyerId: newOrder.buyerId,
        sellerId: newOrder.sellerId,
        actor: `user:${newOrder.buyerId}`,
        idempotencyKey
      });
      enrichedNew.status = 'funded_in_escrow';
      await store.saveOrder(enrichedNew);
      await emitSystemEvent(newOrder.id, 'order_created', `Follow-on Escrow Deposit placed: ${newOrder.title} ($${amount.toFixed(2)} USD held in escrow).`);
      targetOrder = enrichedNew;
    } else {
      await topUpOrderEscrowWithEvent({
        orderId: order.id,
        orderTitle: depositTitle,
        amount,
        buyerId: order.buyerId,
        sellerId: order.sellerId,
        actor: `user:${order.buyerId}`,
        idempotencyKey
      });
      order.amount = Math.round((Number(order.amount || 0) + amount) * 100) / 100;
      await store.saveOrder(order);
    }

    // Mark any matching pending deposit offer as accepted
    const orderOffers = await store.listOffersForOrder(order.id);
    const pendingDep = orderOffers.find(o => o.kind === 'deposit' && o.status === 'pending');
    if (pendingDep) {
      await postgresStore.getPool().query(
        "UPDATE workstream_offers SET status = 'accepted', resolved_at = $1, resolved_by = $2 WHERE id = $3",
        [new Date().toISOString(), caller.id, pendingDep.id]
      );
    }

    await syncUserBalances([order.buyerId, order.sellerId]);
    res.json({ success: true, order: enrichOrderWithServiceInfo(targetOrder), amount });
  } catch (err: any) {
    res.status(400).json({
      error: err.message || 'Failed to deposit into escrow.',
      ...(err?.code ? { code: err.code, requiredAmount: err.requiredAmount, availableBalance: err.availableBalance, shortfall: err.shortfall } : {})
    });
  } finally {
    releaseOrderLock(orderId);
  }
});

router.post('/payments/withdraw', requireAuth, requireFinancialActiveStatus, rateLimit(10, 60_000), handlePayoutRequest);

router.post('/payments/deposit', requireAuth, requireFinancialActiveStatus, rateLimit(10, 60_000), async (req: Request, res: Response) => {
  try {
    if (!areSimulatedDepositsAllowed()) {
      return res.status(501).json({ error: 'Deposits require a connected payment gateway in production.' });
    }

    const authUserId = (req as any).authenticatedUserId;
    if (!authUserId) {
      return res.status(401).json({ error: 'Unauthorized: Authentication required' });
    }

    const pool = postgresStore.getPool();
    const callerRes = await pool.query('SELECT * FROM users WHERE id = $1', [authUserId]);
    const caller = callerRes.rows[0];
    if (!caller) {
      return res.status(401).json({ error: 'Authenticated user not found' });
    }

    const requestedUserId = req.body?.userId;
    const isAdmin = caller.role === 'admin' || caller.role === 'super_admin';
    if (requestedUserId && requestedUserId !== authUserId) {
      if (!isAdmin) {
        return res.status(403).json({ error: 'Forbidden: You cannot deposit funds into another user wallet.' });
      }
    }
    const targetUserId = (isAdmin && requestedUserId) ? requestedUserId : authUserId;
    const amount = Number(req.body?.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: 'Please enter a valid deposit amount greater than $0.00' });
    }
    if (amount > 5000) {
      return res.status(400).json({ error: 'Simulated deposits are limited to $5,000.' });
    }

    await ensureWallet(targetUserId);
    const key = String(req.body?.idempotencyKey || req.body?.providerReference || randomUUID());
    await financialTransactionService.creditDeposit({
      userId: targetUserId,
      amount,
      actor: `${caller.name} (Simulated)`,
      idempotencyKey: `SIM-${targetUserId}-${key}`
    });
    await syncUserBalances();
    const newBalance = await financialRepository.getWalletBalance(targetUserId);
    const transaction = { id: `SIM-TXN-${key}` };

    await registerAuditLog({
      id: 'log_' + Date.now() + '_' + randomUUID().slice(0, 8),
      actor: caller.name,
      role: caller.role,
      action: 'FUNDS_DEPOSITED',
      target: `User ${caller.name}`,
      details: `Deposited $${amount.toFixed(2)} (simulated). New Balance: $${newBalance.toFixed(2)}`,
      timestamp: new Date().toLocaleString()
    });

    res.json({ success: true, newBalance, transaction });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/payments/gateway/checkout', requireAuth, requireFinancialActiveStatus, rateLimit(20, 60_000), async (req: Request, res: Response) => {
  try {
    const { amount, currency = 'USD', gateway, orderId, purpose = 'deposit', description, metadata } = req.body || {};
    const authUserId = (req as any).authenticatedUserId;
    const pool = postgresStore.getPool();
    await ensurePaymentCheckoutSchema(pool);

    const callerRes = await pool.query('SELECT id, name FROM users WHERE id = $1', [authUserId]);
    const caller = callerRes.rows[0];
    if (!caller) return res.status(401).json({ error: 'Unauthorized' });

    if (String(currency).toUpperCase().trim() !== 'USD') {
      return res.status(400).json({ error: 'Only USD currency is supported.' });
    }

    const explicitGateway = gateway !== undefined && gateway !== null && String(gateway).trim() !== ''
      ? String(gateway).trim().toLowerCase()
      : '';
    if (explicitGateway && !['stripe', 'paypal', 'razorpay'].includes(explicitGateway)) {
      return res.status(400).json({ error: `Unsupported payment gateway "${gateway}".` });
    }
    const normalizedGateway = paymentGatewayManager.resolveActiveGatewayName(explicitGateway || undefined);

    const requestedPurpose = String(purpose || 'deposit').trim().toLowerCase();
    if (!['deposit', 'order_payment', 'order', 'order_escrow', 'escrow_funding'].includes(requestedPurpose)) {
      return res.status(400).json({ error: `Invalid checkout purpose "${purpose}".` });
    }

    const normalizedOrderId = orderId !== undefined && orderId !== null && String(orderId).trim() !== ''
      ? String(orderId).trim()
      : null;

    if ((requestedPurpose === 'order_payment' || requestedPurpose === 'order' || requestedPurpose === 'order_escrow') && !normalizedOrderId && !metadata?.returnAction) {
      return res.status(400).json({ error: 'orderId is required when checkout purpose is order payment.' });
    }

    let authoritativeAmount: number;
    let resolvedPurpose = requestedPurpose;
    let resolvedDescription = typeof description === 'string' && description.trim() ? description.trim().slice(0, 120) : undefined;

    if (normalizedOrderId) {
      const ordRes = await pool.query('SELECT * FROM orders WHERE id = $1', [normalizedOrderId]);
      if (ordRes.rows.length === 0) {
        return res.status(404).json({ error: 'Order not found.' });
      }
      const orderRow = ordRes.rows[0];
      if (orderRow.buyer_id !== authUserId) {
        return res.status(403).json({ error: 'Forbidden: You can only create a payment checkout session for your own order.' });
      }

      if (['order_payment', 'order', 'order_escrow'].includes(requestedPurpose) && !metadata?.returnAction) {
        resolvedPurpose = 'order_payment';
        if (!['payment_pending', 'pending'].includes(orderRow.status)) {
          return res.status(400).json({ error: `Order is in status "${orderRow.status}" and is not awaiting payment.` });
        }
        const existingEscRes = await pool.query('SELECT status FROM escrows WHERE order_id = $1', [normalizedOrderId]);
        if (existingEscRes.rows.length > 0) {
          return res.status(400).json({ error: 'Order escrow is already funded.' });
        }

        const parsedBreakdown = typeof orderRow.fee_breakdown === 'string'
          ? JSON.parse(orderRow.fee_breakdown)
          : orderRow.fee_breakdown;
        const liveQuote = await quoteOrderWithLiveSettings(Number(orderRow.amount));
        authoritativeAmount = Number(
          (parsedBreakdown?.clientTotal ?? liveQuote.clientTotal).toFixed(2)
        );
        if (!resolvedDescription && orderRow.title) {
          resolvedDescription = `${SITE_CONFIG.brandName} Order: ${String(orderRow.title).slice(0, 90)}`;
        }

        if (amount !== undefined && amount !== null && amount !== '') {
          const callerAmount = Number(amount);
          if (!Number.isFinite(callerAmount) || toCents(callerAmount) !== toCents(authoritativeAmount)) {
            return res.status(400).json({
              error: `Checkout amount ($${Number.isFinite(callerAmount) ? callerAmount.toFixed(2) : 'invalid'}) does not match the authoritative order total ($${authoritativeAmount.toFixed(2)}).`
            });
          }
        }
      } else {
        const callerAmount = Number(amount);
        if (!Number.isFinite(callerAmount) || callerAmount < 1.00 || callerAmount > 100_000 || Math.abs(Math.round(callerAmount * 100) - callerAmount * 100) > 1e-6) {
          return res.status(400).json({ error: 'Valid amount between $1.00 and $100,000.00 USD (up to 2 decimal places) is required.' });
        }
        authoritativeAmount = Number((toCents(callerAmount) / 100).toFixed(2));
      }
    } else {
      const callerAmount = Number(amount);
      if (!Number.isFinite(callerAmount) || callerAmount < 1.00 || callerAmount > 100_000 || Math.abs(Math.round(callerAmount * 100) - callerAmount * 100) > 1e-6) {
        return res.status(400).json({ error: 'Valid amount between $1.00 and $100,000.00 USD (up to 2 decimal places) is required.' });
      }
      authoritativeAmount = Number((toCents(callerAmount) / 100).toFixed(2));
    }

    await ensureWallet(authUserId);
    const checkoutId = 'chk_' + randomUUID();
    const safeMetadata = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {};

    // PayPal environment is EXCLUSIVELY selected by trusted server configuration.
    // Client-supplied req.body.environment is IGNORED for security to prevent environment tampering.
    const activeEnv: 'production' | 'sandbox' = normalizedGateway === 'paypal'
      ? paymentGatewayManager.getActivePayPalEnvironment()
      : (IS_PRODUCTION ? 'production' : 'sandbox');

    if (normalizedGateway === 'paypal' && activeEnv === 'production') {
      const prodGw = paymentGatewayManager.getGateway('paypal', 'production');
      if (!prodGw || !prodGw.enabled || !prodGw.clientId || !prodGw.clientSecret) {
        return res.status(400).json({
          error: 'PayPal Live mode is active, but PayPal Live credentials (Client ID and Client Secret) are not configured in Super Admin Panel.'
        });
      }
    }

    // STEP 1: Validate and Reserve (SHORT DB Transaction)
    const reservation = await postgresStore.executeInTransaction(async (client) => {
      // Acquire short row-level lock to serialize concurrent checkout creation
      if (normalizedOrderId) {
        await client.query('SELECT id FROM orders WHERE id = $1::text FOR UPDATE', [normalizedOrderId]);
      } else {
        await client.query('SELECT user_id FROM wallets WHERE user_id = $1::text FOR UPDATE', [authUserId]).catch(() => {});
      }

      // Check for an existing valid pending session or reservation
      let activeSessRes;
      if (normalizedOrderId && ['order_payment', 'order', 'order_escrow'].includes(resolvedPurpose)) {
        activeSessRes = await client.query(
          `SELECT * FROM payment_checkout_sessions
            WHERE order_id = $1::text
              AND user_id = $2::text
              AND gateway = $3::text
              AND environment = $4::text
              AND status IN ('pending', 'approved', 'reserving')
              AND created_at > NOW() - INTERVAL '15 minutes'
            ORDER BY created_at DESC LIMIT 1
            FOR UPDATE`,
          [normalizedOrderId, authUserId, normalizedGateway, activeEnv]
        );
      } else {
        activeSessRes = await client.query(
          `SELECT * FROM payment_checkout_sessions
            WHERE user_id = $1::text
              AND order_id IS NULL
              AND gateway = $2::text
              AND environment = $3::text
              AND expected_amount = $4::numeric
              AND purpose = $5::text
              AND status IN ('pending', 'approved', 'reserving')
              AND created_at > NOW() - INTERVAL '5 minutes'
            ORDER BY created_at DESC LIMIT 1
            FOR UPDATE`,
          [authUserId, normalizedGateway, activeEnv, authoritativeAmount, resolvedPurpose]
        );
      }

      if (activeSessRes && activeSessRes.rows.length > 0) {
        const activeSess = activeSessRes.rows[0];
        const activeMeta = typeof activeSess.metadata === 'string'
          ? (() => { try { return JSON.parse(activeSess.metadata); } catch { return {}; } })()
          : (activeSess.metadata || {});

        const sameReturnAction = JSON.stringify(activeMeta?.returnAction || null) === JSON.stringify((safeMetadata as any)?.returnAction || null);

        if (activeSess.status === 'reserving' && new Date(activeSess.created_at).getTime() > Date.now() - 30_000) {
          return {
            inProgressConflict: true
          };
        }

        const activePayPalOrderId = activeSess.paypal_order_id || activeSess.provider_tx_id;
        if (sameReturnAction && activePayPalOrderId && activeSess.status !== 'reserving' && !String(activePayPalOrderId).startsWith('sess_sim_')) {
          const activeCheckoutUrl = activeSess.gateway === 'paypal'
            ? `https://www.${activeSess.environment === 'sandbox' ? 'sandbox.' : ''}paypal.com/checkoutnow?token=${activePayPalOrderId}`
            : `/checkout/pay?session_id=${encodeURIComponent(activeSess.id)}`;

          return {
            reused: true,
            sessionResponse: {
              success: true,
              replayed: true,
              reusedPendingSession: true,
              checkoutId: String(activeSess.id),
              sessionId: String(activeSess.id),
              gateway: activeSess.gateway,
              paypalOrderId: activePayPalOrderId,
              providerOrderId: activeSess.provider_tx_id,
              orderId: activeSess.order_id,
              purpose: activeSess.purpose,
              amount: Number(activeSess.expected_amount),
              currency: activeSess.currency || 'USD',
              environment: activeSess.environment,
              redirectUrl: activeCheckoutUrl,
              checkoutUrl: activeCheckoutUrl,
              metadata: activeMeta
            }
          };
        }
      }

      // Create an atomic reservation record
      await client.query(
        `INSERT INTO payment_checkout_sessions
           (id, user_id, order_id, gateway, expected_amount, currency, purpose, status, environment, metadata, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, 'USD', $6, 'reserving', $7, $8, NOW(), NOW())
         ON CONFLICT (id) DO UPDATE SET updated_at = NOW()`,
        [
          checkoutId,
          authUserId,
          normalizedOrderId,
          normalizedGateway,
          authoritativeAmount,
          resolvedPurpose,
          activeEnv,
          JSON.stringify(safeMetadata)
        ]
      );

      return { reused: false, checkoutId, activeEnv };
    });

    if ((reservation as any).inProgressConflict) {
      return res.status(409).json({ error: 'A payment checkout session is already being initialized. Please wait a few seconds and try again.' });
    }

    if (reservation.reused && reservation.sessionResponse) {
      return res.json(reservation.sessionResponse);
    }

    const reservationCheckoutId = reservation.checkoutId || checkoutId;

    // STEP 2: Create external PayPal order OUTSIDE database transaction
    let providerSession;
    try {
      providerSession = await paymentGatewayManager.createCheckoutSession({
        gateway: normalizedGateway as any,
        amount: authoritativeAmount,
        currency: 'USD',
        userId: authUserId,
        orderId: normalizedOrderId || undefined,
        purpose: resolvedPurpose,
        description: resolvedDescription,
        checkoutId: reservationCheckoutId,
        env: reservation.activeEnv
      });
    } catch (providerErr: any) {
      await postgresStore.executeInTransaction(async (client) => {
        await client.query(
          "UPDATE payment_checkout_sessions SET status = 'failed', updated_at = NOW() WHERE id = $1 AND status = 'reserving'",
          [reservationCheckoutId]
        ).catch(() => {});
      });
      throw providerErr;
    }

    const paypalOrderId = normalizedGateway === 'paypal' ? providerSession.providerSessionId : null;

    // STEP 3: Attach provider order ID to reservation in a SHORT DB transaction
    await postgresStore.executeInTransaction(async (client) => {
      await client.query(
        `UPDATE payment_checkout_sessions
            SET status = 'pending',
                provider_tx_id = $1::text,
                paypal_order_id = $2::text,
                updated_at = NOW()
          WHERE id = $3::text`,
        [providerSession.providerSessionId, paypalOrderId, reservationCheckoutId]
      );
    });

    // STEP 4: Return response to client
    res.json({
      success: true,
      checkoutId: reservationCheckoutId,
      sessionId: reservationCheckoutId,
      gateway: normalizedGateway,
      paypalOrderId: paypalOrderId || undefined,
      providerOrderId: providerSession.providerSessionId,
      orderId: normalizedOrderId || undefined,
      purpose: resolvedPurpose,
      amount: authoritativeAmount,
      currency: 'USD',
      environment: reservation.activeEnv,
      redirectUrl: providerSession.checkoutUrl || `/checkout/success?session_id=${reservationCheckoutId}&amount=${authoritativeAmount}`
    });
  } catch (err: any) {
    res.status(500).json(formatApiError(err));
  }
});

export async function settleCompletedCheckoutSession(params: {
  sessionId: string;
  gateway: string;
  txId: string;
  paypalOrderId?: string;
  paypalCaptureId?: string;
  webhookEventId?: string;
  paidAmount?: number;
  paidCurrency: string;
  reference?: string;
  expectedUserId?: string;
  expectedOrderId?: string | null;
  expectedPurpose?: string;
  preVerifiedSessionId: string;
  preExpectedAmount: number;
  actor: string;
  source: 'gateway' | 'webhook';
}): Promise<{
  received: boolean;
  replayed?: boolean;
  checkoutId: string;
  orderId?: string | null;
  purpose: string;
  amount: number;
  currency: string;
  paypalOrderId?: string | null;
  captureId: string;
  metadata?: any;
}> {
  const {
    sessionId,
    gateway,
    txId,
    paypalOrderId,
    paypalCaptureId,
    webhookEventId,
    paidAmount,
    paidCurrency,
    reference,
    expectedUserId,
    expectedOrderId,
    expectedPurpose,
    preVerifiedSessionId,
    preExpectedAmount,
    actor,
    source
  } = params;

  const effectiveTxId = (paypalCaptureId || txId || '').trim();
  if (!effectiveTxId) {
    throw { status: 400, message: 'Missing transaction or capture ID for settlement.' };
  }

  if (String(paidCurrency || '').toUpperCase().trim() !== 'USD') {
    throw { status: 400, message: 'Invalid or missing currency: payment currency must be explicitly USD.' };
  }

  return await postgresStore.executeInTransaction(async (client) => {
    // 1. Lock the exact verified checkout session row first to serialize concurrent return-capture and webhook delivery
    const lockedSessRes = await client.query(
      'SELECT * FROM payment_checkout_sessions WHERE id = $1 FOR UPDATE',
      [sessionId]
    );
    const sess: any = lockedSessRes.rows[0] || null;
    if (!sess) {
      throw { status: 400, message: 'Cannot process payment: no matching stored checkout session found.' };
    }

    const parsedMeta = typeof sess.metadata === 'string'
      ? (() => { try { return JSON.parse(sess.metadata); } catch { return {}; } })()
      : (sess.metadata || {});

    // 2. If already completed, return idempotently without crediting a second time
    if (sess.status === 'completed') {
      return {
        received: true,
        replayed: true,
        checkoutId: String(sess.id),
        orderId: sess.order_id ? String(sess.order_id) : null,
        purpose: String(sess.purpose || 'deposit'),
        amount: Number(sess.expected_amount),
        currency: String(sess.currency || 'USD'),
        paypalOrderId: sess.paypal_order_id || paypalOrderId || null,
        captureId: String(sess.paypal_capture_id || sess.provider_tx_id || effectiveTxId),
        metadata: parsedMeta
      };
    }

    // 3. Check if another completed session already consumed this provider transaction / capture ID
    const existingTx = await client.query(
      "SELECT id FROM payment_checkout_sessions WHERE (provider_tx_id = $1::text OR paypal_capture_id = $1::text) AND status = 'completed' AND id <> $2::text",
      [effectiveTxId, sess.id]
    );
    if (existingTx.rows.length > 0) {
      return {
        received: true,
        replayed: true,
        checkoutId: String(sess.id),
        orderId: sess.order_id ? String(sess.order_id) : null,
        purpose: String(sess.purpose || 'deposit'),
        amount: Number(sess.expected_amount),
        currency: String(sess.currency || 'USD'),
        paypalOrderId: sess.paypal_order_id || paypalOrderId || null,
        captureId: effectiveTxId,
        metadata: parsedMeta
      };
    }

    const authoritativeUserId = String(sess.user_id);
    const authoritativeAmount = Number(sess.expected_amount);
    const authoritativeOrderId = sess.order_id ? String(sess.order_id) : null;
    const authoritativePurpose = String(sess.purpose || (authoritativeOrderId ? 'order_payment' : 'deposit'));

    if (!authoritativeUserId || !Number.isFinite(authoritativeAmount) || authoritativeAmount <= 0) {
      throw { status: 400, message: 'Stored checkout session has invalid user or expected amount.' };
    }
    if (!sess.currency || String(sess.currency).toUpperCase() !== 'USD') {
      throw { status: 400, message: 'Checkout session currency mismatch: must be USD.' };
    }
    if (sess.gateway && String(sess.gateway).toLowerCase() !== gateway) {
      throw { status: 400, message: 'Checkout session gateway mismatch.' };
    }

    if (expectedUserId && String(expectedUserId) !== authoritativeUserId) {
      throw { status: 400, message: 'Checkout session user mismatch.' };
    }
    if (paidAmount !== undefined && Number.isFinite(paidAmount)) {
      if (toCents(paidAmount) !== toCents(authoritativeAmount)) {
        throw { status: 400, message: 'Checkout session amount mismatch.' };
      }
    }
    if (expectedOrderId && authoritativeOrderId && expectedOrderId !== authoritativeOrderId) {
      throw { status: 400, message: 'Checkout session order mismatch.' };
    }
    if (expectedOrderId && !authoritativeOrderId) {
      throw { status: 400, message: 'Checkout session is not linked to an order.' };
    }
    if (expectedPurpose && ['order_payment', 'order', 'order_escrow'].includes(String(expectedPurpose)) && !authoritativeOrderId) {
      throw { status: 400, message: 'Checkout session is not an order payment session.' };
    }

    if (sess.status !== 'pending' && sess.status !== 'approved') {
      throw { status: 400, message: `Checkout session already in status ${sess.status}` };
    }

    if (preVerifiedSessionId !== String(sess.id) || toCents(authoritativeAmount) !== toCents(preExpectedAmount)) {
      throw { status: 409, message: 'Checkout session state changed concurrently during verification.' };
    }

    // 4. Durable idempotency lock per checkout session + provider tx
    const sessionSettleKey = `WH-PROVIDER-TX-${gateway}-${effectiveTxId}`;
    const payloadFingerprint = {
      gateway,
      txId: effectiveTxId,
      userId: authoritativeUserId,
      amount: authoritativeAmount,
      checkoutId: sess.id,
      orderId: authoritativeOrderId
    };
    const idempCheck = await checkOrRecordIdempotency(
      client,
      sessionSettleKey,
      'paymentWebhook',
      payloadFingerprint
    );
    if (idempCheck.replayed) {
      return {
        received: true,
        replayed: true,
        checkoutId: String(sess.id),
        orderId: authoritativeOrderId,
        purpose: authoritativePurpose,
        amount: authoritativeAmount,
        currency: 'USD',
        paypalOrderId: sess.paypal_order_id || paypalOrderId || null,
        captureId: effectiveTxId,
        metadata: parsedMeta
      };
    }

    // 5. If linked to an Order for direct order_payment, validate Order ownership, status, and authoritative total BEFORE crediting
    let lockedOrder: any = null;
    const isOrderPayment = Boolean(authoritativeOrderId) && ['order_payment', 'order', 'order_escrow'].includes(authoritativePurpose);
    if (['order_payment', 'order', 'order_escrow'].includes(authoritativePurpose) && !authoritativeOrderId) {
      throw { status: 400, message: 'Order payment checkout session is missing order_id.' };
    }
    if (isOrderPayment && authoritativeOrderId) {
      const ordRes = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [authoritativeOrderId]);
      if (ordRes.rows.length === 0) {
        throw { status: 404, message: `Order ${authoritativeOrderId} not found.` };
      }
      lockedOrder = ordRes.rows[0];
      if (lockedOrder.buyer_id !== authoritativeUserId) {
        throw { status: 403, message: 'Order buyer mismatch with checkout session owner.' };
      }
      if (!['payment_pending', 'pending'].includes(lockedOrder.status)) {
        throw { status: 400, message: `Order ${lockedOrder.id} is in status "${lockedOrder.status}" and cannot be settled.` };
      }
      const parsedBreakdown = typeof lockedOrder.fee_breakdown === 'string'
        ? JSON.parse(lockedOrder.fee_breakdown)
        : lockedOrder.fee_breakdown;
      const liveQuote = await quoteOrderWithLiveSettings(Number(lockedOrder.amount));
      const expectedOrderTotal = Number(
        (parsedBreakdown?.clientTotal ?? liveQuote.clientTotal).toFixed(2)
      );
      const walletApplied = Math.max(0, Number(parsedMeta?.walletApplied || 0));
      const expectedCombinedCents = toCents(authoritativeAmount) + toCents(walletApplied);
      if (expectedCombinedCents !== toCents(expectedOrderTotal)) {
        throw {
          status: 400,
          message: `Checkout session amount ($${authoritativeAmount.toFixed(2)}${walletApplied > 0 ? ` + $${walletApplied.toFixed(2)} wallet` : ''}) does not match authoritative order total ($${expectedOrderTotal.toFixed(2)}).`
        };
      }
    }

    await financialTransactionService.ensureWallet({ userId: authoritativeUserId, role: 'buyer' }, client);

    // Use session-scoped idempotency key so return-page capture and webhook can never double-credit the same checkout session
    const depositIdempotencyKey = `CHK-CREDIT-${sess.id}`;
    await financialTransactionService.creditDeposit({
      userId: authoritativeUserId,
      amount: authoritativeAmount,
      reference: reference || effectiveTxId || 'WH-DEPOSIT',
      idempotencyKey: depositIdempotencyKey,
      actor,
      source
    }, client);

    // 6. Atomically fund Order escrow if this session is an order payment
    let updatedMetadata = parsedMeta;
    if (isOrderPayment && lockedOrder) {
      const parsedBreakdown = typeof lockedOrder.fee_breakdown === 'string'
        ? JSON.parse(lockedOrder.fee_breakdown)
        : lockedOrder.fee_breakdown;
      const liveQuote = await quoteOrderWithLiveSettings(Number(lockedOrder.amount));
      const expectedOrderTotal = Number((parsedBreakdown?.clientTotal ?? liveQuote.clientTotal).toFixed(2));

      const walletRowRes = await client.query(
        'SELECT available_balance FROM wallets WHERE user_id = $1 FOR UPDATE',
        [authoritativeUserId]
      );
      const currentAvail = Number(walletRowRes.rows[0]?.available_balance ?? 0);

      if (toCents(currentAvail) >= toCents(expectedOrderTotal)) {
        const fundIdempKey = `CHK-FUND-${sess.id}`;
        await financialTransactionService.fundEscrow({
          orderId: lockedOrder.id,
          orderTitle: lockedOrder.title,
          amount: Number(lockedOrder.amount),
          buyerId: lockedOrder.buyer_id,
          sellerId: lockedOrder.seller_id,
          actor: `user:${authoritativeUserId}`,
          idempotencyKey: fundIdempKey
        }, client);
        await client.query("UPDATE orders SET status = 'funded_in_escrow', updated_at = NOW() WHERE id = $1", [lockedOrder.id]);
        updatedMetadata = { ...parsedMeta, orderFunded: true };
      } else {
        // Gateway deposit was safely credited to buyer's wallet, but split wallet balance was spent concurrently.
        // Never discard the buyer's gateway payment; record metadata so the UI prompts to finish the remaining balance.
        updatedMetadata = {
          ...parsedMeta,
          orderFunded: false,
          partialFundingRequired: true,
          shortfallAmount: Number(((toCents(expectedOrderTotal) - toCents(currentAvail)) / 100).toFixed(2))
        };
      }
    }

    try {
      await client.query(
        `UPDATE payment_checkout_sessions
            SET status = $1::text,
                provider_tx_id = $2::text,
                paypal_order_id = COALESCE($3::text, paypal_order_id),
                paypal_capture_id = COALESCE($4::text, paypal_capture_id),
                last_webhook_event_id = COALESCE($5::text, last_webhook_event_id),
                metadata = $6::jsonb,
                completed_at = NOW(),
                updated_at = NOW()
          WHERE id = $7::text`,
        ['completed', effectiveTxId, paypalOrderId || null, paypalCaptureId || null, webhookEventId || null, JSON.stringify(updatedMetadata || {}), sess.id]
      );
    } catch {
      await client.query(
        'UPDATE payment_checkout_sessions SET status = $1::text, provider_tx_id = $2::text, completed_at = NOW() WHERE id = $3::text',
        ['completed', effectiveTxId, sess.id]
      );
    }

    const resObj = {
      received: true,
      checkoutId: String(sess.id),
      orderId: authoritativeOrderId,
      purpose: authoritativePurpose,
      amount: authoritativeAmount,
      currency: 'USD',
      paypalOrderId: paypalOrderId || sess.paypal_order_id || null,
      captureId: effectiveTxId,
      metadata: updatedMetadata
    };
    await recordIdempotencyResult(client, sessionSettleKey, 'paymentWebhook', resObj, payloadFingerprint);

    return resObj;
  });
}

const handlePayPalCaptureRoute = async (req: Request, res: Response) => {
  try {
    const authUserId = (req as any).authenticatedUserId;
    if (!authUserId) return res.status(401).json({ error: 'Unauthorized' });

    const pool = postgresStore.getPool();
    await ensurePaymentCheckoutSchema(pool);

    const rawSessionId = String(req.params.sessionId || req.body?.sessionId || req.body?.checkoutId || '').trim();
    const rawPayPalOrderId = String(req.body?.paypalOrderId || req.body?.token || req.body?.orderID || '').trim();

    if (!rawSessionId && !rawPayPalOrderId) {
      return res.status(400).json({ error: 'sessionId or paypalOrderId is required to capture payment.' });
    }

    let sessRes = rawSessionId
      ? await pool.query('SELECT * FROM payment_checkout_sessions WHERE id = $1 LIMIT 1', [rawSessionId])
      : { rows: [] as any[] };

    if (sessRes.rows.length === 0 && rawPayPalOrderId) {
      sessRes = await pool.query(
        'SELECT * FROM payment_checkout_sessions WHERE paypal_order_id = $1::text OR provider_tx_id = $1::text LIMIT 1',
        [rawPayPalOrderId]
      );
    }

    if (sessRes.rows.length === 0) {
      return res.status(404).json({ error: 'Checkout session not found.' });
    }

    const sess = sessRes.rows[0];
    if (String(sess.user_id) !== String(authUserId)) {
      return res.status(403).json({ error: 'Forbidden: This checkout session belongs to another user.' });
    }

    const parsedMeta = typeof sess.metadata === 'string'
      ? (() => { try { return JSON.parse(sess.metadata); } catch { return {}; } })()
      : (sess.metadata || {});

    if (sess.status === 'completed') {
      const bal = await financialRepository.getWalletBalance(authUserId);
      return res.json({
        success: true,
        ok: true,
        status: 'completed',
        replayed: true,
        alreadyProcessed: true,
        checkoutId: sess.id,
        sessionId: sess.id,
        gateway: sess.gateway,
        orderId: sess.order_id || parsedMeta?.resultingOrderId || null,
        purpose: sess.purpose,
        amount: Number(sess.expected_amount),
        currency: sess.currency || 'USD',
        paypalOrderId: sess.paypal_order_id || rawPayPalOrderId || null,
        captureId: sess.paypal_capture_id || sess.provider_tx_id || null,
        paypalCaptureId: sess.paypal_capture_id || sess.provider_tx_id || null,
        metadata: parsedMeta,
        availableBalance: bal,
        walletBalance: bal
      });
    }

    if (sess.status !== 'pending' && sess.status !== 'approved') {
      return res.status(400).json({ error: `Checkout session cannot be captured because its status is "${sess.status}".` });
    }

    const gateway = String(sess.gateway || 'paypal').toLowerCase();
    const expectedAmount = Number(sess.expected_amount);

    if (gateway === 'paypal') {
      const storedPayPalOrderId = String(sess.paypal_order_id || sess.provider_tx_id || '').trim();
      if (storedPayPalOrderId && rawPayPalOrderId && rawPayPalOrderId !== storedPayPalOrderId) {
        return res.status(400).json({ error: 'PayPal order token does not match the stored checkout session.' });
      }
      const targetPayPalOrderId = storedPayPalOrderId || rawPayPalOrderId;
      if (!targetPayPalOrderId || targetPayPalOrderId.startsWith('chk_')) {
        return res.status(400).json({ error: 'Missing PayPal Order ID (token) for capture.' });
      }

      const captureResult = await paymentGatewayManager.capturePayPalOrder({
        paypalOrderId: targetPayPalOrderId,
        expectedSessionId: String(sess.id),
        expectedAmount,
        expectedCurrency: 'USD',
        env: sess.environment || 'sandbox'
      });

      if (!captureResult.verified) {
        return res.status(400).json({
          error: captureResult.error || 'PayPal order capture verification failed.',
          status: captureResult.status
        });
      }

      const settled = await settleCompletedCheckoutSession({
        sessionId: String(sess.id),
        gateway: 'paypal',
        txId: captureResult.captureId,
        paypalOrderId: captureResult.paypalOrderId,
        paypalCaptureId: captureResult.captureId,
        paidAmount: Number(captureResult.amountValue),
        paidCurrency: captureResult.currencyCode,
        reference: captureResult.captureId,
        expectedUserId: String(authUserId),
        preVerifiedSessionId: String(sess.id),
        preExpectedAmount: expectedAmount,
        actor: `PayPal Capture (${authUserId})`,
        source: 'gateway'
      });

      await syncUserBalances([authUserId]);
      const bal = await financialRepository.getWalletBalance(authUserId);

      return res.json({
        success: true,
        ok: true,
        status: 'completed',
        replayed: Boolean(settled.replayed),
        alreadyProcessed: Boolean(settled.replayed),
        checkoutId: settled.checkoutId,
        sessionId: settled.checkoutId,
        gateway: 'paypal',
        orderId: settled.orderId || settled.metadata?.resultingOrderId || null,
        purpose: settled.purpose,
        amount: settled.amount,
        currency: settled.currency,
        paypalOrderId: settled.paypalOrderId,
        captureId: settled.captureId,
        paypalCaptureId: settled.captureId,
        metadata: settled.metadata,
        availableBalance: bal,
        walletBalance: bal
      });
    } else {
      const storedProviderId = String(sess.provider_tx_id || '').trim();
      const razorpayPayId = String(req.body?.razorpayPaymentId || req.body?.razorpay_payment_id || '').trim();
      const targetTxId = razorpayPayId || String(req.body?.transactionId || storedProviderId || rawPayPalOrderId || '').trim();
      const verifyRes = await paymentGatewayManager.verifyPaymentEvent({
        gateway,
        sessionId: storedProviderId || String(sess.id),
        expectedCheckoutId: String(sess.id),
        transactionId: targetTxId,
        expectedAmount,
        expectedCurrency: 'USD',
        env: sess.environment || undefined
      });
      if (!verifyRes.verified) {
        return res.status(400).json({ error: verifyRes.error || 'Payment verification failed.' });
      }
      const verifiedTxId = verifyRes.captureId || targetTxId || `SIM-${sess.id}`;
      const settled = await settleCompletedCheckoutSession({
        sessionId: String(sess.id),
        gateway,
        txId: verifiedTxId,
        paidAmount: expectedAmount,
        paidCurrency: 'USD',
        reference: verifiedTxId,
        expectedUserId: String(authUserId),
        preVerifiedSessionId: String(sess.id),
        preExpectedAmount: expectedAmount,
        actor: `Gateway Capture (${authUserId})`,
        source: 'gateway'
      });
      await syncUserBalances([authUserId]);
      const bal = await financialRepository.getWalletBalance(authUserId);
      return res.json({
        success: true,
        ok: true,
        status: 'completed',
        replayed: Boolean(settled.replayed),
        alreadyProcessed: Boolean(settled.replayed),
        checkoutId: settled.checkoutId,
        sessionId: settled.checkoutId,
        gateway,
        orderId: settled.orderId || settled.metadata?.resultingOrderId || null,
        purpose: settled.purpose,
        amount: settled.amount,
        currency: settled.currency,
        captureId: settled.captureId,
        paypalCaptureId: settled.captureId,
        metadata: settled.metadata,
        availableBalance: bal,
        walletBalance: bal
      });
    }
  } catch (err: any) {
    const statusCode = typeof err?.status === 'number' ? err.status : 400;
    return res.status(statusCode).json({ error: err?.message || 'Failed to capture payment.' });
  }
};

router.post('/payments/paypal/capture', requireAuth, requireFinancialActiveStatus, rateLimit(20, 60_000), handlePayPalCaptureRoute);
router.post('/payments/checkout/:sessionId/capture', requireAuth, requireFinancialActiveStatus, rateLimit(20, 60_000), handlePayPalCaptureRoute);
router.post('/payments/checkout/:sessionId/verify', requireAuth, requireFinancialActiveStatus, rateLimit(20, 60_000), handlePayPalCaptureRoute);

router.get('/payments/checkout/:sessionId', requireAuth, rateLimit(60, 60_000), async (req: Request, res: Response) => {
  try {
    const authUserId = (req as any).authenticatedUserId;
    const sessionId = String(req.params.sessionId || '').trim();
    if (!sessionId) return res.status(400).json({ error: 'Session ID is required.' });

    const pool = postgresStore.getPool();
    await ensurePaymentCheckoutSchema(pool);

    const sessRes = await pool.query('SELECT * FROM payment_checkout_sessions WHERE id = $1 LIMIT 1', [sessionId]);
    if (sessRes.rows.length === 0) {
      return res.status(404).json({ error: 'Checkout session not found.' });
    }
    const sess = sessRes.rows[0];
    if (String(sess.user_id) !== String(authUserId)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const parsedMeta = typeof sess.metadata === 'string'
      ? (() => { try { return JSON.parse(sess.metadata); } catch { return {}; } })()
      : (sess.metadata || {});
    const bal = await financialRepository.getWalletBalance(authUserId);

    res.json({
      checkoutId: sess.id,
      sessionId: sess.id,
      status: sess.status,
      gateway: sess.gateway,
      amount: Number(sess.expected_amount),
      currency: sess.currency || 'USD',
      purpose: sess.purpose || 'deposit',
      orderId: sess.order_id || parsedMeta?.resultingOrderId || null,
      paypalOrderId: sess.paypal_order_id || null,
      captureId: sess.paypal_capture_id || (sess.status === 'completed' ? sess.provider_tx_id : null),
      paypalCaptureId: sess.paypal_capture_id || (sess.status === 'completed' ? sess.provider_tx_id : null),
      metadata: parsedMeta,
      availableBalance: bal,
      walletBalance: bal,
      createdAt: sess.created_at,
      completedAt: sess.completed_at || null
    });
  } catch (err: any) {
    res.status(500).json(formatApiError(err));
  }
});

router.post('/payments/checkout/:sessionId/cancel', requireAuth, rateLimit(20, 60_000), async (req: Request, res: Response) => {
  try {
    const authUserId = (req as any).authenticatedUserId;
    const sessionId = String(req.params.sessionId || '').trim();
    if (!sessionId) return res.status(400).json({ error: 'Session ID is required.' });

    const pool = postgresStore.getPool();
    await ensurePaymentCheckoutSchema(pool);

    const sessRes = await pool.query('SELECT * FROM payment_checkout_sessions WHERE id = $1 LIMIT 1', [sessionId]);
    if (sessRes.rows.length === 0) {
      return res.status(404).json({ error: 'Checkout session not found.' });
    }
    const sess = sessRes.rows[0];
    if (String(sess.user_id) !== String(authUserId)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    if (sess.status === 'pending' || sess.status === 'approved') {
      await pool.query(
        "UPDATE payment_checkout_sessions SET status = 'cancelled', updated_at = NOW() WHERE id = $1 AND status IN ('pending', 'approved')",
        [sessionId]
      ).catch(async () => {
        await pool.query(
          "UPDATE payment_checkout_sessions SET status = 'cancelled' WHERE id = $1 AND status IN ('pending', 'approved')",
          [sessionId]
        );
      });
      sess.status = 'cancelled';
    }

    res.json({
      success: true,
      checkoutId: sess.id,
      sessionId: sess.id,
      status: sess.status,
      amount: Number(sess.expected_amount),
      currency: sess.currency || 'USD',
      purpose: sess.purpose || 'deposit',
      orderId: sess.order_id || null
    });
  } catch (err: any) {
    res.status(500).json(formatApiError(err));
  }
});

router.post('/payments/checkout/:sessionId/complete-action', requireAuth, rateLimit(20, 60_000), async (req: Request, res: Response) => {
  try {
    const authUserId = (req as any).authenticatedUserId;
    const sessionId = String(req.params.sessionId || '').trim();
    const { resultingOrderId, actionResult } = req.body || {};
    if (!sessionId) return res.status(400).json({ error: 'Session ID is required.' });

    const pool = postgresStore.getPool();
    await ensurePaymentCheckoutSchema(pool);

    const sessRes = await pool.query('SELECT * FROM payment_checkout_sessions WHERE id = $1 LIMIT 1', [sessionId]);
    if (sessRes.rows.length === 0) return res.status(404).json({ error: 'Checkout session not found.' });
    const sess = sessRes.rows[0];
    if (String(sess.user_id) !== String(authUserId)) return res.status(403).json({ error: 'Forbidden' });
    if (sess.status !== 'completed') {
      return res.status(400).json({ error: 'Cannot complete follow-up action for an uncompleted checkout session.' });
    }

    const parsedMeta = typeof sess.metadata === 'string'
      ? (() => { try { return JSON.parse(sess.metadata); } catch { return {}; } })()
      : (sess.metadata || {});
    if (parsedMeta.actionCompleted) {
      return res.json({ success: true, metadata: parsedMeta });
    }

    let verifiedOrderId: string | null = sess.order_id ? String(sess.order_id) : null;
    const candidateOrderId = resultingOrderId || actionResult?.workstreamOrderId || actionResult?.orderId || null;
    if (!verifiedOrderId && candidateOrderId) {
      const ordCheck = await pool.query(
        'SELECT id FROM orders WHERE id = $1 AND (buyer_id = $2 OR seller_id = $2) LIMIT 1',
        [String(candidateOrderId), String(authUserId)]
      );
      if (ordCheck.rows.length > 0) {
        verifiedOrderId = String(ordCheck.rows[0].id);
      }
    }

    const safeActionResult: Record<string, any> = {};
    if (typeof actionResult?.summary === 'string') {
      safeActionResult.summary = actionResult.summary.slice(0, 300);
    }
    if (verifiedOrderId) {
      safeActionResult.orderId = verifiedOrderId;
      safeActionResult.workstreamOrderId = verifiedOrderId;
    }

    const updatedMeta = {
      ...parsedMeta,
      actionCompleted: true,
      actionResult: safeActionResult,
      ...(verifiedOrderId ? { resultingOrderId: verifiedOrderId } : {})
    };

    await pool.query(
      'UPDATE payment_checkout_sessions SET metadata = $1, order_id = COALESCE(order_id, $2), updated_at = NOW() WHERE id = $3',
      [JSON.stringify(updatedMeta), verifiedOrderId, sessionId]
    ).catch(() => {});

    res.json({ success: true, metadata: updatedMeta });
  } catch (err: any) {
    res.status(500).json(formatApiError(err));
  }
});

export const handlePaymentWebhook = async (req: Request, res: Response) => {
  const rawBody = req.body;
  if (!Buffer.isBuffer(rawBody) && typeof rawBody !== 'string') {
    return res.status(400).json({ error: 'Webhook endpoint requires raw unparsed body.' });
  }

  let detectedGateway = String(req.headers['x-gateway-provider'] || req.query.gateway || '').trim().toLowerCase();
  if (!detectedGateway) {
    if (req.headers['paypal-transmission-id'] || req.headers['paypal-auth-algo'] || req.headers['paypal-cert-url'] || req.headers['paypal-transmission-sig']) {
      detectedGateway = 'paypal';
    } else if (req.headers['stripe-signature']) {
      detectedGateway = 'stripe';
    } else if (req.headers['x-razorpay-signature']) {
      detectedGateway = 'razorpay';
    } else {
      detectedGateway = 'stripe';
    }
  }

  const bodyStr = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody);
  if (Buffer.byteLength(bodyStr, 'utf8') > 256 * 1024) {
    return res.status(413).json({ error: 'Webhook payload too large.' });
  }

  let payload: any;
  try {
    payload = JSON.parse(bodyStr);
  } catch {
    return res.status(400).json({ error: 'Malformed JSON payload' });
  }

  if (detectedGateway === 'stripe' && !req.headers['stripe-signature']) {
    if (payload?.event_type && (payload?.resource || String(payload?.id || '').startsWith('WH-'))) {
      detectedGateway = 'paypal';
    }
  }
  const gateway = detectedGateway;
  const pool = postgresStore.getPool();
  await ensurePaymentCheckoutSchema(pool);

  // Extract candidate identity parameters to resolve stored session environment for webhook verification
  const candidateId = String(
    payload?.resource?.custom_id ||
    payload?.resource?.invoice_id ||
    payload?.resource?.purchase_units?.[0]?.custom_id ||
    payload?.resource?.purchase_units?.[0]?.reference_id ||
    payload?.resource?.purchase_units?.[0]?.invoice_id ||
    payload?.resource?.supplementary_data?.related_ids?.order_id ||
    payload?.resource?.id ||
    payload?.data?.object?.id ||
    ''
  ).trim();

  let candidateEnv: 'production' | 'sandbox' | undefined;
  if (candidateId) {
    try {
      const candRes = await pool.query(
        `SELECT environment FROM payment_checkout_sessions
          WHERE (id = $1::text OR paypal_order_id = $1::text OR provider_tx_id = $1::text OR paypal_capture_id = $1::text)
          LIMIT 1`,
        [candidateId]
      );
      if (candRes.rows.length > 0 && candRes.rows[0].environment) {
        candidateEnv = candRes.rows[0].environment as 'production' | 'sandbox';
      }
    } catch {}
  }

  const isVerified = await paymentGatewayManager.verifyWebhookSignature({
    gateway,
    headers: req.headers,
    rawBody: Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(bodyStr, 'utf8'),
    env: candidateEnv
  });

  if (!isVerified) {
    return res.status(403).json({ error: 'Unauthorized: Invalid or missing provider webhook signature' });
  }

  const rawEvent = String(payload?.event_type || payload?.event || payload?.type || '').trim().toLowerCase();
  const webhookEventId = String(
    payload?.id || payload?.eventId || req.headers['x-razorpay-event-id'] || ''
  ).trim();
  const resourceId = String(payload?.resource?.id || payload?.data?.object?.id || payload?.transactionId || '').trim();

  // Deduplicate webhook events across all gateways (PayPal WH-, Stripe evt_, Razorpay, etc.)
  if (webhookEventId) {
    try {
      const existingWh = await pool.query(
        'SELECT status FROM payment_webhook_events WHERE event_id = $1 LIMIT 1',
        [webhookEventId]
      );
      if (existingWh.rows.length > 0 && existingWh.rows[0].status === 'processed') {
        return res.json({ received: true, replayed: true });
      }
      await pool.query(
        `INSERT INTO payment_webhook_events (event_id, gateway, event_type, resource_id, status, payload, created_at)
         VALUES ($1, $2, $3, $4, 'received', $5, NOW())
         ON CONFLICT (event_id) DO NOTHING`,
        [webhookEventId, gateway, rawEvent, resourceId || null, JSON.stringify(payload)]
      );
    } catch {
      // Ignore if table unavailable in unit mock
    }
  }

  const markWebhookEvent = async (status: 'processed' | 'ignored' | 'failed', sessionId?: string | null, errMsg?: string) => {
    if (!webhookEventId) return;
    try {
      await pool.query(
        `UPDATE payment_webhook_events
            SET status = $1,
                session_id = COALESCE($2, session_id),
                error_message = $3,
                processed_at = NOW()
          WHERE event_id = $4`,
        [status, sessionId || null, errMsg || null, webhookEventId]
      );
    } catch {}
  };

  // Handle PayPal non-crediting lifecycle events cleanly
  if (gateway === 'paypal') {
    if (rawEvent === 'checkout.order.approved' || rawEvent === 'order.approved') {
      const approvedOrderId = String(payload?.resource?.id || '').trim();
      const unitCustomId = String(
        payload?.resource?.purchase_units?.[0]?.custom_id ||
        payload?.resource?.purchase_units?.[0]?.reference_id ||
        payload?.resource?.purchase_units?.[0]?.invoice_id ||
        ''
      ).trim();

      let matchedId: string | null = null;
      try {
        const upRes = await pool.query(
          `UPDATE payment_checkout_sessions
              SET status = CASE WHEN status = 'pending' THEN 'approved' ELSE status END,
                  paypal_order_id = COALESCE(paypal_order_id, $1::text),
                  last_webhook_event_id = COALESCE($2::text, last_webhook_event_id),
                  updated_at = NOW()
            WHERE id = $3::text OR paypal_order_id = $1::text OR provider_tx_id = $1::text
            RETURNING id`,
          [approvedOrderId || null, webhookEventId || null, unitCustomId || approvedOrderId]
        );
        matchedId = upRes.rows[0]?.id || null;
      } catch {}

      await markWebhookEvent('processed', matchedId);
      return res.json({ received: true, status: 'approved' });
    }

    if (rawEvent === 'payment.capture.denied' || rawEvent === 'payment.capture.declined') {
      const capId = String(payload?.resource?.id || '').trim();
      const relOrdId = String(payload?.resource?.supplementary_data?.related_ids?.order_id || '').trim();
      const custId = String(payload?.resource?.custom_id || payload?.resource?.invoice_id || '').trim();
      let matchedId: string | null = null;
      try {
        const upRes = await pool.query(
          `UPDATE payment_checkout_sessions
              SET status = CASE WHEN status IN ('pending', 'approved') THEN 'failed' ELSE status END,
                  paypal_capture_id = COALESCE(paypal_capture_id, $1::text),
                  last_webhook_event_id = COALESCE($2::text, last_webhook_event_id),
                  updated_at = NOW()
            WHERE id = $3::text OR paypal_order_id = $4::text OR provider_tx_id = $4::text OR paypal_capture_id = $1::text
            RETURNING id`,
          [capId || null, webhookEventId || null, custId || capId, relOrdId || capId]
        );
        matchedId = upRes.rows[0]?.id || null;
      } catch {}
      await markWebhookEvent('processed', matchedId);
      return res.json({ received: true, status: 'failed' });
    }

    if (rawEvent === 'payment.capture.pending') {
      const custId = String(payload?.resource?.custom_id || payload?.resource?.invoice_id || '').trim();
      await markWebhookEvent('processed', custId || null);
      return res.json({ received: true, status: 'pending' });
    }

    if (rawEvent === 'payment.capture.refunded' || rawEvent === 'payment.capture.reversed') {
      const refundOrCapId = String(payload?.resource?.id || '').trim();
      const relatedCapId = String(
        payload?.resource?.supplementary_data?.related_ids?.capture_id ||
        payload?.resource?.id ||
        ''
      ).trim();
      const relatedOrderId = String(payload?.resource?.supplementary_data?.related_ids?.order_id || '').trim();
      const custId = String(payload?.resource?.custom_id || payload?.resource?.invoice_id || '').trim();

      let sessRow: any = null;
      try {
        const findRes = await pool.query(
          `SELECT * FROM payment_checkout_sessions
            WHERE id = $1::text
               OR paypal_capture_id = $2::text
               OR provider_tx_id = $2::text
               OR paypal_order_id = $3::text
               OR provider_tx_id = $3::text
            LIMIT 1`,
          [custId || '__none__', relatedCapId || refundOrCapId || '__none__', relatedOrderId || '__none__']
        );
        sessRow = findRes.rows[0] || null;
      } catch {}

      if (sessRow && (sessRow.status === 'completed' || sessRow.status === 'partially_refunded')) {
        const revAmount = Number(payload?.resource?.amount?.value ?? sessRow.expected_amount);
        const safeRevAmount = Number.isFinite(revAmount) && revAmount > 0 ? revAmount : Number(sessRow.expected_amount);
        await postgresStore.executeInTransaction(async (client) => {
          const lockedSessRes = await client.query(
            'SELECT * FROM payment_checkout_sessions WHERE id = $1 FOR UPDATE',
            [sessRow.id]
          );
          const lockedSess = lockedSessRes.rows[0];
          if (!lockedSess || !['completed', 'partially_refunded'].includes(lockedSess.status)) {
            return;
          }
          const existingMeta = typeof lockedSess.metadata === 'string'
            ? (() => { try { return JSON.parse(lockedSess.metadata); } catch { return {}; } })()
            : (lockedSess.metadata || {});
          const prevRefundedCents = toCents(Number(existingMeta.refundedAmount || 0));
          const expectedCents = toCents(Number(lockedSess.expected_amount || 0));
          const remainingCents = Math.max(0, expectedCents - prevRefundedCents);
          const appliedRevCents = Math.min(toCents(safeRevAmount), remainingCents > 0 ? remainingCents : toCents(safeRevAmount));
          const totalRefundedCents = prevRefundedCents + appliedRevCents;
          const nextStatus = totalRefundedCents >= expectedCents ? 'refunded' : 'partially_refunded';
          const nextMeta = {
            ...existingMeta,
            refundedAmount: Number((totalRefundedCents / 100).toFixed(2)),
            lastRefundReference: refundOrCapId || relatedCapId || lockedSess.id
          };

          if (lockedSess.order_id) {
            const ordLockRes = await client.query('SELECT id, status FROM orders WHERE id = $1 FOR UPDATE', [lockedSess.order_id]).catch(() => ({ rows: [] }));
            const linkedOrd = ordLockRes.rows[0];
            if (linkedOrd && ['funded_in_escrow', 'in_progress', 'delivered', 'revision_requested'].includes(linkedOrd.status)) {
              await client.query(
                "UPDATE orders SET status = 'disputed', previous_status = $1, updated_at = NOW() WHERE id = $2",
                [linkedOrd.status, linkedOrd.id]
              ).catch(() => {});
            }
          }
          await client.query(
            `UPDATE payment_checkout_sessions
                SET status = $1,
                    metadata = $2::jsonb,
                    last_webhook_event_id = COALESCE($3, last_webhook_event_id),
                    updated_at = NOW()
              WHERE id = $4`,
            [nextStatus, JSON.stringify(nextMeta), webhookEventId || null, lockedSess.id]
          ).catch(async () => {
            await client.query("UPDATE payment_checkout_sessions SET status = $1 WHERE id = $2", [nextStatus, lockedSess.id]);
          });
          if (appliedRevCents > 0) {
            await financialTransactionService.reverseGatewayDeposit({
              userId: String(lockedSess.user_id),
              amount: Number((appliedRevCents / 100).toFixed(2)),
              reference: refundOrCapId || relatedCapId || lockedSess.id,
              idempotencyKey: `WH-REFUND-${lockedSess.id}-${refundOrCapId || relatedCapId}`
            }, client);
          }
        });
        await syncUserBalances([String(sessRow.user_id)]);
      }

      await markWebhookEvent('processed', sessRow?.id || null);
      return res.json({ received: true, status: 'refunded' });
    }
  }

  const creditingEvents = [
    'payment.succeeded',
    'checkout.session.completed',
    'payment_intent.succeeded',
    'payment.captured',
    'payment_link.paid',
    'payment.capture.completed',
    'checkout.order.completed'
  ];
  if (!creditingEvents.includes(rawEvent)) {
    await markWebhookEvent('ignored');
    return res.json({ received: true });
  }

  // On PayPal PAYMENT.CAPTURE.COMPLETED, require resource.status === 'COMPLETED' if resource.status is present
  if (gateway === 'paypal' && rawEvent === 'payment.capture.completed') {
    const capStatus = String(payload?.resource?.status || 'COMPLETED').toUpperCase().trim();
    if (capStatus !== 'COMPLETED') {
      await markWebhookEvent('ignored', null, `Capture status is ${capStatus}, not COMPLETED`);
      return res.status(400).json({ error: `PayPal capture status is "${capStatus}". Only COMPLETED captures can be credited.` });
    }
  }

  const txId = String(
    payload?.resource?.id ||
    payload?.payload?.payment?.entity?.id ||
    payload?.payload?.payment_link?.entity?.id ||
    payload?.transactionId ||
    payload?.data?.object?.id ||
    payload?.id ||
    payload?.eventId ||
    ''
  ).trim();
  if (!txId) {
    await markWebhookEvent('failed', null, 'Missing transactionId');
    return res.status(400).json({ error: 'Missing required transactionId or eventId' });
  }

  // Strictly extract currency from the webhook payload — DO NOT default missing currency to 'USD'!
  const explicitRawCurrency =
    payload?.currency ??
    payload?.resource?.amount?.currency_code ??
    payload?.resource?.purchase_units?.[0]?.amount?.currency_code ??
    payload?.data?.object?.currency ??
    payload?.payload?.payment?.entity?.currency ??
    payload?.payload?.payment_link?.entity?.currency ??
    '';
  const currency = String(explicitRawCurrency).trim().toUpperCase();
  if (currency !== 'USD') {
    await markWebhookEvent('failed', null, `Invalid or missing currency: "${currency}"`);
    return res.status(400).json({ error: 'Invalid or missing currency: provider webhook currency must be explicitly USD.' });
  }

  const rawVal =
    payload?.amount !== undefined
      ? payload.amount
      : payload?.resource?.amount?.value !== undefined
        ? payload.resource.amount.value
        : payload?.resource?.purchase_units?.[0]?.amount?.value !== undefined
          ? payload.resource.purchase_units[0].amount.value
          : payload?.data?.object?.amount_total !== undefined
            ? Number(payload.data.object.amount_total) / 100
            : payload?.payload?.payment?.entity?.amount !== undefined
              ? Number(payload.payload.payment.entity.amount) / 100
              : payload?.payload?.payment_link?.entity?.amount_paid !== undefined
                ? Number(payload.payload.payment_link.entity.amount_paid) / 100
                : undefined;

  const payloadAmount = rawVal !== undefined && rawVal !== null && String(rawVal).trim() !== ''
    ? Number(rawVal)
    : undefined;

  if (gateway === 'paypal' && (payloadAmount === undefined || !Number.isFinite(payloadAmount) || payloadAmount <= 0)) {
    await markWebhookEvent('failed', null, 'Missing or invalid capture amount in PayPal webhook');
    return res.status(400).json({ error: 'Missing or invalid capture amount in PayPal webhook.' });
  }

  const userId = payload?.userId;
  const reference = payload?.reference || payload?.resource?.invoice_id || txId;

  const customSessionId = String(
    payload?.checkoutId ||
    payload?.sessionId ||
    payload?.resource?.custom_id ||
    payload?.resource?.invoice_id ||
    payload?.resource?.purchase_units?.[0]?.custom_id ||
    payload?.resource?.purchase_units?.[0]?.reference_id ||
    payload?.data?.object?.client_reference_id ||
    payload?.data?.object?.metadata?.checkoutId ||
    payload?.payload?.payment_link?.entity?.reference_id ||
    payload?.payload?.payment?.entity?.notes?.checkoutId ||
    payload?.payload?.payment_link?.entity?.notes?.checkoutId ||
    ''
  ).trim();

  const relatedPayPalOrderId = String(
    payload?.resource?.supplementary_data?.related_ids?.order_id ||
    (rawEvent === 'checkout.order.completed' ? payload?.resource?.id : '') ||
    ''
  ).trim();

  const lookupSessionKey = customSessionId || relatedPayPalOrderId || null;
  const lookupOrderKey = payload?.orderId
    ? String(payload.orderId).trim()
    : (payload?.resource?.invoice_id && !String(payload.resource.invoice_id).startsWith('chk_')
        ? String(payload.resource.invoice_id).trim()
        : null);

  try {
    // Pre-fetch candidate checkout session strictly OUTSIDE the database transaction
    const existingCompletedTx = await pool.query(
      "SELECT id FROM payment_checkout_sessions WHERE (provider_tx_id = $1::text OR paypal_capture_id = $1::text) AND status = 'completed' LIMIT 1",
      [txId]
    ).catch(async () => {
      return await pool.query(
        "SELECT id FROM payment_checkout_sessions WHERE provider_tx_id = $1::text AND status = 'completed' LIMIT 1",
        [txId]
      );
    });
    if (existingCompletedTx.rows.length > 0) {
      await markWebhookEvent('processed', existingCompletedTx.rows[0].id);
      return res.json({ received: true, replayed: true });
    }

    let preSess: any = null;
    if (customSessionId) {
      const preRes = await pool.query(
        'SELECT * FROM payment_checkout_sessions WHERE id = $1::text OR provider_tx_id = $1::text LIMIT 1',
        [customSessionId]
      );
      if (preRes.rows.length > 0) preSess = preRes.rows[0];
    }
    if (!preSess && relatedPayPalOrderId) {
      const preByRelated = await pool.query(
        'SELECT * FROM payment_checkout_sessions WHERE paypal_order_id = $1::text OR provider_tx_id = $1::text LIMIT 1',
        [relatedPayPalOrderId]
      ).catch(async () => {
        return await pool.query(
          'SELECT * FROM payment_checkout_sessions WHERE provider_tx_id = $1::text LIMIT 1',
          [relatedPayPalOrderId]
        );
      });
      if (preByRelated.rows.length > 0) preSess = preByRelated.rows[0];
    }
    if (!preSess) {
      const preByTx = await pool.query(
        'SELECT * FROM payment_checkout_sessions WHERE provider_tx_id = $1::text OR paypal_capture_id = $1::text OR paypal_order_id = $1::text LIMIT 1',
        [txId]
      ).catch(async () => {
        return await pool.query(
          'SELECT * FROM payment_checkout_sessions WHERE provider_tx_id = $1::text LIMIT 1',
          [txId]
        );
      });
      if (preByTx.rows.length > 0) preSess = preByTx.rows[0];
    }
    if (!preSess && !lookupSessionKey && lookupOrderKey) {
      const preByOrd = await pool.query(
        "SELECT * FROM payment_checkout_sessions WHERE order_id = $1 AND status IN ('pending', 'approved') ORDER BY created_at DESC LIMIT 1",
        [lookupOrderKey]
      );
      if (preByOrd.rows.length > 0) preSess = preByOrd.rows[0];
    }

    if (!preSess) {
      await markWebhookEvent('failed', null, 'No matching checkout session found');
      return res.status(400).json({ error: 'Cannot process payment webhook: no matching stored checkout session found.' });
    }

    if (preSess.status === 'completed') {
      await markWebhookEvent('processed', preSess.id);
      return res.json({ received: true, replayed: true });
    }

    const preExpectedAmount = Number(preSess.expected_amount);
    if (!preSess.user_id || !Number.isFinite(preExpectedAmount) || preExpectedAmount <= 0) {
      await markWebhookEvent('failed', preSess.id, 'Invalid user or expected amount on session');
      return res.status(400).json({ error: 'Stored checkout session has invalid user or expected amount.' });
    }
    if (!preSess.currency || String(preSess.currency).toUpperCase() !== 'USD') {
      await markWebhookEvent('failed', preSess.id, 'Session currency mismatch');
      return res.status(400).json({ error: 'Checkout session currency mismatch: must be USD.' });
    }
    if (preSess.gateway && String(preSess.gateway).toLowerCase() !== gateway) {
      await markWebhookEvent('failed', preSess.id, 'Session gateway mismatch');
      return res.status(400).json({ error: 'Checkout session gateway mismatch.' });
    }

    if (payloadAmount !== undefined && Number.isFinite(payloadAmount)) {
      if (toCents(payloadAmount) !== toCents(preExpectedAmount)) {
        await markWebhookEvent('failed', preSess.id, `Amount mismatch: paid ${payloadAmount}, expected ${preExpectedAmount}`);
        return res.status(400).json({ error: 'Checkout session amount mismatch.' });
      }
    }

    let preVerifiedSessionId: string | null = null;
    if (preSess.status === 'pending' || preSess.status === 'approved') {
      const preVerify = await paymentGatewayManager.verifyPaymentEvent({
        gateway: preSess.gateway || gateway,
        sessionId: String(preSess.provider_tx_id || preSess.id),
        expectedCheckoutId: String(preSess.id),
        paypalOrderId: relatedPayPalOrderId || preSess.paypal_order_id || preSess.provider_tx_id,
        transactionId: txId,
        expectedAmount: preExpectedAmount,
        expectedCurrency: 'USD',
        env: preSess.environment || undefined
      });
      if (!preVerify.verified) {
        await markWebhookEvent('failed', preSess.id, preVerify.error || 'Provider verification failed');
        return res.status(400).json({ error: `Provider payment verification failed: ${preVerify.error}` });
      }
      preVerifiedSessionId = String(preSess.id);
    }

    const settled = await settleCompletedCheckoutSession({
      sessionId: String(preSess.id),
      gateway,
      txId,
      paypalOrderId: relatedPayPalOrderId || preSess.paypal_order_id || undefined,
      paypalCaptureId: gateway === 'paypal' ? txId : undefined,
      webhookEventId: webhookEventId || undefined,
      paidAmount: payloadAmount,
      paidCurrency: currency,
      reference: reference || txId || 'WH-DEPOSIT',
      expectedUserId: userId ? String(userId) : undefined,
      expectedOrderId: lookupOrderKey,
      expectedPurpose: payload?.purpose ? String(payload.purpose) : undefined,
      preVerifiedSessionId: preVerifiedSessionId || String(preSess.id),
      preExpectedAmount,
      actor: 'Gateway Webhook',
      source: 'webhook'
    });

    await markWebhookEvent('processed', preSess.id);
    await syncUserBalances([String(preSess.user_id)]);
    return res.json({ received: true, ...(settled.replayed ? { replayed: true } : {}) });
  } catch (e: any) {
    const statusCode = typeof e?.status === 'number' ? e.status : 400;
    await markWebhookEvent('failed', null, e?.message || e?.error || 'Webhook transaction failed');
    return res.status(statusCode).json({ error: e?.message || e?.error || 'Webhook transaction failed' });
  }
};

router.post('/payments/webhook', rateLimit(120, 60_000), express.raw({ type: () => true, limit: '256kb' }), handlePaymentWebhook);
router.post('/webhooks/payment', rateLimit(120, 60_000), express.raw({ type: () => true, limit: '256kb' }), handlePaymentWebhook);

router.post('/payments/escrow/release', requireAuth, requireFinancialActiveStatus, rateLimit(20, 60_000), async (req: Request, res: Response) => {
  const { orderId } = req.body;
  if (!orderId) return res.status(400).json({ error: 'Order ID is required' });
  if (!tryAcquireOrderLock(orderId, res)) return;
  try {
    const userId = (req as any).authenticatedUserId;
    const pool = postgresStore.getPool();
    const callerRes = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
    const caller = callerRes.rows[0];
    const initialOrder = await store.getOrder(orderId);
    if (!initialOrder) return res.status(404).json({ error: 'Order not found' });

    const isAdmin = caller?.role === 'admin' || caller?.role === 'super_admin';
    const isBuyer = userId === initialOrder.buyerId;
    if (!isAdmin && !isBuyer) {
      return res.status(403).json({ error: 'Forbidden: Only the order buyer or administrator can release escrow.' });
    }

    const validationError = validateOrderReleasePreconditions(initialOrder, isAdmin);
    if (validationError) {
      return res.status(validationError.status).json({ error: validationError.error });
    }

    const seller = await store.getUser(initialOrder.sellerId);
    const buyer = await store.getUser(initialOrder.buyerId);

    if (seller) await ensureWallet(seller.id);
    if (buyer) await ensureWallet(buyer.id);

    const actorName = isAdmin ? adminActor(req) : (buyer?.name || 'Authorized Buyer');
    const requestKey = req.body?.requestKey || req.body?.idempotencyKey;

    const txResult = await postgresStore.executeInTransaction(async (client) => {
      const orderLockRes = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
      if (orderLockRes.rows.length === 0) {
        const err: any = new Error('Order not found');
        err.statusCode = 404;
        throw err;
      }
      const order = (store as any).mapOrderRow ? (store as any).mapOrderRow(orderLockRes.rows[0]) : await store.getOrder(orderId, client);
      if (!order) {
        const err: any = new Error('Order not found');
        err.statusCode = 404;
        throw err;
      }

      const txValidationError = validateOrderReleasePreconditions(order, isAdmin);
      if (txValidationError) {
        const err: any = new Error(txValidationError.error);
        err.statusCode = txValidationError.status;
        throw err;
      }

      const activeDispRes = await client.query(
        "SELECT 1 FROM disputes WHERE order_id = $1 AND status IN ('open', 'under_investigation', 'under_review') LIMIT 1",
        [order.id]
      );
      if (!isAdmin && activeDispRes.rows.length > 0) {
        const err: any = new Error(
          SITE_CONFIG.AGENCY_MODE
            ? 'Cannot complete order: Order has an active unresolved support review.'
            : 'Cannot release escrow: Order has an active unresolved dispute.'
        );
        err.statusCode = 400;
        throw err;
      }

      let revisionsResolved = false;
      if (Array.isArray(order.revisions)) {
        for (const rev of order.revisions) {
          if (rev.status === 'requested') {
            rev.status = 'resolved';
            revisionsResolved = true;
          }
        }
      }
      if (revisionsResolved) {
        const sysMsg: Message = {
          id: 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
          orderId: order.id,
          senderId: 'system',
          senderName: `${SITE_CONFIG.brandName} Review Desk`,
          text: SITE_CONFIG.AGENCY_MODE
            ? '📝 Revision marked resolved by client.'
            : '📝 Revision resolved by buyer.',
          timestamp: new Date().toISOString(),
          type: 'system',
          metadata: { action: 'revision_resolved' }
        };
        await recordMessage(sysMsg, client);
      }

      const escRes = await client.query('SELECT * FROM escrows WHERE order_id = $1 FOR UPDATE', [order.id]);
      const esc = escRes.rows[0];
      if (!esc || Number(esc.remaining) <= 0 || esc.status === 'released' || esc.status === 'refunded') {
        const err: any = new Error(
          SITE_CONFIG.AGENCY_MODE
            ? 'No refundable or open payment balance remains for this order.'
            : 'No refundable or releasable escrow funds remain for this order.'
        );
        err.statusCode = 400;
        throw err;
      }

      const pendingOffersRes = await client.query(
        "SELECT * FROM workstream_offers WHERE order_id = $1 AND kind = 'invoice' AND status = 'pending' FOR UPDATE",
        [order.id]
      );
      const pendingInvoices = pendingOffersRes.rows;

      const pendingHigherInvoice = pendingInvoices.find(o => Number(o.amount) > Number(esc.remaining));
      if (pendingHigherInvoice) {
        const err: any = new Error(
          SITE_CONFIG.AGENCY_MODE
            ? `Cannot finalize order directly: A final invoice (${pendingHigherInvoice.number} for $${pendingHigherInvoice.amount}) is awaiting payment. Please pay or decline the invoice in the order workspace.`
            : `Cannot release escrow directly: A final invoice (${pendingHigherInvoice.number} for $${pendingHigherInvoice.amount}) is awaiting payment. Please pay or decline the invoice in the workstream.`
        );
        err.statusCode = 400;
        throw err;
      }

      const result = await releaseOrderFunds(order, actorName, 'Buyer approved work', true, requestKey, isAdmin, client);
      await store.saveOrder(order, client);

      if (pendingInvoices.length > 0) {
        await client.query(
          "UPDATE workstream_offers SET status = 'paid', resolved_at = $1, resolved_by = $2 WHERE order_id = $3 AND kind = 'invoice' AND status = 'pending' AND amount <= $4",
          [new Date().toISOString(), caller?.id || userId, order.id, Number(esc.remaining)]
        );
      }

      await registerAuditLog({
        id: 'log_' + Date.now() + '_' + randomUUID().slice(0, 8),
        actor: actorName,
        role: caller?.role || 'buyer',
        action: 'ESCROW_RELEASED_BY_BUYER',
        target: `Order #${order.id}`,
        details: `Escrow release authorized of $${order.amount}. $${result.freelancerNet} credited to ${seller?.name || 'freelancer'}, $${result.platformFee} platform fee.`,
        timestamp: new Date().toLocaleString()
      }, client);

      return { order, result };
    });

    res.json({ success: true, order: enrichOrderWithServiceInfo(txResult.order), freelancerNet: txResult.result.freelancerNet, platformFee: txResult.result.platformFee });
  } catch (err: any) {
    res.status(err?.statusCode || 400).json({ error: err.message });
  } finally {
    releaseOrderLock(orderId);
  }
});

router.post('/payments/escrow/refund', requireAuth, requireActiveStatus, requireFinancialActiveStatus, rateLimit(20, 60_000), async (req: Request, res: Response) => {
  const { orderId } = req.body;
  if (!orderId) return res.status(400).json({ error: 'Order ID is required' });
  if (!tryAcquireOrderLock(orderId, res)) return;
  try {
    const userId = (req as any).authenticatedUserId;
    const pool = postgresStore.getPool();
    const callerRes = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
    const caller = callerRes.rows[0];
    const { reason } = req.body;
    const initialOrder = await store.getOrder(orderId);
    if (!initialOrder) return res.status(404).json({ error: 'Order not found' });

    const buyer = await store.getUser(initialOrder.buyerId);
    if (buyer) await ensureWallet(buyer.id);

    const txResult = await postgresStore.executeInTransaction(async (client) => {
      const orderLockRes = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
      if (orderLockRes.rows.length === 0) {
        const err: any = new Error('Order not found');
        err.statusCode = 404;
        throw err;
      }
      const order = (store as any).mapOrderRow ? (store as any).mapOrderRow(orderLockRes.rows[0]) : await store.getOrder(orderId, client);
      if (!order) {
        const err: any = new Error('Order not found');
        err.statusCode = 404;
        throw err;
      }

      const activeDispute = await store.getDisputeByOrderId(order.id, client);
      if ((activeDispute && (activeDispute.status === 'open' || activeDispute.status === 'under_investigation' || (activeDispute.status as string) === 'under_review')) || order.status === 'disputed') {
        const err: any = new Error('Cannot refund escrow: Order is under active dispute.');
        err.statusCode = 400;
        throw err;
      }
      if (order.status === 'completed') {
        const err: any = new Error('Cannot refund: Order has already been completed.');
        err.statusCode = 400;
        throw err;
      }
      if (order.status === 'cancelled') {
        const err: any = new Error('Cannot refund: Order has already been cancelled/refunded.');
        err.statusCode = 400;
        throw err;
      }

      const isAdmin = caller?.role === 'admin' || caller?.role === 'super_admin';
      const isSeller = userId === order.sellerId;
      const isBuyer = userId === order.buyerId;

      if (isBuyer && !isAdmin && ['delivered', 'draft_review'].includes(order.status)) {
        const err: any = new Error('Work has been delivered. Accept it, request a revision, or open a dispute.');
        err.statusCode = 403;
        throw err;
      }

      const isGigOrder = order.orderType === 'gig' || Boolean(order.gigOrderId);
      if (isGigOrder && isSeller && !isAdmin) {
        const err: any = new Error('Sellers must use the cancellation request.');
        err.statusCode = 403;
        throw err;
      }
      const overdueThresholdHours = LATE_ORDER_PROTECTION_HOURS;
      const deadlineMs = parseDeadlineInstant(order.dueDate, order.createdAt);
      const isOverdueByThreshold = deadlineMs !== null ? (Date.now() > deadlineMs + overdueThresholdHours * 60 * 60 * 1000) : false;

      if (!isAdmin && !isSeller) {
        if (isBuyer && isOverdueByThreshold) {
          if (isGigOrder && (!reason || !String(reason).trim())) {
            const err: any = new Error('Cancellation reason is required for very-late cancellation.');
            err.statusCode = 400;
            throw err;
          }
          order.cancellationType = 'very_late';
        } else if (isBuyer) {
          const err: any = new Error(`Forbidden: Buyer cannot cancel this order until ${overdueThresholdHours} hours have passed past the agreed due date.`);
          err.statusCode = 403;
          throw err;
        } else {
          const err: any = new Error('Forbidden: Not authorized to refund this escrow.');
          err.statusCode = 403;
          throw err;
        }
      }

      const actorName = isAdmin ? adminActor(req) : (caller?.name || (isSeller ? 'Seller' : 'Buyer'));
      const requestKey = req.body?.requestKey || req.body?.idempotencyKey || `REFUND-FULL-${order.id}-${order.amount}`;
      const result = await refundOrderFunds(order, undefined, actorName, reason || (isSeller ? 'Seller cancelled order' : 'Escrow cancellation'), requestKey, undefined, false, client);

      await registerAuditLog({
        id: 'log_' + Date.now() + '_' + randomUUID().slice(0, 8),
        actor: actorName,
        role: caller?.role || (isSeller ? 'seller' : 'buyer'),
        action: isSeller ? 'ESCROW_REFUNDED_BY_SELLER' : (isAdmin ? 'ESCROW_REFUNDED_BY_ADMIN' : 'ESCROW_REFUNDED_BY_BUYER'),
        target: `Order #${order.id}`,
        details: `Escrow refund executed of $${result.refunded} to buyer wallet. Reason: ${reason || 'Escrow cancellation'}`,
        timestamp: new Date().toLocaleString()
      }, client);

      return { order, result };
    });

    res.json({ success: true, order: txResult.order, refunded: txResult.result.refunded });
  } catch (err: any) {
    res.status(err?.statusCode || 400).json({ error: err.message });
  } finally {
    releaseOrderLock(orderId);
  }
});

router.get('/payments/transactions/:userId', requireAuth, async (req: Request, res: Response) => {
  try {
    const authUserId = (req as any).authenticatedUserId;
    const targetUserId = req.params.userId;
    const pool = postgresStore.getPool();
    const callerRes = await pool.query('SELECT role FROM users WHERE id = $1', [authUserId]);
    const caller = callerRes.rows[0];
    const callerRole = String(caller?.role || '').toLowerCase();
    const isAdmin = ['admin', 'super_admin', 'finance_manager'].includes(callerRole);
    if (!isAdmin && authUserId !== targetUserId) {
      return res.status(403).json({ error: 'Forbidden: Access to another user transactions is not allowed.' });
    }
    const userId = targetUserId;
    const userTxns = await financialRepository.getTransactions(userId);
    res.json(userTxns);
  } catch (err: any) {
    res.status(500).json(formatApiError(err));
  }
});

router.get('/payments/invoices/:userId', requireAuth, async (req: Request, res: Response) => {
  try {
    const authUserId = (req as any).authenticatedUserId;
    const targetUserId = req.params.userId;
    const pool = postgresStore.getPool();
    const callerRes = await pool.query('SELECT role FROM users WHERE id = $1', [authUserId]);
    const caller = callerRes.rows[0];
    const isAdmin = caller?.role === 'admin' || caller?.role === 'super_admin';
    if (!isAdmin && authUserId !== targetUserId) {
      return res.status(403).json({ error: 'Forbidden: Access to another user invoices is not allowed.' });
    }
    const userId = targetUserId;
    await processAutoAcceptOrders();
    await financialTransactionService.processEarningsClearing();

    const userOrders = await store.listOrdersForUser(userId);
    const userOrderIds = userOrders.map(o => o.id);

    const [escRes, clrRes] = await Promise.all([
      userOrderIds.length > 0
        ? pool.query('SELECT * FROM escrows WHERE order_id = ANY($1::varchar[])', [userOrderIds])
        : Promise.resolve({ rows: [] as any[] }),
      userOrderIds.length > 0
        ? pool.query(
            "SELECT order_id, COALESCE(SUM(amount), 0) AS net_earned FROM earnings_clearing WHERE order_id = ANY($1::varchar[]) AND status IN ('clearing', 'completed') AND amount > 0 GROUP BY order_id",
            [userOrderIds]
          )
        : Promise.resolve({ rows: [] as any[] })
    ]);
    const escByOrderId = new Map<string, any>(escRes.rows.map((r: any) => [String(r.order_id), r]));
    const netByOrderId = new Map<string, number>(clrRes.rows.map((r: any) => [String(r.order_id), Number(r.net_earned || 0)]));

    const currentUser = await store.getUser(userId);
    const orderInvoices = await Promise.all(userOrders.map(async o => {
      const isBuyer = o.buyerId === userId;
      const otherUser = await store.getUser(isBuyer ? o.sellerId : o.buyerId);
      const escRow = escByOrderId.get(o.id);
      const releasedGross = escRow ? Number(escRow.released_gross || 0) : 0;
      const refundedGross = escRow ? Number(escRow.refunded_total || 0) : 0;
      const netEarned = netByOrderId.get(o.id) || 0;

      const quote = (o.feeBreakdown as any)?.clientTotal !== undefined
        ? (o.feeBreakdown as any)
        : await quoteOrderWithLiveSettings(o.amount).catch(() => calculateOrderFees(o.amount));

      const isPaid = Boolean((escRow && (escRow.status === 'released' || escRow.status === 'split' || releasedGross > 0)) || netEarned > 0);
      const isRefunded = !isPaid && Boolean(escRow && (escRow.status === 'refunded' || refundedGross > 0));
      const invStatus = isPaid ? 'paid' : isRefunded ? 'refunded' : 'in_escrow';

      const subtotal = releasedGross > 0 ? releasedGross : Number(o.amount || 0);
      const platformFee = isPaid && netEarned > 0
        ? Math.max(0, Number((subtotal - netEarned).toFixed(2)))
        : Number(o.feeBreakdown?.platformCommission ?? quote.platformCommission ?? 0);
      const sellerNet = isPaid && netEarned > 0
        ? Number(netEarned.toFixed(2))
        : Math.max(0, Number((subtotal - platformFee).toFixed(2)));

      return {
        id: `inv_ord_${o.id}`,
        invoiceNumber: `INV-${o.id.replace('ord_', '').toUpperCase()}`,
        userId: userId,
        type: isBuyer ? 'received' : 'sent',
        recipientName: isBuyer ? (currentUser?.name || 'Buyer') : (otherUser?.name || 'Client'),
        recipientEmail: isBuyer ? (currentUser?.email || 'buyer@example.com') : (otherUser?.email || 'client@example.com'),
        issuerName: isBuyer ? (otherUser?.name || 'Freelancer') : (currentUser?.name || 'Freelancer'),
        issuerEmail: isBuyer ? (otherUser?.email || 'seller@example.com') : (currentUser?.email || 'seller@example.com'),
        title: o.title,
        issueDate: o.createdAt,
        dueDate: o.dueDate,
        status: invStatus,
        items: [
          { description: o.title, quantity: 1, unitPrice: subtotal, amount: subtotal }
        ],
        subtotal,
        serviceFee: o.feeBreakdown?.serviceFee ?? quote.serviceFee,
        smallOrderFee: o.feeBreakdown?.smallOrderFee ?? quote.smallOrderFee,
        platformFee,
        sellerNet,
        tax: 0,
        total: o.feeBreakdown?.clientTotal ?? quote.clientTotal,
        notes: `${SITE_CONFIG.brandName} Order #${o.id} — Secure Payment Receipt.`,
        relatedOrderId: o.id
      };
    }));

    let userCustom: any[] = [];
    try {
      const customInvoices = await store.listCustomInvoicesForUser(userId);
      userCustom = customInvoices.map((r: any) => ({
        id: r.id,
        invoiceNumber: r.invoiceNumber,
        userId: userId,
        buyerId: r.buyerId,
        sellerId: r.sellerId,
        type: r.buyerId === userId ? 'received' : 'sent',
        recipientName: r.recipientName || 'Client',
        recipientEmail: r.recipientEmail || 'client@example.com',
        title: r.description || `Invoice ${r.invoiceNumber}`,
        issueDate: r.createdAt ? r.createdAt.slice(0, 10) : new Date().toISOString().slice(0, 10),
        dueDate: r.dueDate || r.paidAt || new Date().toISOString().slice(0, 10),
        status: r.status,
        items: Array.isArray(r.items) && r.items.length > 0
          ? r.items
          : [{ description: r.description || 'Service', quantity: 1, unitPrice: Number(r.amount), amount: Number(r.amount) }],
        subtotal: Number(r.amount),
        platformFee: 0,
        tax: 0,
        total: Number(r.amount),
        notes: r.notes || `Standard ${SITE_CONFIG.brandName} Invoice`,
        relatedOrderId: r.relatedOrderId || undefined
      }));
    } catch {}

    res.json([...orderInvoices, ...userCustom]);
  } catch (err: any) {
    res.status(500).json(formatApiError(err));
  }
});

router.post('/payments/invoices', requireAuth, requireFinancialActiveStatus, rateLimit(20, 60_000), async (req: Request, res: Response) => {
  try {
    const authenticatedUserId = (req as any).authenticatedUserId;
    const {
      recipientName,
      recipientEmail,
      title,
      dueDate,
      items,
      notes,
      orderId,
      relatedOrderId,
      buyerId: reqBuyerId,
      sellerId: reqSellerId,
      recipientId
    } = req.body || {};

    const pool = postgresStore.getPool();
    const callerRes = await pool.query('SELECT * FROM users WHERE id = $1', [authenticatedUserId]);
    const caller = callerRes.rows[0];
    if (!caller) {
      return res.status(401).json({ error: 'Unauthorized: Authenticated user not found.' });
    }
    if (SITE_CONFIG.AGENCY_MODE && !isStaffUser(caller)) {
      return res.status(403).json({ error: 'Forbidden: Only agency staff can create invoices.' });
    }
    const isAdmin = caller.role === 'admin' || caller.role === 'super_admin';

    const linkedOrderId = (orderId || relatedOrderId) ? String(orderId || relatedOrderId).trim() : null;
    let resolvedBuyerId: string | null = null;
    let resolvedSellerId: string | null = null;
    let resolvedOrderId: string | null = null;
    let resolvedRecipientName = recipientName ? String(recipientName).trim() : '';
    let resolvedRecipientEmail = recipientEmail ? String(recipientEmail).trim() : '';

    if (linkedOrderId) {
      const ordRes = await pool.query('SELECT * FROM orders WHERE id = $1', [linkedOrderId]);
      if (ordRes.rows.length === 0) {
        return res.status(404).json({ error: 'Related order not found.' });
      }
      const ord = ordRes.rows[0];
      if (!isAdmin && ord.seller_id !== authenticatedUserId && ord.buyer_id !== authenticatedUserId) {
        return res.status(403).json({ error: 'Forbidden: You are not an authorized participant on this order.' });
      }
      if (reqBuyerId && String(reqBuyerId).trim() !== ord.buyer_id) {
        return res.status(400).json({ error: 'Specified buyerId does not match the linked order buyer.' });
      }
      if (reqSellerId && String(reqSellerId).trim() !== ord.seller_id) {
        return res.status(400).json({ error: 'Specified sellerId does not match the linked order seller.' });
      }
      resolvedBuyerId = ord.buyer_id;
      resolvedSellerId = ord.seller_id;
      resolvedOrderId = ord.id;
    } else {
      // Resolve distinct buyer and seller from explicit party IDs, recipientEmail, or authorized order context
      const candidateBuyerId = (reqBuyerId || recipientId) ? String(reqBuyerId || recipientId).trim() : null;
      const candidateSellerId = reqSellerId ? String(reqSellerId).trim() : null;

      if (isAdmin && candidateBuyerId && candidateSellerId) {
        resolvedBuyerId = candidateBuyerId;
        resolvedSellerId = candidateSellerId;
      } else if (candidateBuyerId && candidateBuyerId !== authenticatedUserId) {
        resolvedSellerId = candidateSellerId || authenticatedUserId;
        resolvedBuyerId = candidateBuyerId;
      } else if (candidateSellerId && candidateSellerId !== authenticatedUserId) {
        resolvedBuyerId = candidateBuyerId || authenticatedUserId;
        resolvedSellerId = candidateSellerId;
      } else if (resolvedRecipientEmail) {
        const byEmailRes = await pool.query('SELECT id, name, email FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1', [resolvedRecipientEmail]);
        if (byEmailRes.rows.length > 0 && byEmailRes.rows[0].id !== authenticatedUserId) {
          resolvedSellerId = authenticatedUserId;
          resolvedBuyerId = byEmailRes.rows[0].id;
        }
      }

      // If still unresolved, check if the authenticated seller has an order with a buyer matching recipientName
      if (!resolvedBuyerId && resolvedRecipientName) {
        const ordMatchRes = await pool.query(
          `SELECT o.id, o.buyer_id, o.seller_id, u.name, u.email
           FROM orders o
           JOIN users u ON u.id = o.buyer_id
           WHERE o.seller_id = $1 AND (LOWER(u.name) = LOWER($2) OR LOWER(o.buyer_username) = LOWER($2))
           ORDER BY o.created_at DESC LIMIT 1`,
          [authenticatedUserId, resolvedRecipientName]
        );
        if (ordMatchRes.rows.length > 0) {
          resolvedBuyerId = ordMatchRes.rows[0].buyer_id;
          resolvedSellerId = ordMatchRes.rows[0].seller_id;
          resolvedOrderId = ordMatchRes.rows[0].id;
        }
      }

      if (!resolvedBuyerId || !resolvedSellerId) {
        return res.status(400).json({
          error: 'A valid related order (orderId/relatedOrderId) or distinct counterparty (buyerId or registered recipientEmail) is required to create an invoice.'
        });
      }

      if (!isAdmin && resolvedSellerId !== authenticatedUserId && resolvedBuyerId !== authenticatedUserId) {
        return res.status(403).json({ error: 'Forbidden: You must be an authorized participant on the invoice.' });
      }
    }

    if (resolvedBuyerId === resolvedSellerId) {
      return res.status(400).json({ error: 'Invalid invoice participants: buyerId and sellerId must be distinct users.' });
    }

    const partiesRes = await pool.query('SELECT id, name, email FROM users WHERE id IN ($1, $2)', [resolvedBuyerId, resolvedSellerId]);
    const buyerUser = partiesRes.rows.find((u: any) => u.id === resolvedBuyerId);
    const sellerUser = partiesRes.rows.find((u: any) => u.id === resolvedSellerId);
    if (!buyerUser || !sellerUser) {
      return res.status(404).json({ error: 'Invoice buyer or seller user account not found.' });
    }

    if (!resolvedOrderId) {
      const relOrderRes = await pool.query(
        'SELECT id FROM orders WHERE buyer_id = $1 AND seller_id = $2 ORDER BY created_at DESC LIMIT 1',
        [resolvedBuyerId, resolvedSellerId]
      );
      if (relOrderRes.rows.length > 0) {
        resolvedOrderId = relOrderRes.rows[0].id;
      } else if (!isAdmin) {
        const relWsRes = await pool.query(
          'SELECT workspace_id FROM workspaces WHERE buyer_id = $1 AND seller_id = $2 LIMIT 1',
          [resolvedBuyerId, resolvedSellerId]
        );
        if (relWsRes.rows.length === 0) {
          return res.status(403).json({
            error: 'Forbidden: Custom invoices require an existing order or workspace relationship between buyer and seller.'
          });
        }
      }
    }

    if (!resolvedRecipientName) {
      resolvedRecipientName = buyerUser.name;
    }
    if (!resolvedRecipientEmail) {
      resolvedRecipientEmail = buyerUser.email;
    }

    if (!title || !resolvedRecipientName) {
      return res.status(400).json({ error: 'Title and recipient name are required' });
    }

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'At least one invoice line item is required.' });
    }
    if (items.length > 100) {
      return res.status(400).json({ error: 'An invoice cannot contain more than 100 line items.' });
    }

    let subtotalCents = 0;
    const cleanItems = [];
    for (const it of items) {
      const qty = Number(it?.quantity);
      const unitPrice = Number(it?.unitPrice ?? it?.price ?? it?.amount);
      if (!Number.isFinite(qty) || qty <= 0 || qty > 10000) {
        return res.status(400).json({ error: 'Each invoice line item quantity must be a positive number up to 10,000.' });
      }
      if (!Number.isFinite(unitPrice) || unitPrice < 0 || unitPrice > 100000) {
        return res.status(400).json({ error: 'Each invoice line item price must be between $0 and $100,000.' });
      }
      const itemAmount = Number((qty * unitPrice).toFixed(2));
      subtotalCents += Math.round(itemAmount * 100);
      cleanItems.push({
        description: String(it?.description || title).slice(0, 255),
        quantity: qty,
        unitPrice,
        amount: itemAmount
      });
    }
    const subtotal = Number((subtotalCents / 100).toFixed(2));
    if (subtotal < 5) {
      return res.status(400).json({ error: 'Minimum invoice amount is $5.00.' });
    }
    if (subtotal > 100000) {
      return res.status(400).json({ error: 'Maximum invoice amount is $100,000.00.' });
    }
    const platformFee = 0;
    const total = subtotal;

    const newInvoice: CustomInvoice = {
      id: 'inv_' + Date.now() + '_' + randomUUID().slice(0, 8),
      invoiceNumber: `INV-${Date.now().toString().slice(-6)}-${randomUUID().slice(0, 4).toUpperCase()}`,
      userId: authenticatedUserId,
      buyerId: resolvedBuyerId || undefined,
      sellerId: resolvedSellerId || undefined,
      recipientName: resolvedRecipientName,
      recipientEmail: resolvedRecipientEmail,
      title,
      issueDate: new Date().toISOString().substring(0, 10),
      dueDate: dueDate || new Date(Date.now() + 14 * 86400000).toISOString().substring(0, 10),
      status: 'unpaid',
      items: cleanItems,
      subtotal,
      platformFee,
      tax: 0,
      total,
      notes: notes || `Standard ${SITE_CONFIG.brandName} Invoice`,
      relatedOrderId: resolvedOrderId || undefined
    };

    const invToSave = {
      id: newInvoice.id,
      invoiceNumber: newInvoice.invoiceNumber,
      buyerId: resolvedBuyerId,
      sellerId: resolvedSellerId,
      recipientName: newInvoice.recipientName,
      recipientEmail: newInvoice.recipientEmail,
      dueDate: newInvoice.dueDate,
      notes: newInvoice.notes,
      items: newInvoice.items,
      amount: newInvoice.total,
      total: newInvoice.total,
      status: newInvoice.status,
      description: newInvoice.title,
      createdAt: newInvoice.issueDate,
      relatedOrderId: resolvedOrderId || undefined
    };
    await store.saveCustomInvoice(invToSave as any);

    res.status(201).json(newInvoice);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/payments/methods/:userId', requireAuth, async (req: Request, res: Response) => {
  try {
    const authUserId = (req as any).authenticatedUserId;
    const pool = postgresStore.getPool();
    const callerRes = await pool.query('SELECT role FROM users WHERE id = $1', [authUserId]);
    const caller = callerRes.rows[0];
    if (!canManageAgencyPayouts(caller, SITE_CONFIG.AGENCY_MODE)) {
      return res.status(403).json({ error: 'Forbidden: Payout methods are restricted to agency administrators and staff.' });
    }
    const isAdmin = caller?.role === 'admin' || caller?.role === 'super_admin' || caller?.role === 'finance_manager' || caller?.role === 'support';
    
    if (!isAdmin && authUserId !== req.params.userId) {
      return res.status(403).json({ error: 'Unauthorized: Cannot view another user payment methods.' });
    }

    const methods = await store.listPaymentMethodsForUser(req.params.userId);
    const sanitized = methods.map((m) => sanitizePaymentMethodForClient(m));
    res.json(sanitized);
  } catch (err: any) {
    res.status(500).json(formatApiError(err));
  }
});

router.post('/payments/methods', requireAuth, requireFinancialActiveStatus, rateLimit(20, 60_000), async (req: Request, res: Response) => {
  try {
    const authUserId = (req as any).authenticatedUserId;
    const caller = (req as any).authenticatedUser;
    if (!canManageAgencyPayouts(caller, SITE_CONFIG.AGENCY_MODE)) {
      return res.status(403).json({ error: 'Forbidden: Only agency administrators and staff can manage payout methods.' });
    }
    const { type, name, details, isDefault } = req.body;
    const userId = authUserId;
    
    if (!userId || !type || !name) {
      return res.status(400).json({ error: 'Method type and name are required' });
    }

    // Tight payment method details validation by method type
    const lowerType = String(type).trim().toLowerCase();
    if (lowerType.includes('bank') || lowerType.includes('wire')) {
      if (!details?.accountNumber && !details?.iban && !details?.routingNumber) {
        return res.status(400).json({ error: 'Bank account number, IBAN, or routing number is required for Bank Transfer.' });
      }
    } else if (lowerType.includes('paypal')) {
      if (!details?.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(details.email))) {
        return res.status(400).json({ error: 'A valid email address is required for PayPal payment method.' });
      }
    } else if (lowerType.includes('upi')) {
      if (!details?.vpa && !details?.upiId) {
        return res.status(400).json({ error: 'A valid UPI VPA/ID (e.g., user@upi) is required for UPI payment method.' });
      }
    } else if (lowerType.includes('stripe')) {
      if (!details?.stripeAccountId && !details?.email) {
        return res.status(400).json({ error: 'Stripe account ID or email is required for Stripe payment method.' });
      }
    } else if (lowerType.includes('razorpay')) {
      if (!details?.accountId && !details?.vpa) {
        return res.status(400).json({ error: 'Razorpay account ID or UPI VPA is required.' });
      }
    }

    const existingMethods = await store.listPaymentMethodsForUser(userId);
    const newMethod: PaymentMethodRecord = {
      id: 'pm_' + Date.now() + '_' + randomUUID().slice(0, 8),
      userId,
      type,
      name,
      details: details || {},
      isDefault: Boolean(isDefault) || existingMethods.length === 0,
      createdAt: new Date().toISOString().substring(0, 10)
    };

    await store.savePaymentMethod(newMethod);
    const persisted = await store.getPaymentMethodById(newMethod.id);
    res.json(sanitizePaymentMethodForClient(persisted || newMethod));
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/payments/methods/:id', requireAuth, requireFinancialActiveStatus, async (req: Request, res: Response) => {
  try {
    const authUserId = (req as any).authenticatedUserId;
    const pool = postgresStore.getPool();
    const callerRes = await pool.query('SELECT role FROM users WHERE id = $1', [authUserId]);
    const caller = callerRes.rows[0];
    if (!canManageAgencyPayouts(caller, SITE_CONFIG.AGENCY_MODE)) {
      return res.status(403).json({ error: 'Forbidden: Only agency administrators and staff can delete payout methods.' });
    }
    const isAdmin = caller?.role === 'admin' || caller?.role === 'super_admin' || caller?.role === 'finance_manager';

    const method = await store.getPaymentMethodById(req.params.id);
    if (!method) return res.status(404).json({ error: 'Payment method not found' });

    if (!isAdmin && method.userId !== authUserId) {
      return res.status(403).json({ error: 'Forbidden: Cannot delete another user payment method.' });
    }

    await store.deletePaymentMethod(req.params.id);
    res.json({ success: true, id: req.params.id });
  } catch (err: any) {
    res.status(500).json(formatApiError(err));
  }
});

router.patch('/payments/methods/:id/default', requireAuth, requireFinancialActiveStatus, async (req: Request, res: Response) => {
  try {
    const authUserId = (req as any).authenticatedUserId;
    const pool = postgresStore.getPool();
    const callerRes = await pool.query('SELECT role FROM users WHERE id = $1', [authUserId]);
    const caller = callerRes.rows[0];
    if (!canManageAgencyPayouts(caller, SITE_CONFIG.AGENCY_MODE)) {
      return res.status(403).json({ error: 'Forbidden: Only agency administrators and staff can update default payout methods.' });
    }
    const isAdmin = caller?.role === 'admin' || caller?.role === 'super_admin' || caller?.role === 'finance_manager';

    const method = await store.getPaymentMethodById(req.params.id);
    if (!method) return res.status(404).json({ error: 'Payment method not found' });

    if (!isAdmin && method.userId !== authUserId) {
      return res.status(403).json({ error: 'Forbidden: Cannot modify another user payment method.' });
    }

    await store.setDefaultPaymentMethod(method.userId, method.id);
    method.isDefault = true;
    res.json(sanitizePaymentMethodForClient(method));
  } catch (err: any) {
    res.status(500).json(formatApiError(err));
  }
});

router.post('/wallet/deposit', requireAuth, requireFinancialActiveStatus, rateLimit(10, 60_000), async (req: Request, res: Response) => {
  try {
    if (!areSimulatedDepositsAllowed()) {
      return res.status(501).json({ error: 'Deposits require a connected payment gateway in production.' });
    }

    const authUserId = (req as any).authenticatedUserId;
    if (!authUserId) {
      return res.status(401).json({ error: 'Unauthorized: Authentication required' });
    }

    const pool = postgresStore.getPool();
    const callerRes = await pool.query('SELECT * FROM users WHERE id = $1', [authUserId]);
    const caller = callerRes.rows[0];
    if (!caller) {
      return res.status(401).json({ error: 'Authenticated user not found' });
    }

    const requestedUserId = req.body?.userId;
    let targetUserId = authUserId;
    if (requestedUserId && requestedUserId !== authUserId) {
      const isAdmin = caller.role === 'admin' || caller.role === 'super_admin';
      if (!isAdmin) {
        return res.status(403).json({ error: 'Forbidden: You cannot deposit funds into another user wallet.' });
      }
      const targetUser = await store.getUser(requestedUserId);
      if (!targetUser) {
        return res.status(404).json({ error: 'Target user not found' });
      }
      targetUserId = requestedUserId;
    }
    const amount = Number(req.body?.amount);
    if (!Number.isFinite(amount) || amount <= 0 || Math.abs(Math.round(amount * 100) - amount * 100) > 1e-6) {
      return res.status(400).json({ error: 'Please enter a valid deposit amount greater than $0.00 with at most 2 decimal places.' });
    }
    if (amount > 5000) {
      return res.status(400).json({ error: 'Simulated deposits are limited to $5,000.' });
    }

    await financialTransactionService.ensureWallet(targetUserId);
    const key = String(req.body?.idempotencyKey || randomUUID());
    const { replayed } = await financialTransactionService.creditDeposit({
      userId: targetUserId,
      amount,
      reference: `SIM-${key}`,
      idempotencyKey: `SIM-${targetUserId}-${key}`,
      actor: `${caller.name} (Simulated)`,
      source: 'simulated'
    });
    await syncUserBalances();
    const newBal = await financialRepository.getWalletBalance(targetUserId);
    res.json({ success: true, replayed, balance: newBal });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ==========================================
// ADMIN FINANCE REST APIS
// ==========================================

router.post('/admin/finance/reset-clean', requireRole(['super_admin']), async (req: Request, res: Response) => {
  if (IS_PRODUCTION && process.env.ALLOW_DATA_RESET !== 'true') {
    return res.status(403).json({ error: 'Data reset is disabled in production.' });
  }
  try {
    await cleanAllStoreData();
    orderStateLocks.clear();
    res.json({ success: true, message: 'All demo and runtime data reset to pristine clean state.' });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/admin/finance/overview', requireRole(['admin', 'super_admin']), async (req: Request, res: Response) => {
  try {
    const overview = await financialRepository.getFinancialOverview();
    res.json(overview);
  } catch (err: any) {
    res.status(500).json(formatApiError(err));
  }
});

router.get('/admin/finance/wallets', requireAdmin, async (req: Request, res: Response) => {
  try {
    const wallets = await financialRepository.getWallets();
    res.json(wallets);
  } catch (err: any) {
    res.status(500).json(formatApiError(err));
  }
});

router.get('/admin/finance/wallets/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    const data = await financialRepository.getWalletById(req.params.id);
    if (!data) return res.status(404).json({ error: 'Wallet not found' });
    res.json(data);
  } catch (err: any) {
    res.status(500).json(formatApiError(err));
  }
});

router.post('/admin/finance/wallets/:id/freeze', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { reason } = req.body;
    if (!reason) return res.status(400).json({ error: 'Mandatory reason required to freeze a wallet' });
    const wallet = await financialTransactionService.freezeWallet(req.params.id, reason, adminActor(req));
    res.json(wallet);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/admin/finance/wallets/:id/unfreeze', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { reason } = req.body;
    const wallet = await financialTransactionService.unfreezeWallet(req.params.id, reason || 'Administrative review completed', adminActor(req));
    res.json(wallet);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/admin/finance/wallets/:id/restrict', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { reason } = req.body;
    if (!reason) return res.status(400).json({ error: 'Mandatory reason required to restrict a wallet' });
    const wallet = await financialTransactionService.restrictWallet(req.params.id, reason, adminActor(req));
    res.json(wallet);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/admin/finance/transactions', requireAdmin, async (req: Request, res: Response) => {
  try {
    const txns = await financialRepository.getTransactions();
    res.json(txns);
  } catch (err: any) {
    res.status(500).json(formatApiError(err));
  }
});

router.get('/admin/finance/transactions/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    const txn = await financialRepository.getTransactionById(req.params.id);
    if (!txn) return res.status(404).json({ error: 'Transaction not found' });
    const journal = txn.journalId ? await financialRepository.getJournalById(txn.journalId) : null;
    res.json({ transaction: txn, journal });
  } catch (err: any) {
    res.status(500).json(formatApiError(err));
  }
});

router.get('/admin/finance/ledger', requireAdmin, async (req: Request, res: Response) => {
  try {
    const journals = await financialRepository.getJournals();
    res.json(journals);
  } catch (err: any) {
    res.status(500).json(formatApiError(err));
  }
});

router.get('/admin/finance/ledger/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    const journal = await financialRepository.getJournalById(req.params.id);
    if (!journal) return res.status(404).json({ error: 'Journal not found' });
    res.json(journal);
  } catch (err: any) {
    res.status(500).json(formatApiError(err));
  }
});

router.post('/admin/finance/ledger/:id/reverse', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { reason } = req.body;
    if (!reason) return res.status(400).json({ error: 'Mandatory accounting reversal reason required' });
    const reversal = await financialTransactionService.reverseJournal(req.params.id, reason, adminActor(req));
    res.json(reversal);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/admin/finance/escrow', requireAdmin, async (req: Request, res: Response) => {
  try {
    const allOrders = await store.listOrders();

    const disputesRes = await postgresStore.getPool().query("SELECT * FROM disputes WHERE status IN ('open', 'under_investigation')");
    const activeDisputes = new Set(disputesRes.rows.map((r: any) => r.order_id));

    const refundsRes = await postgresStore.getPool().query("SELECT * FROM refunds WHERE status = 'approved'");
    const activeRefunds = new Set(refundsRes.rows.map((r: any) => r.order_id));

    const [allUsers, escrowsRes] = await Promise.all([
      store.listUsers(),
      postgresStore.getPool().query('SELECT * FROM escrows')
    ]);
    const userMap = new Map(allUsers.map(u => [u.id, u]));
    const escrowMap = new Map(escrowsRes.rows.map((r: any) => [r.order_id, financialRepository.formatEscrowRow(r)]));

    const escrowOrders = allOrders.map(o => {
      const enriched = enrichOrderWithServiceInfo(o);
      const isDisputed = activeDisputes.has(o.id);
      const isRefunded = activeRefunds.has(o.id);
      const buyer = userMap.get(o.buyerId);
      const seller = userMap.get(o.sellerId);

      let escrowState = 'in_progress';
      if (isDisputed) escrowState = 'disputed';
      else if (isRefunded) escrowState = 'refunded';
      else if (o.status === 'completed') escrowState = 'released';
      else if (o.status === 'delivered') escrowState = 'release_pending';
      else if (o.status === 'funded_in_escrow') escrowState = 'funded';

      const esc = escrowMap.get(o.id);
      const fbComm = (o.feeBreakdown as any)?.commissionPercent;
      const liveCommRate = siteSettings.getSettings()?.commission?.commissionPercent ?? DEFAULT_FEE_CONFIG.commissionPercent;
      const effectiveCommRate = (esc?.commissionPercent !== undefined && esc?.commissionPercent !== null)
        ? Number(esc.commissionPercent)
        : (fbComm !== undefined && fbComm !== null ? Number(fbComm) : liveCommRate);

      return {
        ...enriched,
        buyerName: buyer?.name || 'Buyer #' + o.buyerId,
        buyerEmail: buyer?.email || '',
        sellerName: seller?.name || 'Freelancer #' + o.sellerId,
        sellerEmail: seller?.email || '',
        platformFeeRate: `${effectiveCommRate}%`,
        platformFeeAmount: FinanceLedgerEngine.round(o.amount * effectiveCommRate / 100),
        freelancerNetAmount: FinanceLedgerEngine.round(o.amount - o.amount * effectiveCommRate / 100),
        ledgerEscrowStatus: esc?.status || 'not_funded',
        ledgerEscrowHeld: esc?.remaining ?? 0,
        escrowState,
        isDisputed
      };
    });
    res.json(escrowOrders);
  } catch (err: any) {
    res.status(500).json(formatApiError(err));
  }
});

router.post('/admin/finance/escrow/:orderId/release', requireAdmin, async (req: Request, res: Response) => {
  const orderId = req.params.orderId;
  if (!tryAcquireOrderLock(orderId, res)) return;
  try {
    const txResult = await postgresStore.executeInTransaction(async (client) => {
      const orderLockRes = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
      if (orderLockRes.rows.length === 0) {
        const err: any = new Error('Order not found');
        err.statusCode = 404;
        throw err;
      }
      const order = (store as any).mapOrderRow ? (store as any).mapOrderRow(orderLockRes.rows[0]) : await store.getOrder(orderId, client);
      if (!order) {
        const err: any = new Error('Order not found');
        err.statusCode = 404;
        throw err;
      }
      if (order.status === 'completed') {
        throw new Error('Order escrow has already been released and completed.');
      }
      if (order.status === 'cancelled') {
        throw new Error('Cannot release escrow: Order has already been cancelled/refunded.');
      }
      const activeDispute = await store.getDisputeByOrderId(order.id, client);
      if ((activeDispute && (activeDispute.status === 'open' || activeDispute.status === 'under_investigation' || (activeDispute.status as string) === 'under_review')) || order.status === 'disputed') {
        throw new Error(`Cannot release escrow: Order #${order.id} is under active dispute. Resolve the dispute first.`);
      }
      const escRes = await client.query('SELECT * FROM escrows WHERE order_id = $1 FOR UPDATE', [order.id]);
      const esc = escRes.rows[0];
      if (!esc || Number(esc.remaining) <= 0 || esc.status === 'released' || esc.status === 'refunded') {
        throw new Error('No refundable or releasable escrow funds remain for this order.');
      }
      const result = await releaseOrderFunds(order, adminActor(req), String(req.body.reason || 'Administrative escrow release'), false, req.body.requestKey, false, client);
      await store.saveOrder(order, client);
      await client.query(
        "UPDATE workstream_offers SET status = 'paid', resolved_at = $1, resolved_by = $2 WHERE order_id = $3 AND kind = 'invoice' AND status = 'pending' AND amount <= $4",
        [new Date().toISOString(), adminActor(req), order.id, Number(esc.remaining)]
      );
      return { order, result };
    });
    res.json({ success: true, order: txResult.order, journal: txResult.result.journal, freelancerNet: txResult.result.freelancerNet, platformFee: txResult.result.platformFee });
  } catch (err: any) {
    res.status(err?.statusCode || 400).json({ error: err.message });
  } finally {
    releaseOrderLock(orderId);
  }
});

router.post('/admin/finance/escrow/:orderId/refund', requireAdmin, async (req: Request, res: Response) => {
  const orderId = req.params.orderId;
  if (!tryAcquireOrderLock(orderId, res)) return;
  try {
    const amount = req.body.amount === undefined || req.body.amount === '' ? undefined : Number(req.body.amount);
    const reason = String(req.body.reason || 'Administrative escrow refund approval');
    const actor = adminActor(req);
    const requestKey = req.body.requestKey || req.body.idempotencyKey;

    const result = await postgresStore.executeInTransaction(async (client) => {
      // 1. Lock order row
      const orderRes = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
      if (orderRes.rows.length === 0) throw new Error('Order not found');
      const orderRow = orderRes.rows[0];

      if (orderRow.status === 'completed') {
        throw new Error('Cannot refund order: Escrow funds have already been released to seller.');
      }
      if (orderRow.status === 'cancelled') {
        throw new Error('Order is already cancelled/refunded.');
      }

      // 2. Lock escrow row
      const escRes = await client.query('SELECT * FROM escrows WHERE order_id = $1 FOR UPDATE', [orderId]);
      if (escRes.rows.length === 0) throw new Error('Escrow record not found for this order.');
      const escrow = escRes.rows[0];
      if (Number(escrow.remaining) <= 0 || escrow.status === 'released' || escrow.status === 'refunded') {
        throw new Error('No refundable escrow funds remaining for this order.');
      }

      // 3. Perform atomic refund financial operation
      const refundResult = await financialTransactionService.refundOrderFunds({
        orderId,
        amount,
        reason,
        actor,
        idempotencyKey: requestKey
      }, client);

      // 4. Lock & resolve active dispute in the same transaction
      const dispRes = await client.query(
        "SELECT * FROM disputes WHERE order_id = $1 AND status IN ('open', 'under_investigation') FOR UPDATE",
        [orderId]
      );
      if (dispRes.rows.length > 0) {
        await client.query(
          "UPDATE disputes SET status = 'resolved_refund', resolution_notes = $1, notes = $1 WHERE order_id = $2 AND status IN ('open', 'under_investigation')",
          [reason, orderId]
        );
      }

      return refundResult;
    });

    await syncUserBalances();
    const updatedOrder = await store.getOrder(orderId);
    res.json({ success: true, order: updatedOrder, result });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  } finally {
    releaseOrderLock(orderId);
  }
});

router.get('/admin/finance/payouts', requireAdmin, async (req: Request, res: Response) => {
  try {
    const [payoutsList, allUsers, allWallets] = await Promise.all([
      store.listPayouts(),
      store.listUsers(),
      financialRepository.getWallets()
    ]);
    const userMap = new Map(allUsers.map(u => [u.id, u]));
    const walletMap = new Map(allWallets.map(w => [w.userId, w]));

    const enrichedPayouts = payoutsList.map(p => {
      const freelancer = userMap.get(p.freelancerId);
      const wallet = walletMap.get(p.freelancerId);
      return {
        ...p,
        freelancerName: freelancer?.name || 'Freelancer #' + p.freelancerId,
        freelancerEmail: freelancer?.email || '',
        walletAvailableBalance: wallet?.availableBalance || 0,
        currency: 'USD'
      };
    });
    res.json(enrichedPayouts);
  } catch (err: any) {
    res.status(500).json(formatApiError(err));
  }
});

router.post('/admin/finance/payouts/:id/approve', requireAdmin, approvePayout);
router.post('/admin/finance/payouts/:id/process', requireAdmin, processPayout);
router.post('/admin/finance/payouts/:id/reject', requireAdmin, rejectPayout);
router.post('/admin/finance/payouts/:id/fail', requireAdmin, failPayout);
router.post('/admin/finance/payouts/:id/retry', requireAdmin, retryPayout);

router.patch('/admin/payouts/:id/approve', requireAdmin, approvePayout);
router.patch('/admin/payouts/:id/process', requireAdmin, processPayout);
router.patch('/admin/payouts/:id/fail', requireAdmin, failPayout);

router.get('/admin/finance/reconciliation', requireAdmin, async (req: Request, res: Response) => {
  try {
    const recon = await financialRepository.getReconciliationSummary();
    res.json(recon);
  } catch (err: any) {
    res.status(500).json(formatApiError(err));
  }
});

router.post('/admin/finance/reconciliation/resolve/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    const notes = typeof req.body?.notes === 'string' ? req.body.notes.trim() : '';
    if (!notes) {
      return res.status(400).json({ error: 'Investigation notes required to mark exception resolved' });
    }
    const actor = adminActor(req);
    const role = (req as any).authenticatedUser?.role || 'super_admin';
    const resolved = await financialTransactionService.resolveReconciliationException({
      exceptionId: req.params.id,
      notes,
      actor,
      role
    });
    res.json(resolved);
  } catch (err: any) {
    const statusCode = typeof err?.statusCode === 'number' ? err.statusCode : (typeof err?.status === 'number' ? err.status : 400);
    res.status(statusCode).json({ error: err.message });
  }
});

router.get('/admin/finance/audit', requireAdmin, async (req: Request, res: Response) => {
  try {
    if (!isPostgresEnabled()) {
      return res.status(503).json({ error: 'PostgreSQL persistence is required for financial audit logs.' });
    }
    const logs = await postgresStore.listAuditLogs();
    res.json(logs);
  } catch (err: any) {
    res.status(500).json(formatApiError(err));
  }
});

router.post('/admin/finance/adjustments/preview', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { userId, amount, direction, category, reason } = req.body;
    const preview = await financialRepository.previewAdjustment({ userId, amount: Number(amount), direction, category, reason });
    res.json(preview);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/admin/finance/adjustments', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { userId, amount, direction, category, reason, evidenceReference, requestKey } = req.body;
    const result = await financialTransactionService.executeAdjustment({
      userId,
      amount: Number(amount),
      direction,
      category,
      reason,
      evidenceReference,
      actor: adminActor(req),
      requestKey
    });
    await syncUserBalances();
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/admin/finance/diagnostics', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { severity, service, operation, requestId, legacyOnly } = req.query;
    if (!isPostgresEnabled()) {
      return res.json(diagnosticService.getInMemoryLogs(req.query));
    }
    let sql = 'SELECT * FROM runtime_diagnostic_logs WHERE 1=1';
    const params: any[] = [];
    if (severity) { params.push(severity); sql += ` AND severity = $${params.length}`; }
    if (service) { params.push(service); sql += ` AND service = $${params.length}`; }
    if (operation) { params.push(operation); sql += ` AND operation = $${params.length}`; }
    if (requestId) { params.push(requestId); sql += ` AND request_id = $${params.length}`; }
    if (legacyOnly === 'true') { params.push('financeLedger'); sql += ` AND implementation = $${params.length}`; }
    sql += ' ORDER BY timestamp DESC LIMIT 100';
    
    const logs = await postgresStore.getPool().query(sql, params);
    res.json(logs.rows);
  } catch (err: any) {
    res.status(500).json(formatApiError(err));
  }
});

router.get('/admin/finance/export/:type', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { type } = req.params;
    const { filename, content } = await financialRepository.generateCsvExport(type, req.query as any);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.status(200).send(content);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

export default wrapRouter(router);
