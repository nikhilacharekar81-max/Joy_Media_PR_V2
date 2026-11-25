import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPublicGatewayOptions,
  computeCheckoutSplit,
  isBankLikePaymentMethod,
  isCardLikePaymentMethod,
  isSafeRedirectUrl,
  normalizePaymentMethodType,
  sanitizeCsvCell,
  sanitizeSafeReturnPath,
} from './checkoutLogic.ts';

test('computeCheckoutSplit handles direct gateway payment when useWallet is false', () => {
  const result = computeCheckoutSplit({
    orderTotal: 125.5,
    walletBalance: 500,
    useWallet: false,
  });
  assert.deepEqual(result, {
    orderTotal: 125.5,
    walletApplied: 0,
    gatewayAmount: 125.5,
    payFullyWithWallet: false,
  });
});

test('computeCheckoutSplit handles 100% wallet coverage without rounding drift', () => {
  const result = computeCheckoutSplit({
    orderTotal: 49.99,
    walletBalance: 49.99,
    useWallet: true,
  });
  assert.deepEqual(result, {
    orderTotal: 49.99,
    walletApplied: 49.99,
    gatewayAmount: 0,
    payFullyWithWallet: true,
  });
});

test('computeCheckoutSplit handles split wallet + gateway payment cleanly in integer cents', () => {
  const result = computeCheckoutSplit({
    orderTotal: 100.1,
    walletBalance: 33.4,
    useWallet: true,
  });
  assert.deepEqual(result, {
    orderTotal: 100.1,
    walletApplied: 33.4,
    gatewayAmount: 66.7,
    payFullyWithWallet: false,
  });
});

test('computeCheckoutSplit treats negative or zero wallet safely', () => {
  const result = computeCheckoutSplit({
    orderTotal: 75,
    walletBalance: -20,
    useWallet: true,
  });
  assert.deepEqual(result, {
    orderTotal: 75,
    walletApplied: 0,
    gatewayAmount: 75,
    payFullyWithWallet: false,
  });
});

test('normalizePaymentMethodType catches spaces, hyphens, and mixed casing', () => {
  assert.equal(normalizePaymentMethodType('Bank Transfer'), 'bank_transfer');
  assert.equal(normalizePaymentMethodType('wire-transfer'), 'wire_transfer');
  assert.equal(normalizePaymentMethodType('  PAYPAL '), 'paypal');
  assert.equal(normalizePaymentMethodType('Credit Card'), 'card');
  assert.equal(isBankLikePaymentMethod('Bank Transfer'), true);
  assert.equal(isBankLikePaymentMethod('Wire Transfer'), true);
  assert.equal(isCardLikePaymentMethod('Stripe'), true);
  assert.equal(isCardLikePaymentMethod('PayPal'), false);
});

test('isSafeRedirectUrl blocks javascript:, data:, and protocol-relative URLs', () => {
  assert.equal(isSafeRedirectUrl('https://www.sandbox.paypal.com/checkoutnow?token=abc'), true);
  assert.equal(isSafeRedirectUrl('/checkout/success?session_id=123'), true);
  assert.equal(isSafeRedirectUrl('javascript:alert(1)'), false);
  assert.equal(isSafeRedirectUrl('data:text/html,<script>alert(1)</script>'), false);
  assert.equal(isSafeRedirectUrl('//evil.example/phish'), false);
  assert.equal(isSafeRedirectUrl('/\\evil.example'), false);
});

test('sanitizeSafeReturnPath restricts return paths to internal relative routes', () => {
  assert.equal(sanitizeSafeReturnPath('/workstream/ord_123'), '/workstream/ord_123');
  assert.equal(sanitizeSafeReturnPath('https://evil.com/steal', '/orders'), '/orders');
  assert.equal(sanitizeSafeReturnPath('//evil.com/steal', '/orders'), '/orders');
  assert.equal(sanitizeSafeReturnPath('/bad\r\nheader', '/'), '/');
});

test('buildPublicGatewayOptions prioritizes PayPal first and respects enabled/configured flags', () => {
  const opts = buildPublicGatewayOptions({
    paypal: { enabled: true, configured: true, environment: 'sandbox' },
    stripe: { enabled: false, configured: true },
    razorpay: { enabled: true, configured: false },
  });

  assert.deepEqual(
    opts.map((o) => [o.id, o.enabled]),
    [
      ['paypal', true],
      ['stripe', false],
      ['razorpay', false],
    ]
  );

  const devOpts = buildPublicGatewayOptions(
    {
      paypal: { enabled: true, configured: false, environment: 'sandbox' },
      stripe: { enabled: true, configured: false },
      razorpay: { enabled: true, configured: false },
    },
    { allowUnconfiguredInDev: true }
  );
  assert.equal(devOpts[0].id, 'paypal');
  assert.equal(devOpts[0].enabled, true);
  assert.equal(devOpts[1].id, 'stripe');
  assert.equal(devOpts[1].enabled, true);
  assert.equal(devOpts[2].id, 'razorpay');
  assert.equal(devOpts[2].enabled, true);
});

test('sanitizeCsvCell neutralizes spreadsheet formula injection', () => {
  assert.equal(sanitizeCsvCell('=HYPERLINK("http://evil.com")'), `"'=HYPERLINK(""http://evil.com"")"`);
  assert.equal(sanitizeCsvCell('+1+2'), `"'+1+2"`);
  assert.equal(sanitizeCsvCell('-cmd'), `"'-cmd"`);
  assert.equal(sanitizeCsvCell('@SUM(A1:A2)'), `"'@SUM(A1:A2)"`);
  assert.equal(sanitizeCsvCell('Normal text'), '"Normal text"');
});
