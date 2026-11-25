import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import express from 'express';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { apiRouter } from '../server/routes/index.js';
import { postgresStore } from '../server/db/postgresStore.js';
import { siteSettings } from '../server/domains/admin/siteSettings.js';
import { paymentGatewayManager } from '../server/domains/finance/paymentGateways.js';
import { signToken } from '../server/middleware/auth.js';
import { store } from '../server/store.js';
import { sanitizeAndCreateMessage } from '../server/services/messagingService.js';

describe('Regression Coverage: SQL Queries, Disputes Parsing, Gateway Secret Preservation & Auth Security', () => {
  let app: express.Application;
  let adminToken: string;
  let buyerToken: string;
  let freelancerToken: string;
  const suffix = String(Date.now());
  const adminId = `admin_reg_${suffix}`;
  const buyerId = `buyer_reg_${suffix}`;
  const freelancerId = `free_reg_${suffix}`;

  beforeEach(async () => {
    await postgresStore.runMigrations();
    await siteSettings.resetToDefaults();

    await store.saveUser({
      id: adminId,
      name: 'Regression Admin',
      email: `admin_reg_${suffix}@example.com`,
      role: 'super_admin',
      status: 'active',
      emailVerified: true,
      sessionVersion: 1,
      activeSessionVersions: [1]
    } as any);

    await store.saveUser({
      id: buyerId,
      name: 'Regression Buyer',
      email: `buyer_reg_${suffix}@example.com`,
      role: 'buyer',
      status: 'active',
      emailVerified: true,
      sessionVersion: 1,
      activeSessionVersions: [1]
    } as any);

    await store.saveUser({
      id: freelancerId,
      name: 'Regression Freelancer',
      email: `free_reg_${suffix}@example.com`,
      role: 'freelancer',
      status: 'active',
      emailVerified: true,
      sessionVersion: 1,
      activeSessionVersions: [1]
    } as any);

    app = express();
    app.use(express.json());
    app.use('/api', apiRouter);

    adminToken = signToken({ id: adminId, role: 'super_admin', email: `admin_reg_${suffix}@example.com`, sessionVersion: 1 });
    buyerToken = signToken({ id: buyerId, role: 'buyer', email: `buyer_reg_${suffix}@example.com`, sessionVersion: 1 });
    freelancerToken = signToken({ id: freelancerId, role: 'freelancer', email: `free_reg_${suffix}@example.com`, sessionVersion: 1 });
  });

  it('GET /api/payments/user/:userId queries ledger_journals.created_at without SQL 500 error', async () => {
    const pool = postgresStore.getPool();
    const orderId = `ord_pay_reg_${suffix}`;
    const journalId = `jrnl_reg_${suffix}`;
    const entryId = `le_reg_${suffix}`;

    await store.saveOrder({
      id: orderId,
      title: 'Ledger Query Regression Order',
      buyerId,
      sellerId: freelancerId,
      amount: 120,
      status: 'in_progress',
      createdAt: new Date().toISOString().slice(0, 10),
      dueDate: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10)
    } as any);

    await pool.query(
      `INSERT INTO ledger_journals (id, reference, description, event_type, actor, created_at)
       VALUES ($1, $2, 'Test buyer funding', 'escrow_fund', $3, NOW())
       ON CONFLICT (id) DO NOTHING`,
      [journalId, orderId, buyerId]
    );
    await pool.query(
      `INSERT INTO ledger_entries (id, journal_id, account_code, debit, credit, currency, description, user_id, order_id)
       VALUES ($1, $2, '2010', 120.00, 0.00, 'USD', 'Escrow debit', $3, $4)
       ON CONFLICT (id) DO NOTHING`,
      [entryId, journalId, buyerId, orderId]
    );

    const res = await request(app)
      .get(`/api/payments/user/${buyerId}`)
      .set('Authorization', `Bearer ${buyerToken}`);

    assert.strictEqual(res.status, 200, `Expected 200 OK, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.strictEqual(typeof res.body.availableBalance, 'number');
    assert.strictEqual(res.body.paidToDate, 120);
    assert.strictEqual(res.body.paidThisMonth, 120);
    assert.ok(Array.isArray(res.body.buyerOrdersSummary));
  });

  it('GET /api/proposals enriches proposals using orders.fee_breakdown->>proposalId without SQL 500 error', async () => {
    const pool = postgresStore.getPool();
    const projectId = `proj_reg_${suffix}`;
    const proposalId = `prop_reg_${suffix}`;
    const orderId = `ord_prop_reg_${suffix}`;

    await store.saveProject({
      id: projectId,
      buyerId,
      buyerName: 'Regression Buyer',
      title: 'Proposal Enrichment Regression',
      category: 'Digital Marketing & SEO',
      description: 'Regression test project description for proposal enrichment',
      budgetMin: 100,
      budgetMax: 200,
      status: 'open',
      moderationStatus: 'approved',
      createdAt: new Date().toISOString()
    } as any);

    await pool.query(
      `INSERT INTO proposals (id, project_id, freelancer_id, freelancer_name, cover_letter, bid_amount, delivery_days, created_at, status)
       VALUES ($1, $2, $3, 'Regression Freelancer', 'Cover letter', 150.00, 5, $4, 'accepted')
       ON CONFLICT (id) DO NOTHING`,
      [proposalId, projectId, freelancerId, new Date().toISOString()]
    );

    await pool.query(
      `INSERT INTO orders (id, title, buyer_id, seller_id, amount, status, created_at, due_date, fee_breakdown)
       VALUES ($1, 'Order From Proposal', $2, $3, 150.00, 'in_progress', $4, $4, $5::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [orderId, buyerId, freelancerId, new Date().toISOString().slice(0, 10), JSON.stringify({ proposalId })]
    );

    const res = await request(app)
      .get('/api/proposals')
      .set('Authorization', `Bearer ${freelancerToken}`);

    assert.strictEqual(res.status, 200, `Expected 200 OK, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.ok(Array.isArray(res.body));
    const found = res.body.find((p: any) => p.id === proposalId);
    assert.ok(found, 'Expected seeded proposal in GET /api/proposals response');
    assert.strictEqual(found.workstreamOrderId, orderId);
  });

  it('GET /api/admin/disputes handles plain-text evidence safely without JSON.parse 500 crash', async () => {
    const pool = postgresStore.getPool();
    const textDispId = `disp_txt_${suffix}`;
    const jsonDispId = `disp_json_${suffix}`;
    const d1OrderId = `ord_d1_${suffix}`;
    const d2OrderId = `ord_d2_${suffix}`;

    await store.saveOrder({
      id: d1OrderId,
      title: 'Dispute Order 1',
      buyerId,
      sellerId: freelancerId,
      amount: 50,
      status: 'disputed',
      createdAt: new Date().toISOString().slice(0, 10),
      dueDate: new Date().toISOString().slice(0, 10)
    } as any);
    await store.saveOrder({
      id: d2OrderId,
      title: 'Dispute Order 2',
      buyerId,
      sellerId: freelancerId,
      amount: 75,
      status: 'disputed',
      createdAt: new Date().toISOString().slice(0, 10),
      dueDate: new Date().toISOString().slice(0, 10)
    } as any);

    await pool.query(
      `INSERT INTO disputes (id, order_id, buyer_id, seller_id, raised_by, reason, evidence, status, created_at)
       VALUES ($1, $2, $3, $4, $3, 'Late delivery', 'Plain-text screenshot log uploaded by buyer', 'open', $5)
       ON CONFLICT (id) DO NOTHING`,
      [textDispId, d1OrderId, buyerId, freelancerId, new Date().toISOString()]
    );

    await pool.query(
      `INSERT INTO disputes (id, order_id, buyer_id, seller_id, raised_by, reason, evidence, status, created_at)
       VALUES ($1, $2, $3, $4, $3, 'Scope mismatch', '["https://example.com/proof.png"]', 'open', $5)
       ON CONFLICT (id) DO NOTHING`,
      [jsonDispId, d2OrderId, buyerId, freelancerId, new Date().toISOString()]
    );

    const res = await request(app)
      .get('/api/admin/disputes')
      .set('Authorization', `Bearer ${adminToken}`);

    assert.strictEqual(res.status, 200, `Expected 200 OK, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.ok(Array.isArray(res.body));

    const plainRow = res.body.find((d: any) => d.id === textDispId);
    const jsonRow = res.body.find((d: any) => d.id === jsonDispId);
    assert.ok(plainRow, 'Expected plain-text dispute row');
    assert.deepStrictEqual(plainRow.evidence, ['Plain-text screenshot log uploaded by buyer']);
    assert.ok(jsonRow, 'Expected JSON-array dispute row');
    assert.deepStrictEqual(jsonRow.evidence, ['https://example.com/proof.png']);
  });

  it('Stripe & Razorpay preserve stored encrypted secrets on blank submit, and Stripe creates checkout without clientId', async () => {
    const stripeSetRes = await request(app)
      .patch('/api/admin/payment-gateways/sandbox/stripe')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        enabled: true,
        clientId: '',
        clientSecret: 'sk_test_stripe_secret_5555',
        webhookId: 'whsec_stripe_9999',
        primary: false
      });

    assert.strictEqual(stripeSetRes.status, 200);
    assert.strictEqual(stripeSetRes.body.environmentGateways.stripe.enabled, true);
    assert.strictEqual(stripeSetRes.body.environmentGateways.stripe.webhookId, '••••••••9999');

    // Submitting blank strings simulates saving unrelated fields in Admin form without re-entering secrets
    const stripeBlankSaveRes = await request(app)
      .patch('/api/admin/payment-gateways/sandbox/stripe')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        enabled: true,
        clientId: '',
        clientSecret: '',
        webhookId: ''
      });

    assert.strictEqual(stripeBlankSaveRes.status, 200);
    const storedStripe = paymentGatewayManager.getGateway('stripe', 'sandbox');
    assert.strictEqual(storedStripe.clientSecret, 'sk_test_stripe_secret_5555');
    assert.strictEqual(storedStripe.webhookId, 'whsec_stripe_9999');

    // Razorpay secret preservation check
    const rzpSetRes = await request(app)
      .patch('/api/admin/payment-gateways/sandbox/razorpay')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        enabled: true,
        clientId: 'rzp_test_key_1234',
        clientSecret: 'rzp_secret_7777',
        webhookId: 'wh_rzp_4321'
      });

    assert.strictEqual(rzpSetRes.status, 200);
    const rzpBlankSaveRes = await request(app)
      .patch('/api/admin/payment-gateways/sandbox/razorpay')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        enabled: true,
        clientId: 'rzp_test_key_1234',
        clientSecret: '',
        webhookId: ''
      });

    assert.strictEqual(rzpBlankSaveRes.status, 200);
    const storedRzp = paymentGatewayManager.getGateway('razorpay', 'sandbox');
    assert.strictEqual(storedRzp.clientSecret, 'rzp_secret_7777');
    assert.strictEqual(storedRzp.webhookId, 'wh_rzp_4321');

    // Verify Stripe checkout session succeeds with empty clientId using secret key
    const origFetch = globalThis.fetch;
    let capturedAuthHeader = '';
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : input?.url || '';
      if (url.startsWith('https://api.stripe.com/v1/checkout/sessions')) {
        capturedAuthHeader = String(init?.headers?.Authorization || init?.headers?.authorization || '');
        return new Response(
          JSON.stringify({ id: 'cs_test_mock_123', url: 'https://checkout.stripe.com/c/pay/cs_test_mock_123' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return origFetch(input, init);
    }) as typeof fetch;

    try {
      const session = await paymentGatewayManager.createCheckoutSession({
        gateway: 'stripe',
        amount: 25,
        currency: 'USD',
        userId: buyerId,
        checkoutId: `chk_stripe_${suffix}`,
        env: 'sandbox'
      });
      assert.strictEqual(capturedAuthHeader, 'Bearer sk_test_stripe_secret_5555');
      assert.strictEqual(session.providerSessionId, 'cs_test_mock_123');
      assert.ok(session.checkoutUrl.includes('cs_test_mock_123'));
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('Auth lockout triggers 429 after repeated failed logins and logout/suspension revokes active JWT sessions', async () => {
    const lockUserEmail = `lock_reg_${suffix}@example.com`;
    const lockPassword = 'StrongPassword123!';
    const lockPasswordHash = await bcrypt.hash(lockPassword, 10);

    await store.saveUser({
      id: `u_lock_${suffix}`,
      name: 'Lockout User',
      email: lockUserEmail,
      role: 'buyer',
      status: 'active',
      emailVerified: true,
      password: lockPasswordHash,
      sessionVersion: 1,
      activeSessionVersions: [1],
      knownDevices: ['dev_test_lock']
    } as any);

    // 5 consecutive bad login attempts -> 401
    for (let i = 0; i < 5; i++) {
      const failRes = await request(app)
        .post('/api/auth/login')
        .set('x-device-id', 'dev_test_lock')
        .send({ email: lockUserEmail, password: 'WrongPassword!', deviceId: 'dev_test_lock' });
      assert.strictEqual(failRes.status, 401, `Attempt ${i + 1} expected 401, got ${failRes.status}`);
    }

    // 6th attempt even with correct password must be locked out with 429
    const lockedRes = await request(app)
      .post('/api/auth/login')
      .set('x-device-id', 'dev_test_lock')
      .send({ email: lockUserEmail, password: lockPassword, deviceId: 'dev_test_lock' });
    assert.strictEqual(lockedRes.status, 429);

    // Session revocation on logout & admin suspension
    const sessUserEmail = `sess_reg_${suffix}@example.com`;
    const sessPassword = 'SessionPassword123!';
    const sessUserId = `u_sess_${suffix}`;
    await store.saveUser({
      id: sessUserId,
      name: 'Session User',
      email: sessUserEmail,
      role: 'buyer',
      status: 'active',
      emailVerified: true,
      password: await bcrypt.hash(sessPassword, 10),
      sessionVersion: 1,
      activeSessionVersions: [1],
      knownDevices: ['dev_test_sess']
    } as any);

    const loginRes = await request(app)
      .post('/api/auth/login')
      .set('x-device-id', 'dev_test_sess')
      .send({ email: sessUserEmail, password: sessPassword, deviceId: 'dev_test_sess' });

    assert.strictEqual(loginRes.status, 200, `Expected login 200, got ${loginRes.status}: ${JSON.stringify(loginRes.body)}`);
    const token1 = loginRes.body.token;
    assert.ok(token1, 'Login must issue session token');

    const meBeforeLogout = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token1}`);
    assert.strictEqual(meBeforeLogout.status, 200);

    // Logout revokes token1
    const logoutRes = await request(app)
      .post('/api/auth/logout')
      .set('Authorization', `Bearer ${token1}`);
    assert.strictEqual(logoutRes.status, 200);

    const meAfterLogout = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token1}`);
    assert.strictEqual(meAfterLogout.status, 401, 'Logged-out token must be rejected with 401');

    // Re-login then suspend via admin -> must immediately revoke the new token
    const loginRes2 = await request(app)
      .post('/api/auth/login')
      .set('x-device-id', 'dev_test_sess')
      .send({ email: sessUserEmail, password: sessPassword, deviceId: 'dev_test_sess' });
    assert.strictEqual(loginRes2.status, 200);
    const token2 = loginRes2.body.token;

    const suspendRes = await request(app)
      .patch(`/api/admin/users/${sessUserId}/status`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'suspended', notes: 'Security review' });
    assert.strictEqual(suspendRes.status, 200);

    const meAfterSuspend = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token2}`);
    assert.ok(
      meAfterSuspend.status === 401 || meAfterSuspend.status === 403,
      `Suspended user token must be rejected, got ${meAfterSuspend.status}`
    );
  });

  it('Agency Mode enforces zero buyer/small-order fees, 7-day review window, and allows corporate domain sharing', async () => {
    // 1. Fee configuration endpoint must return 0% buyer processing fee and $0 small order fee
    const feesConfigRes = await request(app).get('/api/fees/config');
    assert.strictEqual(feesConfigRes.status, 200);
    assert.strictEqual(feesConfigRes.body.buyerFeePercent, 0, 'Agency mode buyerFeePercent must default to 0%');
    assert.strictEqual(feesConfigRes.body.smallOrderFee, 0, 'Agency mode smallOrderFee must default to 0');

    // 2. Quote endpoint for a $150 order: exactly $150 total (0 service fee, 0 small order fee)
    const quoteRes = await request(app).get('/api/fees/quote?amount=150');
    assert.strictEqual(quoteRes.status, 200);
    assert.strictEqual(quoteRes.body.gigPrice, 150);
    assert.strictEqual(quoteRes.body.serviceFee, 0, 'Agency quote serviceFee must be 0');
    assert.strictEqual(quoteRes.body.smallOrderFee, 0, 'Agency quote smallOrderFee must be 0');
    assert.strictEqual(quoteRes.body.clientTotal, 150, 'Agency quote clientTotal must equal gigPrice');

    const paymentQuoteRes = await request(app).get('/api/payments/quote?amount=150');
    assert.strictEqual(paymentQuoteRes.status, 200);
    assert.strictEqual(paymentQuoteRes.body.clientTotal, 150);

    // 3. Client sharing company website or email in agency mode must not trigger off-platform warning
    const dummyBuyer = { id: buyerId, role: 'user', name: 'Agency Client' } as any;
    const dummyOrder = { id: 'ord_agency_test', buyerId, sellerId: freelancerId } as any;
    const clientMsg = sanitizeAndCreateMessage(
      dummyBuyer,
      dummyOrder,
      { text: 'Please check our company site https://acmecorp.com or reach out to team@acmecorp.com' },
      { ok: true }
    );
    assert.strictEqual((clientMsg.metadata as any)?.offPlatformWarning, undefined, 'Corporate URLs/emails must not be flagged in agency mode');

    // 4. Default review window must be 7 days
    const currentSettings = siteSettings.getSettings();
    assert.strictEqual(currentSettings.marketplace.autoCompleteDeliveredDays, 7, 'Default agency review window must be 7 days');
  });
});
