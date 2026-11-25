export const ALL_STAFF_ROLES = [
  'super_admin',
  'admin',
  'finance_manager',
  'moderator',
  'support',
  'staff',
  'internal'
] as const;

export const ROLE_RANK: Record<string, number> = {
  super_admin: 100,
  admin: 80,
  finance_manager: 50,
  moderator: 50,
  support: 50,
  staff: 40,
  internal: 40,
  both: 10,
  freelancer: 10,
  buyer: 10,
  employer: 10,
  member: 10,
  user: 10
};

export function normalizeRoleName(role: unknown): string {
  if (typeof role !== 'string') return '';
  return role.trim().toLowerCase();
}

export function getRoleRank(role: unknown): number {
  const norm = normalizeRoleName(role);
  return ROLE_RANK[norm] ?? 0;
}

export function isStaffRole(role: unknown): boolean {
  const norm = normalizeRoleName(role);
  return (ALL_STAFF_ROLES as readonly string[]).includes(norm);
}

export function isAdminRole(role: unknown): boolean {
  const norm = normalizeRoleName(role);
  return norm === 'super_admin' || norm === 'admin';
}

export function canManageAgencyPayouts(
  user: { role?: unknown } | null | undefined,
  agencyMode = true
): boolean {
  if (!user) return false;
  if (!agencyMode) return true;
  return isStaffRole(user.role);
}

export function canManageAgencyServices(
  user: { role?: unknown } | null | undefined,
  agencyMode = true
): boolean {
  if (!user) return false;
  if (!agencyMode) return true;
  return isStaffRole(user.role);
}

export function canSubmitAgencyQuotes(
  user: { role?: unknown } | null | undefined,
  agencyMode = true
): boolean {
  if (!user) return false;
  if (!agencyMode) return true;
  return isStaffRole(user.role);
}

export function canBrowseAllProjects(
  user: { role?: unknown } | null | undefined,
  agencyMode = true
): boolean {
  if (!agencyMode) return true;
  return Boolean(user && isStaffRole(user.role));
}

export type PrivilegedUserAction =
  | 'edit'
  | 'suspend'
  | 'flag'
  | 'delete'
  | 'impersonate'
  | 'inspect_emails'
  | 'mark_email_read';

export function canActOnTargetUser(
  actor: { id?: string; role?: unknown } | null | undefined,
  target: { id?: string; role?: unknown } | null | undefined,
  action: PrivilegedUserAction
): { allowed: boolean; reason?: string } {
  if (!actor || !actor.id || !target || !target.id) {
    return { allowed: false, reason: 'Invalid actor or target user.' };
  }

  const isSelf = actor.id === target.id;
  const actorRole = normalizeRoleName(actor.role);
  const targetRole = normalizeRoleName(target.role);
  const actorRank = getRoleRank(actorRole);
  const targetRank = getRoleRank(targetRole);

  if (action === 'inspect_emails' || action === 'mark_email_read') {
    if (isSelf) return { allowed: true };
    if (!isStaffRole(actorRole)) {
      return { allowed: false, reason: 'Forbidden: Insufficient privileges.' };
    }
    if (actorRole === 'super_admin') return { allowed: true };
    if (actorRank <= targetRank) {
      return {
        allowed: false,
        reason: `Forbidden: ${actorRole} cannot access emails of a ${targetRole || 'higher-privileged'} account.`
      };
    }
    return { allowed: true };
  }

  if (action === 'delete') {
    if (targetRole === 'super_admin') {
      return { allowed: false, reason: 'Cannot delete a super_admin account.' };
    }
    if (isSelf) {
      return { allowed: false, reason: 'Forbidden: Administrators cannot delete their own account.' };
    }
    if (!isAdminRole(actorRole)) {
      return { allowed: false, reason: 'Forbidden: Administrator privileges required.' };
    }
    if (actorRole !== 'super_admin' && actorRank <= targetRank) {
      return { allowed: false, reason: 'Forbidden: Only a super_admin can delete an administrator account.' };
    }
    return { allowed: true };
  }

  if (action === 'suspend') {
    if (isSelf) {
      return { allowed: false, reason: 'Forbidden: You cannot suspend, freeze, or deactivate your own account.' };
    }
    if (!isAdminRole(actorRole)) {
      return { allowed: false, reason: 'Forbidden: Administrator privileges required.' };
    }
    if (actorRole !== 'super_admin' && actorRank <= targetRank) {
      return { allowed: false, reason: 'Forbidden: Insufficient role hierarchy to change this account status.' };
    }
    return { allowed: true };
  }

  if (action === 'flag') {
    if (isSelf) {
      return { allowed: false, reason: 'Forbidden: You cannot flag your own account.' };
    }
    if (!isAdminRole(actorRole)) {
      return { allowed: false, reason: 'Forbidden: Administrator privileges required.' };
    }
    if (actorRole !== 'super_admin' && actorRank <= targetRank) {
      return { allowed: false, reason: 'Forbidden: Insufficient role hierarchy to flag this account.' };
    }
    return { allowed: true };
  }

  if (action === 'impersonate') {
    if (isSelf) {
      return { allowed: false, reason: 'Cannot impersonate your own account.' };
    }
    if (!isAdminRole(actorRole)) {
      return { allowed: false, reason: 'Forbidden: Administrator privileges required.' };
    }
    if (actorRole !== 'super_admin' && actorRank <= targetRank) {
      return { allowed: false, reason: 'Forbidden: Administrators cannot impersonate a peer or higher-privileged account.' };
    }
    return { allowed: true };
  }

  // 'edit'
  if (isSelf) return { allowed: true };
  if (!isAdminRole(actorRole)) {
    return { allowed: false, reason: 'Forbidden: Administrator privileges required.' };
  }
  if (actorRole !== 'super_admin' && actorRank <= targetRank) {
    return { allowed: false, reason: 'Forbidden: Only super_admin can modify another administrator account.' };
  }
  return { allowed: true };
}
