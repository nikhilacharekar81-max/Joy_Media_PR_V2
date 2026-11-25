import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import bcrypt from 'bcryptjs';
import { store } from '../store.js';
import { postgresStore, isPostgresEnabled } from '../db/postgresStore.js';
import { isUserPublic, sanitizePublicUser } from '../publicData.js';
import {
  requireAuth,
  requireActiveStatus,
  requireAdmin,
  adminActor,
  safeUser,
  isStaffUser,
  ASSIGNABLE_USER_ROLES,
  normalizeUserRole,
  signToken,
  resolveAuthenticatedUserId,
  MAX_ACTIVE_SESSIONS,
  revokeAllUserSessionsAtomic,
  rateLimit
} from '../middleware/auth.js';
import { siteSettings } from '../../src/server/siteSettings.js';
import { registerAuditLog } from '../services/orderService.js';
import { disconnectUserSockets } from '../websocket.js';
import { deliverSecurityCode } from '../services/notificationService.js';
import { generate6DigitCode, emailVerificationCodes, isValidEmail } from '../services/authService.js';
import { shouldExposeMockCodes } from '../services/mockCodeHelper.js';
import { canActOnTargetUser } from '../domains/identity/rbac.js';
import { financialRepository } from '../domains/finance/financial.service.js';
import { RESERVED_ROUTES } from '../../src/shared/routes.js';

export const userRouter = Router();

const MAX_INLINE_IMAGE_DATA_URL_BYTES = 1_500_000; // ~1.1MB binary image max in DB
const SAFE_IMAGE_URL_REGEX = /^(\/(?!\/)|https?:\/\/|data:image\/(?:png|jpe?g|webp|gif);base64,)/i;
function isSafeImageUrl(val: unknown): boolean {
  if (typeof val !== 'string') return false;
  const trimmed = val.trim();
  if (!trimmed) return true;
  if (/^\s*(javascript:|vbscript:|blob:|data:image\/svg\+xml)/i.test(trimmed)) return false;
  if (!SAFE_IMAGE_URL_REGEX.test(trimmed)) return false;
  if (trimmed.toLowerCase().startsWith('data:image/') && trimmed.length > MAX_INLINE_IMAGE_DATA_URL_BYTES) {
    return false;
  }
  return true;
}

// Public users list (returns full safeUser list for staff/admin callers)
userRouter.get('/users', async (req: Request, res: Response) => {
  try {
    const callerId = (req as any).authenticatedUserId;
    const caller = (req as any).authenticatedUser || (callerId ? await store.getUser(callerId) : null);
    if (isStaffUser(caller)) {
      const allUsers = await store.listUsers();
      return res.json(allUsers.map(safeUser));
    }
    const publicUsers = await store.listPublicUsers();
    res.json(publicUsers.map(sanitizePublicUser));
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to list users' });
  }
});

// Update authenticated user profile
userRouter.patch('/users/profile', requireAuth, requireActiveStatus, async (req: Request, res: Response) => {
  try {
    const authUserId = (req as any).authenticatedUserId;
    const user = await store.getUser(authUserId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const {
      name,
      title,
      tagline,
      bio,
      location,
      hourlyRate,
      skills,
      languages,
      education,
      portfolio,
      avatar,
      coverUrl,
      isAvailableNow,
      username
    } = req.body || {};

    if (typeof avatar === 'string' && avatar.trim() && !isSafeImageUrl(avatar)) {
      return res.status(400).json({ error: 'Invalid avatar URL. Please upload a PNG, JPG, WebP, or GIF image or provide an https:// URL.' });
    }
    if (typeof coverUrl === 'string' && coverUrl.trim() && !isSafeImageUrl(coverUrl)) {
      return res.status(400).json({ error: 'Invalid cover image URL. Please upload a PNG, JPG, WebP, or GIF image or provide an https:// URL.' });
    }
    if (Array.isArray(portfolio)) {
      for (const item of portfolio) {
        const imgUrl = item?.image || item?.imageUrl || item?.url;
        if (typeof imgUrl === 'string' && imgUrl.trim() && !isSafeImageUrl(imgUrl)) {
          return res.status(400).json({ error: 'Portfolio items must use safe image URLs.' });
        }
      }
    }

    if (typeof name === 'string' && name.trim()) {
      user.name = name.trim().slice(0, 80);
    }
    if (typeof title === 'string') {
      user.title = title.trim().slice(0, 120);
    }
    if (typeof tagline === 'string') {
      (user as any).tagline = tagline.trim().slice(0, 200);
    }
    if (typeof bio === 'string') {
      user.bio = bio.trim();
    }
    if (typeof location === 'string') {
      user.location = location.trim().slice(0, 120);
    }
    if (typeof hourlyRate === 'number' && Number.isFinite(hourlyRate) && hourlyRate >= 0) {
      user.hourlyRate = hourlyRate;
    } else if (typeof hourlyRate === 'string' && hourlyRate.trim() !== '') {
      const parsedRate = Number(hourlyRate);
      if (Number.isFinite(parsedRate) && parsedRate >= 0) user.hourlyRate = parsedRate;
    }
    if (Array.isArray(skills)) {
      user.skills = skills.map((s: any) => String(s).trim()).filter(Boolean);
    } else if (typeof skills === 'string') {
      user.skills = skills.split(',').map(s => s.trim()).filter(Boolean);
    }
    if (Array.isArray(languages)) {
      user.languages = languages.map((l: any) => String(l).trim()).filter(Boolean);
    } else if (typeof languages === 'string') {
      user.languages = languages.split(',').map(l => l.trim()).filter(Boolean);
    }
    if (Array.isArray(education)) {
      (user as any).education = education;
    }
    if (Array.isArray(portfolio)) {
      (user as any).portfolio = portfolio;
    }
    if (typeof avatar === 'string' && avatar.trim()) {
      user.avatar = avatar.trim();
    }
    if (typeof coverUrl === 'string' && coverUrl.trim()) {
      (user as any).coverUrl = coverUrl.trim();
    }
    if (typeof isAvailableNow === 'boolean') {
      user.isAvailableNow = isAvailableNow;
    }
    if (typeof username === 'string' && username.trim() && username.trim().toLowerCase() !== user.username?.toLowerCase()) {
      const cleanUsername = username.trim().toLowerCase().replace(/[^a-z0-9_.-]/g, '');
      if (cleanUsername.length < 3 || cleanUsername.length > 30) {
        return res.status(400).json({ error: 'Username must be between 3 and 30 characters.' });
      }
      if (RESERVED_ROUTES.includes(cleanUsername)) {
        return res.status(400).json({ error: 'This username is reserved and cannot be used.' });
      }
      const existing = await store.getUserByUsername(cleanUsername);
      if (existing && existing.id !== user.id) {
        return res.status(409).json({ error: 'Username is already taken.' });
      }
      user.username = cleanUsername;
    }

    await store.saveUser(user);

    if (isPostgresEnabled()) {
      await postgresStore.getPool().query(
        `UPDATE gigs SET 
          freelancer_name = $1, 
          freelancer_username = $2, 
          freelancer_avatar = $3 
         WHERE freelancer_id = $4`,
        [user.name, user.username || null, user.avatar || null, user.id]
      );
    }

    res.json({ success: true, user: safeUser(user) });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to update profile' });
  }
});

// Request email address change (verifies syntax + password, sends OTP to new address before committing)
userRouter.patch('/users/email', requireAuth, requireActiveStatus, rateLimit(5, 3_600_000, 'user_email_change'), async (req: Request, res: Response) => {
  try {
    const authUserId = (req as any).authenticatedUserId;
    const user = await store.getUser(authUserId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const { email, currentPassword } = req.body || {};
    if (typeof email !== 'string' || !email.trim()) {
      return res.status(400).json({ error: 'Email is required.' });
    }
    const normalizedEmail = email.trim().toLowerCase();
    if (!isValidEmail(normalizedEmail)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }
    if (normalizedEmail === user.email.toLowerCase()) {
      return res.json({ success: true, user: safeUser(user), message: 'Email is unchanged.' });
    }

    if (!currentPassword || typeof currentPassword !== 'string') {
      return res.status(401).json({ error: 'Current password is required to change your email address.' });
    }
    if (!user.password) {
      return res.status(403).json({ error: 'Password authentication is required to change email. Please set a password first via Forgot Password.' });
    }
    const match = await bcrypt.compare(String(currentPassword), user.password);
    if (!match) {
      return res.status(401).json({ error: 'Current password does not match.' });
    }

    const existing = await store.getUserByEmail(normalizedEmail);
    if (existing && existing.id !== user.id) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }

    const verificationCode = generate6DigitCode();
    const expiresAtMs = Date.now() + 30 * 60 * 1000;
    const pendingKey = `email_change:${user.id}:${normalizedEmail}`;

    if (isPostgresEnabled()) {
      await postgresStore.getPool().query(
        `DELETE FROM auth_verification_codes WHERE email LIKE $1 AND type = 'email_change'`,
        [`email_change:${user.id}:%`]
      );
      await postgresStore.getPool().query(
        `INSERT INTO auth_verification_codes (email, code, type, attempts, last_resend_at, expires_at, created_at)
         VALUES ($1, $2, 'email_change', 0, $3, $4, NOW())
         ON CONFLICT (email, type) DO UPDATE SET code = $2, attempts = 0, last_resend_at = $3, expires_at = $4, created_at = NOW()`,
        [pendingKey, verificationCode, Date.now(), new Date(expiresAtMs)]
      );
    } else {
      emailVerificationCodes.set(pendingKey, {
        code: verificationCode,
        expiresAt: expiresAtMs,
        lastResendAt: Date.now(),
        attempts: 0
      });
    }

    deliverSecurityCode(normalizedEmail, 'EMAIL_VERIFICATION', verificationCode);

    res.json({
      success: true,
      pendingVerification: true,
      pendingEmail: normalizedEmail,
      message: `A 6-digit verification code has been sent to ${normalizedEmail}. Confirm the code to complete your email change.`,
      user: safeUser(user),
      ...(shouldExposeMockCodes() ? { mockCode: verificationCode } : {})
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to initiate email update' });
  }
});

// Confirm pending email change via OTP sent to the new address
userRouter.post('/users/email/confirm', requireAuth, requireActiveStatus, rateLimit(10, 3_600_000, 'user_email_confirm'), async (req: Request, res: Response) => {
  try {
    const authUserId = (req as any).authenticatedUserId;
    const user = await store.getUser(authUserId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const { email, code } = req.body || {};
    if (typeof email !== 'string' || !email.trim() || !code || String(code).trim() === '') {
      return res.status(400).json({ error: 'New email and 6-digit verification code are required.' });
    }
    const normalizedEmail = email.trim().toLowerCase();
    if (!isValidEmail(normalizedEmail)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }
    const trimmedCode = String(code).trim();
    const pendingKey = `email_change:${user.id}:${normalizedEmail}`;

    if (isPostgresEnabled()) {
      const checkErr = await postgresStore.executeInTransaction(async (client) => {
        const resRow = await client.query(
          `SELECT * FROM auth_verification_codes WHERE email = $1 AND type = 'email_change' FOR UPDATE`,
          [pendingKey]
        );
        if (resRow.rows.length === 0) {
          return { status: 400, error: 'No pending email change found for this address. Please request a new code.' };
        }
        const row = resRow.rows[0];
        if (new Date() > new Date(row.expires_at)) {
          await client.query(`DELETE FROM auth_verification_codes WHERE email = $1 AND type = 'email_change'`, [pendingKey]);
          return { status: 400, error: 'Verification code has expired. Please request a new email change.' };
        }
        if (Number(row.attempts || 0) >= 5) {
          await client.query(`DELETE FROM auth_verification_codes WHERE email = $1 AND type = 'email_change'`, [pendingKey]);
          return { status: 429, error: 'Too many failed attempts. Please request a new email change.' };
        }
        if (row.code !== trimmedCode) {
          const upd = await client.query(
            `UPDATE auth_verification_codes SET attempts = attempts + 1 WHERE email = $1 AND type = 'email_change' RETURNING attempts`,
            [pendingKey]
          );
          if (Number(upd.rows[0]?.attempts || 0) >= 5) {
            await client.query(`DELETE FROM auth_verification_codes WHERE email = $1 AND type = 'email_change'`, [pendingKey]);
            return { status: 429, error: 'Too many failed attempts. Please request a new email change.' };
          }
          return { status: 400, error: 'Invalid verification code.' };
        }
        const conflict = await client.query(
          'SELECT id FROM users WHERE LOWER(email) = LOWER($1) AND id <> $2 LIMIT 1',
          [normalizedEmail, user.id]
        );
        if (conflict.rows.length > 0) {
          return { status: 409, error: 'An account with this email already exists.' };
        }
        await client.query(`DELETE FROM auth_verification_codes WHERE email = $1 AND type = 'email_change'`, [pendingKey]);
        return null;
      });
      if (checkErr) {
        return res.status(checkErr.status).json({ error: checkErr.error });
      }
    } else {
      const record = emailVerificationCodes.get(pendingKey);
      if (!record || Date.now() > record.expiresAt) {
        emailVerificationCodes.delete(pendingKey);
        return res.status(400).json({ error: 'Verification code expired or not found.' });
      }
      if (record.code !== trimmedCode) {
        record.attempts += 1;
        return res.status(400).json({ error: 'Invalid verification code.' });
      }
      emailVerificationCodes.delete(pendingKey);
    }

    user.email = normalizedEmail;
    user.emailVerified = true;
    await store.saveUser(user);
    const newVersion = await revokeAllUserSessionsAtomic(user, 'Email changed', true);
    const newToken = signToken({
      id: user.id,
      role: user.role,
      email: user.email,
      sessionVersion: newVersion
    });

    res.setHeader('x-auth-token', newToken);
    res.json({
      success: true,
      message: 'Email address verified and updated successfully.',
      token: newToken,
      user: safeUser(user)
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to confirm email change' });
  }
});

userRouter.get('/users/notification-preferences', requireAuth, async (req: Request, res: Response) => {
  const authUserId = (req as any).authenticatedUserId;
  const user = await store.getUser(authUserId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const prefs = user.notificationPreferences || {};
  res.json({
    emailNotifications: prefs.emailNotifications || 'Instant alerts for all messages',
    smsNotifications: prefs.smsNotifications || (user.mobile ? `Enabled (${user.mobile})` : 'Disabled'),
    marketingNotifs: prefs.marketingNotifs || 'Subscribed',
    mobile: user.mobile || null
  });
});

userRouter.patch('/users/notification-preferences', requireAuth, requireActiveStatus, async (req: Request, res: Response) => {
  const authUserId = (req as any).authenticatedUserId;
  const user = await store.getUser(authUserId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const { emailNotifications, smsNotifications, marketingNotifs } = req.body || {};

  if (!user.notificationPreferences) {
    user.notificationPreferences = {};
  }

  if (typeof emailNotifications === 'string') {
    user.notificationPreferences.emailNotifications = emailNotifications;
  }
  if (typeof smsNotifications === 'string') {
    user.notificationPreferences.smsNotifications = smsNotifications;
  }
  if (typeof marketingNotifs === 'string') {
    user.notificationPreferences.marketingNotifs = marketingNotifs;
  }

  await store.saveUser(user);
  res.json({
    success: true,
    notificationPreferences: user.notificationPreferences
  });
});

userRouter.patch('/users/availability', requireAuth, requireActiveStatus, async (req: Request, res: Response) => {
  const userId = (req as any).authenticatedUserId;
  const { isAvailableNow } = req.body;
  const user = await store.getUser(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  user.isAvailableNow = !!isAvailableNow;
  await store.saveUser(user);
  res.json({ success: true, user: safeUser(user) });
});

// Get user profile by ID
userRouter.get('/users/:id', async (req: Request, res: Response) => {
  try {
    const user = await store.getUser(req.params.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    const callerId = resolveAuthenticatedUserId(req) || (req as any).authenticatedUserId;
    const caller = (req as any).authenticatedUser || (callerId ? await store.getUser(callerId) : null);
    const isStaff = isStaffUser(caller);
    if (callerId === user.id || isStaff) {
      return res.json(safeUser(user));
    }
    if (!isUserPublic(user)) {
      return res.status(404).json({ error: 'User not found' });
    }
    return res.json(sanitizePublicUser(user));
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to fetch user' });
  }
});

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

// Update User (including password update with currentPassword check)
const handleUserUpdate = async (req: Request, res: Response) => {
  try {
    const userId = req.params.id;
    const targetUser = await store.getUser(userId);
    if (!targetUser) return res.status(404).json({ error: 'User not found' });

    const authUserId = resolveAuthenticatedUserId(req) || (req as any).authenticatedUserId;
    const caller = (req as any).authenticatedUser || (authUserId ? await store.getUser(authUserId) : null);
    if (!caller) return res.status(401).json({ error: 'Authentication required' });

    const isSuperAdminUser = String(caller.role || '').toLowerCase() === 'super_admin';
    const isFullAdmin = String(caller.role || '').toLowerCase() === 'admin' || isSuperAdminUser;

    if (caller.id !== targetUser.id) {
      const check = canActOnTargetUser(caller, targetUser, 'edit');
      if (!check.allowed) {
        return res.status(403).json({ error: check.reason || 'Forbidden: You can only edit your own account.' });
      }
    }

    if (req.body.role !== undefined && targetUser.role !== req.body.role) {
      if (!isFullAdmin) {
        return res.status(403).json({ error: 'Forbidden: Only administrators can modify roles.' });
      }
      const normalizedRole = normalizeUserRole(req.body.role);
      if (!normalizedRole) {
        return res.status(400).json({ error: `Invalid role "${req.body.role}". Allowed roles: ${ASSIGNABLE_USER_ROLES.join(', ')}` });
      }
      if ((targetUser.role === 'super_admin' || normalizedRole === 'super_admin') && !isSuperAdminUser) {
        return res.status(403).json({ error: 'Forbidden: Only super_admin can grant or revoke super_admin role.' });
      }
      targetUser.role = normalizedRole as any;
    }

    let newToken: string | undefined;

    if (req.body.password) {
      if (caller.id !== targetUser.id) {
        if (!isFullAdmin) {
          return res.status(403).json({ error: 'Forbidden: You cannot modify another user password.' });
        }
        if (targetUser.role === 'super_admin' && !isSuperAdminUser) {
          return res.status(403).json({ error: 'Forbidden: Only super_admin can reset password of a super_admin.' });
        }
      } else {
        const currentPassword = req.body.currentPassword;
        if (!currentPassword) {
          return res.status(400).json({ error: 'Current password is required to change password' });
        }
        const pool = postgresStore.getPool();
        const userRowRes = await pool.query("SELECT password, password_hash FROM users WHERE id = $1", [targetUser.id]);
        const currentHash = userRowRes.rows[0]?.password || userRowRes.rows[0]?.password_hash || (targetUser as any).password;
        const matches = currentHash && (await verifyPassword(currentPassword, currentHash));
        if (!matches) {
          return res.status(400).json({ error: 'Current password does not match' });
        }
      }

      const newPassword = String(req.body.password);
      if (newPassword.length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters long.' });
      }
      const hashed = await bcrypt.hash(newPassword, 10);
      targetUser.password = hashed;
      const pool = postgresStore.getPool();

      // Session invalidation & WebSocket disconnect (advance past MAX_ACTIVE_SESSIONS window)
      const newVersion = (Number(targetUser.sessionVersion) || 1) + MAX_ACTIVE_SESSIONS;
      targetUser.sessionVersion = newVersion;
      if (caller.id === targetUser.id) {
        targetUser.activeSessionVersions = [newVersion];
        newToken = signToken({
          id: targetUser.id,
          role: targetUser.role,
          email: targetUser.email,
          sessionVersion: newVersion
        });
      } else {
        targetUser.activeSessionVersions = [];
      }

      await pool.query(
        "UPDATE users SET password = $1, password_hash = $1, session_version = $2 WHERE id = $3",
        [hashed, newVersion, targetUser.id]
      );

      disconnectUserSockets(targetUser.id, 'Password changed');
    }

    if (typeof req.body.name === 'string' && req.body.name.trim()) {
      targetUser.name = req.body.name.trim().slice(0, 80);
    }
    if (typeof req.body.title === 'string') {
      targetUser.title = req.body.title.trim().slice(0, 120);
    }
    if (typeof req.body.bio === 'string') {
      targetUser.bio = req.body.bio.trim();
    }
    if (typeof req.body.avatar === 'string' && req.body.avatar.trim()) {
      if (!isSafeImageUrl(req.body.avatar)) {
        return res.status(400).json({ error: 'Invalid avatar URL.' });
      }
      targetUser.avatar = req.body.avatar.trim();
    }

    await store.saveUser(targetUser);

    if (isPostgresEnabled() && (req.body.name !== undefined || req.body.avatar !== undefined || req.body.username !== undefined)) {
      await postgresStore.getPool().query(
        `UPDATE gigs SET 
          freelancer_name = $1, 
          freelancer_username = $2, 
          freelancer_avatar = $3 
         WHERE freelancer_id = $4`,
        [targetUser.name, targetUser.username || null, targetUser.avatar || null, targetUser.id]
      );
    }

    const safeResult: any = safeUser(targetUser);
    if (newToken) {
      safeResult.token = newToken;
      res.setHeader('x-auth-token', newToken);
    }
    res.json(safeResult);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to update user' });
  }
};

userRouter.put('/users/:id', requireAuth, requireActiveStatus, handleUserUpdate);
userRouter.patch('/users/:id', requireAuth, requireActiveStatus, handleUserUpdate);

userRouter.delete('/users/:id', requireAdmin, async (req: Request, res: Response) => {
  const { handleDeleteUserAccount } = await import('./adminRoutes.js');
  return handleDeleteUserAccount(req, res);
});

userRouter.post('/users/:id/flag', requireAdmin, async (req: Request, res: Response) => {
  const caller = (req as any).authenticatedUser;
  const user = await store.getUser(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const flagCheck = canActOnTargetUser(caller, user, 'flag');
  if (!flagCheck.allowed) {
    return res.status(403).json({ error: flagCheck.reason || 'Forbidden: Insufficient role hierarchy to flag this account.' });
  }

  user.isFlagged = !user.isFlagged;
  user.flagReason = user.isFlagged ? (req.body.reason || 'Flagged for TOS investigation.') : undefined;
  await store.saveUser(user);

  await registerAuditLog({
    id: 'log_' + Date.now() + '_' + randomUUID().slice(0, 8),
    actor: adminActor(req),
    role: caller?.role || 'admin',
    action: user.isFlagged ? 'USER_FLAGGED_TOS' : 'USER_UNFLAGGED_TOS',
    target: `User #${user.id} (${user.name})`,
    details: user.flagReason || 'Flag removed',
    timestamp: new Date().toISOString()
  });

  res.json({ success: true, isFlagged: user.isFlagged, flagReason: user.flagReason });
});

userRouter.get('/user/quota-status', requireAuth, async (req: Request, res: Response) => {
  try {
    const authUserId = (req as any).authenticatedUserId;
    const user = await store.getUser(authUserId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const activeSettings = siteSettings.getSettings();
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const [bidsRes, jobPostsRes] = await Promise.all([
      postgresStore.getPool().query(
        'SELECT count(*) FROM proposals WHERE freelancer_id = $1 AND SUBSTRING(created_at FROM 1 FOR 10) >= $2',
        [user.id, thirtyDaysAgo]
      ),
      postgresStore.getPool().query(
        'SELECT count(*) FROM projects WHERE buyer_id = $1 AND SUBSTRING(created_at FROM 1 FOR 10) >= $2',
        [user.id, thirtyDaysAgo]
      )
    ]);

    const bidsUsed = parseInt(bidsRes.rows[0]?.count || '0', 10);
    const jobPostsUsed = parseInt(jobPostsRes.rows[0]?.count || '0', 10);

    const freelancerPlanId = (user as any).membershipTier || 'plan_free';
    const freelancerPlan = activeSettings.memberships.freelancerPlans.find(p => p.id === freelancerPlanId) || activeSettings.memberships.freelancerPlans[0];

    const buyerPlanId = (user as any).buyerMembershipTier || 'buyer_free';
    const buyerPlan = activeSettings.memberships.buyerPlans.find(p => p.id === buyerPlanId) || activeSettings.memberships.buyerPlans[0];

    const rawBidsLimit = freelancerPlan?.bidsPerMonth ?? 0;
    const bidsLimit = rawBidsLimit > 0 ? rawBidsLimit : null;
    const bidsRemaining = bidsLimit !== null ? Math.max(0, bidsLimit - bidsUsed) : null;

    const rawJobPostsLimit = buyerPlan?.jobPostsPerMonth ?? 0;
    const jobPostsLimit = rawJobPostsLimit > 0 ? rawJobPostsLimit : null;
    const jobPostsRemaining = jobPostsLimit !== null ? Math.max(0, jobPostsLimit - jobPostsUsed) : null;

    res.json({
      success: true,
      membershipsEnabled: activeSettings.memberships.membershipsEnabled,
      freelancer: {
        planId: freelancerPlanId,
        planName: freelancerPlan?.name || 'Standard Freelancer',
        bidsUsed,
        bidsLimit,
        bidsRemaining,
        unlimited: bidsLimit === null
      },
      buyer: {
        planId: buyerPlanId,
        planName: buyerPlan?.name || 'Standard Client',
        jobPostsUsed,
        jobPostsLimit,
        jobPostsRemaining,
        unlimited: jobPostsLimit === null
      }
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

userRouter.post('/user/membership', requireAuth, requireActiveStatus, async (req: Request, res: Response) => {
  try {
    const authUserId = (req as any).authenticatedUserId;
    const user = await store.getUser(authUserId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const activeSettings = siteSettings.getSettings();
    const { freelancerPlanId, buyerPlanId } = req.body || {};
    if (freelancerPlanId) {
      const plan = activeSettings.memberships.freelancerPlans.find(p => p.id === freelancerPlanId);
      if (!plan || !plan.enabled) {
        return res.status(400).json({ error: 'Invalid or disabled membership plan.' });
      }
      if (plan.priceMonthly > 0) {
        return res.status(402).json({ error: 'Paid plans require checkout' });
      }
      (user as any).membershipTier = freelancerPlanId;
    }
    if (buyerPlanId) {
      const plan = activeSettings.memberships.buyerPlans.find(p => p.id === buyerPlanId);
      if (!plan || !plan.enabled) {
        return res.status(400).json({ error: 'Invalid or disabled buyer plan.' });
      }
      if (plan.priceMonthly > 0) {
        return res.status(402).json({ error: 'Paid plans require checkout' });
      }
      (user as any).buyerMembershipTier = buyerPlanId;
    }
    await store.saveUser(user);
    res.json({ success: true, user: safeUser(user) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

userRouter.get('/user-emails/:userId', requireAuth, async (req: Request, res: Response) => {
  try {
    const caller = (req as any).authenticatedUser;
    const targetUser = await store.getUser(req.params.userId);
    if (!targetUser) return res.status(404).json({ error: 'User not found' });

    const check = canActOnTargetUser(caller, targetUser, 'inspect_emails');
    if (!check.allowed) {
      return res.status(403).json({ error: check.reason || 'Forbidden: Insufficient privileges.' });
    }

    const userList = await store.listUserEmailsForUser(req.params.userId);
    res.json(userList);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to list user emails' });
  }
});

userRouter.patch('/user-emails/:id/read', requireAuth, requireActiveStatus, async (req: Request, res: Response) => {
  try {
    const caller = (req as any).authenticatedUser;
    const callerId = (req as any).authenticatedUserId;
    const isStaff = isStaffUser(caller);

    if (isPostgresEnabled()) {
      const emRes = await postgresStore.getPool().query(
        'SELECT user_id FROM user_emails WHERE id = $1 LIMIT 1',
        [req.params.id]
      );
      if (emRes.rows.length === 0) {
        return res.status(404).json({ error: 'Email record not found.' });
      }
      const ownerId = emRes.rows[0].user_id;
      if (ownerId && ownerId !== callerId) {
        const targetUser = await store.getUser(ownerId);
        const check = canActOnTargetUser(caller, targetUser || { id: ownerId, role: 'user' }, 'mark_email_read');
        if (!check.allowed) {
          return res.status(403).json({ error: check.reason || 'Forbidden: Insufficient privileges.' });
        }
      }
      await store.markUserEmailRead(req.params.id, ownerId || callerId);
      return res.json({ success: true });
    }

    await store.markUserEmailRead(req.params.id, isStaff ? undefined : callerId);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to mark email read' });
  }
});
