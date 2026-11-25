import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canActOnTargetUser,
  canBrowseAllProjects,
  canManageAgencyPayouts,
  canManageAgencyServices,
  canSubmitAgencyQuotes,
  getRoleRank,
  isAdminRole,
  isStaffRole,
  normalizeRoleName
} from './rbac.js';

test('role normalization and staff checks are case-insensitive and include all staff roles', () => {
  assert.equal(normalizeRoleName('  Super_Admin '), 'super_admin');
  assert.equal(isStaffRole('MODERATOR'), true);
  assert.equal(isStaffRole('finance_manager'), true);
  assert.equal(isStaffRole('support'), true);
  assert.equal(isStaffRole('staff'), true);
  assert.equal(isStaffRole('internal'), true);
  assert.equal(isStaffRole('admin'), true);
  assert.equal(isStaffRole('super_admin'), true);
  assert.equal(isStaffRole('buyer'), false);
  assert.equal(isStaffRole('user'), false);
  assert.equal(isStaffRole('freelancer'), false);
  assert.equal(isAdminRole('ADMIN'), true);
  assert.equal(isAdminRole('support'), false);
  assert.ok(getRoleRank('super_admin') > getRoleRank('admin'));
  assert.ok(getRoleRank('admin') > getRoleRank('finance_manager'));
  assert.ok(getRoleRank('moderator') > getRoleRank('user'));
});

test('agency mode locks payouts, service management, quote submission, and all-project browsing to admin & staff only', () => {
  const staffRoles = ['super_admin', 'admin', 'finance_manager', 'moderator', 'support', 'staff', 'internal'];
  const clientRoles = ['buyer', 'user', 'freelancer', 'both', 'member', ''];

  for (const role of staffRoles) {
    const actor = { role };
    assert.equal(canManageAgencyPayouts(actor, true), true, `${role} should manage payouts`);
    assert.equal(canManageAgencyServices(actor, true), true, `${role} should manage services`);
    assert.equal(canSubmitAgencyQuotes(actor, true), true, `${role} should submit quotes`);
    assert.equal(canBrowseAllProjects(actor, true), true, `${role} should browse all projects`);
  }

  for (const role of clientRoles) {
    const actor = { role };
    assert.equal(canManageAgencyPayouts(actor, true), false, `${role || 'empty'} must NOT manage payouts`);
    assert.equal(canManageAgencyServices(actor, true), false, `${role || 'empty'} must NOT manage services`);
    assert.equal(canSubmitAgencyQuotes(actor, true), false, `${role || 'empty'} must NOT submit quotes`);
    assert.equal(canBrowseAllProjects(actor, true), false, `${role || 'empty'} must NOT browse all projects`);

    // When agencyMode is disabled (legacy marketplace mode), authenticated users are permitted
    assert.equal(canManageAgencyPayouts(actor, false), true);
    assert.equal(canManageAgencyServices(actor, false), true);
    assert.equal(canSubmitAgencyQuotes(actor, false), true);
    assert.equal(canBrowseAllProjects(actor, false), true);
  }

  // Unauthenticated guests are always denied
  assert.equal(canManageAgencyPayouts(null, true), false);
  assert.equal(canManageAgencyServices(undefined, true), false);
  assert.equal(canSubmitAgencyQuotes(null, true), false);
  assert.equal(canBrowseAllProjects(null, true), false);
});

test('regular admin cannot flag, suspend, delete, impersonate, or edit super_admin or peer admin', () => {
  const admin = { id: 'adm1', role: 'admin' };
  const peerAdmin = { id: 'adm2', role: 'admin' };
  const owner = { id: 'owner1', role: 'super_admin' };
  const client = { id: 'cli1', role: 'buyer' };

  for (const action of ['flag', 'suspend', 'delete', 'impersonate', 'edit'] as const) {
    assert.equal(canActOnTargetUser(admin, owner, action).allowed, false, `admin should not ${action} super_admin`);
    assert.equal(canActOnTargetUser(admin, peerAdmin, action).allowed, false, `admin should not ${action} peer admin`);
    assert.equal(canActOnTargetUser(admin, client, action).allowed, true, `admin should be able to ${action} client`);
  }
});

test('admins and super_admins cannot self-delete, self-suspend, or delete any super_admin', () => {
  const owner = { id: 'owner1', role: 'super_admin' };
  const owner2 = { id: 'owner2', role: 'super_admin' };
  const admin = { id: 'adm1', role: 'admin' };

  assert.equal(canActOnTargetUser(owner, owner, 'delete').allowed, false);
  assert.equal(canActOnTargetUser(owner, owner, 'suspend').allowed, false);
  assert.equal(canActOnTargetUser(owner, owner2, 'delete').allowed, false);
  assert.equal(canActOnTargetUser(admin, admin, 'delete').allowed, false);
  assert.equal(canActOnTargetUser(admin, admin, 'suspend').allowed, false);
  assert.equal(canActOnTargetUser(owner, admin, 'delete').allowed, true);
  assert.equal(canActOnTargetUser(owner, admin, 'suspend').allowed, true);
});

test('email inspection and mark-read enforces strict staff hierarchy', () => {
  const support = { id: 'sup1', role: 'support' };
  const owner = { id: 'owner1', role: 'super_admin' };
  const admin = { id: 'adm1', role: 'admin' };
  const client = { id: 'cli1', role: 'user' };

  assert.equal(canActOnTargetUser(support, owner, 'inspect_emails').allowed, false);
  assert.equal(canActOnTargetUser(support, owner, 'mark_email_read').allowed, false);
  assert.equal(canActOnTargetUser(support, admin, 'mark_email_read').allowed, false);
  assert.equal(canActOnTargetUser(support, client, 'mark_email_read').allowed, true);
  assert.equal(canActOnTargetUser(client, client, 'mark_email_read').allowed, true);
  assert.equal(canActOnTargetUser(client, owner, 'mark_email_read').allowed, false);
});
