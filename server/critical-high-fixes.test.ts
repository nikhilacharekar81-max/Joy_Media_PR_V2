import test from 'node:test';
import assert from 'node:assert/strict';
import { parseJsonbValue } from './routes/adminRoutes';
import { normalizeAuditTimestamp } from './services/orderService';
import {
  calculateOrderFees,
  resolveEffectiveFeePolicy,
  calculateDifferentialFees,
  DEFAULT_FEE_POLICY
} from './domains/finance/fees';
import { SITE_CONFIG } from '../src/siteConfig';
import { isProjectPublic, isUserPublic } from './publicData';

test('parseJsonbValue handles pre-parsed PostgreSQL JSONB objects, booleans, and JSON strings safely', () => {
  const obj = { heroTitle: 'Joy Media PR', enabled: true };
  assert.deepEqual(parseJsonbValue(obj, {}), obj);
  assert.deepEqual(parseJsonbValue(JSON.stringify(obj), {}), obj);
  assert.equal(parseJsonbValue(true, false), true);
  assert.equal(parseJsonbValue('true', false), true);
  assert.deepEqual(parseJsonbValue(null, { empty: true }), { empty: true });
  assert.deepEqual(parseJsonbValue('not-valid-json', { fallback: 1 }), { fallback: 1 });
});

test('normalizeAuditTimestamp converts locale and ISO strings to sortable ISO-8601 format', () => {
  const iso = '2026-05-01T12:30:00.000Z';
  assert.equal(normalizeAuditTimestamp(iso), iso);

  const localeNormalized = normalizeAuditTimestamp('5/1/2026, 12:30:00 PM');
  assert.match(localeNormalized, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

  const invalidNormalized = normalizeAuditTimestamp('not-a-date');
  assert.match(invalidNormalized, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test('Fee helpers default to Agency 0% fee policy when AGENCY_MODE is enabled', () => {
  assert.equal(SITE_CONFIG.AGENCY_MODE, true);
  assert.equal(DEFAULT_FEE_POLICY.commissionPercent, 0);
  assert.equal(DEFAULT_FEE_POLICY.buyerFeePercent, 0);
  assert.equal(DEFAULT_FEE_POLICY.smallOrderFee, 0);

  const breakdown = calculateOrderFees(100);
  assert.equal(breakdown.clientTotal, 100);
  assert.equal(breakdown.serviceFee, 0);
  assert.equal(breakdown.smallOrderFee, 0);
  assert.equal(breakdown.platformCommission, 0);
  assert.equal(breakdown.freelancerNet, 100);

  const resolved = resolveEffectiveFeePolicy({});
  assert.equal(resolved.commissionPercent, 0);
  assert.equal(resolved.buyerFeePercent, 0);

  const diff = calculateDifferentialFees(100, 150);
  assert.equal(diff.additionalClientTotal, 50);
  assert.equal(diff.additionalCommission, 0);
});

test('Agency Mode locks down public users and client project briefs', () => {
  assert.equal(SITE_CONFIG.AGENCY_MODE, true);
  assert.equal(isUserPublic({ id: 'u1', status: 'active', role: 'user' }), false);
  assert.equal(
    isProjectPublic({
      id: 'p1',
      status: 'open',
      moderationStatus: 'approved',
      title: 'Private Brief'
    } as any),
    false
  );
});
