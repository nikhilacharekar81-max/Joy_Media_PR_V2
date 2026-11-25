import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import { store, type User } from '../store.js';
import { postgresStore, isPostgresEnabled } from '../db/postgresStore.js';
import {
  rateLimit,
  requireAuth,
  requireActiveStatus,
  requireFinancialActiveStatus,
  resolveAuthenticatedUserId,
  resolveJwtSecret,
  safeUser,
  signToken,
  registerNewUserSession,
  registerNewUserSessionAtomic,
  revokeAllUserSessionsAtomic,
  MAX_ACTIVE_SESSIONS,
  IS_PRODUCTION,
  isStaffUser,
  apiError
} from '../middleware/auth.js';
import { disconnectUserSockets } from '../websocket.js';
import {
  deliverSecurityCode,
  deliverAdminCode,
  recordUserEmail,
  EMAIL_DELIVERY_ENABLED
} from '../services/notificationService.js';
import { shouldExposeMockCodes } from '../services/mockCodeHelper.js';
import {
  emailVerificationCodes,
  smsVerificationCodes,
  forgotPasswordCodes,
  withdrawalVerificationCodes,
   WITHDRAWAL_MAX_ATTEMPTS,
  WITHDRAWAL_COOLDOWN_MS,
  generate6DigitCode,
  isValidEmail,
  isValidMobile,
  checkRecoveryCode,
  handleLogin
} from '../services/authService.js';
import { handlePayoutRequest } from '../services/payoutService.js';
import { ensureWallet } from '../services/orderService.js';
import { canManageAgencyPayouts } from '../domains/identity/rbac.js';
import { siteSettings } from '../domains/admin/siteSettings.js';
import { SITE_CONFIG } from '../../src/siteConfig.js';

export const authRouter = Router();

const isTestEnv = process.env.NODE_ENV === 'test';

// 1. Signup Endpoint
authRouter.post('/signup', rateLimit(20, 3_600_000), async (req: Request, res: Response) => {
  try {
    const secSettings = siteSettings.getSettings().security;
    if (secSettings && secSettings.allowNewRegistrations === false) {
      return res.status(403).json({ error: 'New user registrations are currently disabled by platform administration.' });
    }

    const { email, password, confirmPassword, mobile, name } = req.body || {};
    if (typeof email !== 'string' || typeof password !== 'string' || !email.trim() || !password) {
      return apiError(res, 'Email and password are required.');
    }
    if (password !== confirmPassword) {
      return res.status(400).json({ error: 'Passwords do not match.' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters long.' });
    }

    const normalizedEmail = email.trim().toLowerCase();
    if (!isValidEmail(normalizedEmail)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }

    const trimmedMobile = typeof mobile === 'string' ? mobile.trim() : '';
    if (trimmedMobile && !isValidMobile(trimmedMobile)) {
      return res.status(400).json({ error: 'Please enter a valid mobile number.' });
    }

    const emailCheck = await store.getUserByEmail(normalizedEmail);
    if (emailCheck) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }

    if (trimmedMobile) {
      const mobileCheck = await store.getUserByMobile(trimmedMobile);
      if (mobileCheck) {
        return res.status(409).json({ error: 'An account with this mobile number already exists.' });
      }
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUserId = 'user_' + Date.now() + '_' + randomBytes(3).toString('hex');
    const newUser: User = {
      id: newUserId,
      name: (typeof name === 'string' && name.trim() ? name.trim().slice(0, 80) : normalizedEmail.split('@')[0]),
      email: normalizedEmail,
      mobile: trimmedMobile || undefined,
      role: 'user',
      avatar: 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=400&h=400&fit=crop',
      title: SITE_CONFIG.AGENCY_MODE ? 'Client' : 'Freelancer / Member',
      rating: 0,
      reviewsCount: 0,
      hourlyRate: 50,
      earned: 0,
      completedJobs: 0,
      bio: `New client on ${SITE_CONFIG.brandName}.`,
      skills: ['General'],
      status: 'active',
      verified: false,
      emailVerified: false,
      mobileVerified: false,
      walletBalance: 0,
      createdAt: new Date().toISOString().substring(0, 10),
      password: hashedPassword,
      sessionVersion: 1,
      activeSessionVersions: [1],
      knownDevices: req.body?.deviceId ? [String(req.body.deviceId).trim()] : ['dev_default_session']
    };

    await store.saveUser(newUser);
    await ensureWallet(newUserId);

    const emailCode = generate6DigitCode();
    const now = Date.now();
    const expiresAtMs = now + 30 * 60 * 1000;
    if (isPostgresEnabled()) {
      try {
        await postgresStore.getPool().query(
          `INSERT INTO auth_verification_codes (email, code, type, attempts, last_resend_at, expires_at, created_at)
           VALUES ($1, $2, 'verify', 0, $3, $4, NOW())
           ON CONFLICT (email, type) DO UPDATE SET code = $2, attempts = 0, last_resend_at = $3, expires_at = $4, created_at = NOW()`,
          [normalizedEmail, emailCode, now, new Date(expiresAtMs)]
        );
      } catch (e) {
        console.error('[Auth] Failed to persist verification code to DB:', e);
        return res.status(500).json({ error: 'Failed to generate verification code.' });
      }
    } else {
      emailVerificationCodes.set(normalizedEmail, {
        code: emailCode,
        expiresAt: expiresAtMs,
        lastResendAt: now,
        attempts: 0
      });
    }

    deliverSecurityCode(normalizedEmail, 'SIGNUP_EMAIL', emailCode);

    if (trimmedMobile) {
      const smsCode = generate6DigitCode();
      const smsExpiresAtMs = Date.now() + 30 * 60 * 1000;
      if (isPostgresEnabled()) {
        try {
          await postgresStore.getPool().query(
            `INSERT INTO auth_verification_codes (email, code, type, attempts, last_resend_at, expires_at, created_at)
             VALUES ($1, $2, 'sms', 0, $3, $4, NOW())
             ON CONFLICT (email, type) DO UPDATE SET code = $2, attempts = 0, last_resend_at = $3, expires_at = $4, created_at = NOW()`,
            [trimmedMobile, smsCode, Date.now(), new Date(smsExpiresAtMs)]
          );
        } catch (e) {
          console.warn('[Auth] Failed to persist SMS verification code to DB:', e);
        }
      }
      smsVerificationCodes.set(trimmedMobile, {
        code: smsCode,
        expiresAt: smsExpiresAtMs,
        lastResendAt: Date.now(),
        attempts: 0
      });
      deliverSecurityCode(trimmedMobile, 'SIGNUP_SMS', smsCode);
    }

    recordUserEmail({
      id: 'email_' + Date.now() + '_' + randomUUID().slice(0, 8),
      userId: newUserId,
      userEmail: normalizedEmail,
      subject: `Verify Your ${SITE_CONFIG.brandName} Account`,
      snippet: `Welcome to ${SITE_CONFIG.brandName}! Verification code dispatched.`,
      body: `Welcome to ${SITE_CONFIG.brandName}! Please enter the verification code sent to your registered contact channel to verify your account.`,
      date: new Date().toLocaleDateString(),
      read: false,
      type: 'GENERAL'
    });

    res.status(201).json({
      success: true,
      requiresVerification: true,
      message: 'Account created! Please enter the 6-digit verification code sent to your email to complete registration.',
      email: normalizedEmail,
      user: safeUser(newUser),
      ...(shouldExposeMockCodes() ? { mockCode: emailCode, mockEmailCode: emailCode } : {})
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Signup failed' });
  }
});

// 2. Email Verification & Resend
authRouter.post('/verify-email', rateLimit(30, 3_600_000), async (req: Request, res: Response) => {
  const { email, code: rawCode } = req.body || {};
  if (typeof email !== 'string' || !email.trim() || rawCode === undefined || rawCode === null || String(rawCode).trim() === '') {
    return res.status(400).json({ error: 'Email and code are required.' });
  }
  const code = String(rawCode).trim();
  const normalizedEmail = email.trim().toLowerCase();

  let valid = false;
  if (isPostgresEnabled()) {
    try {
      const result = await postgresStore.executeInTransaction(async (client) => {
        const codeRes = await client.query(
          `SELECT * FROM auth_verification_codes WHERE email = $1 AND type = 'verify' FOR UPDATE`,
          [normalizedEmail]
        );
        if (codeRes.rows.length === 0) {
          return { status: 400, error: 'Invalid verification code.' };
        }
        const row = codeRes.rows[0];
        if (new Date() > new Date(row.expires_at)) {
          await client.query(`DELETE FROM auth_verification_codes WHERE email = $1 AND type = 'verify'`, [normalizedEmail]);
          return { status: 400, error: 'Verification code has expired. Please request a new one.' };
        }
        if (Number(row.attempts || 0) >= 5) {
          await client.query(`DELETE FROM auth_verification_codes WHERE email = $1 AND type = 'verify'`, [normalizedEmail]);
          return { status: 429, error: 'Too many failed attempts. Code invalidated.' };
        }
        if (row.code === code) {
          await client.query(`DELETE FROM auth_verification_codes WHERE email = $1 AND type = 'verify'`, [normalizedEmail]);
          return { ok: true };
        } else {
          const upd = await client.query(
            `UPDATE auth_verification_codes SET attempts = attempts + 1 WHERE email = $1 AND type = 'verify' RETURNING attempts`,
            [normalizedEmail]
          );
          if (Number(upd.rows[0]?.attempts || 0) >= 5) {
            await client.query(`DELETE FROM auth_verification_codes WHERE email = $1 AND type = 'verify'`, [normalizedEmail]);
            return { status: 429, error: 'Too many failed attempts. Code invalidated.' };
          }
          return { status: 400, error: 'Invalid verification code.' };
        }
      });

      if (result.error) {
        return res.status(result.status).json({ error: result.error });
      }
      valid = true;
    } catch (e) {
      console.error('[Auth] Error querying auth_verification_codes:', e);
      return res.status(500).json({ error: 'Failed to verify code.' });
    }
  } else {
    if (IS_PRODUCTION) {
      return res.status(500).json({ error: 'Security verification requires database connection in production.' });
    }
    const record = emailVerificationCodes.get(normalizedEmail);
    if (record) {
      if (Date.now() > record.expiresAt) {
        emailVerificationCodes.delete(normalizedEmail);
        return res.status(400).json({ error: 'Verification code has expired. Please request a new one.' });
      }
      if (record.attempts >= 5) {
        emailVerificationCodes.delete(normalizedEmail);
        return res.status(429).json({ error: 'Too many failed attempts. Code invalidated.' });
      }
      if (record.code === code) {
        valid = true;
        emailVerificationCodes.delete(normalizedEmail);
      } else {
        record.attempts++;
      }
    }
  }

  if (!valid) {
    return res.status(400).json({ error: 'Invalid verification code.' });
  }

  const user = await store.getUserByEmail(normalizedEmail);
  if (!user) {
    return res.status(404).json({ error: 'User account not found.' });
  }
  if (user.status === 'suspended' || user.status === 'deactivated') {
    return res.status(403).json({ error: 'Account is suspended or deactivated. Please contact support.' });
  }
  if (user.emailVerified) {
    return res.status(400).json({ error: 'This email address is already verified. Please log in with your password.' });
  }

  user.emailVerified = true;
  user.verified = true;
  const sessionVersion = await registerNewUserSessionAtomic(user);

  const token = signToken({
    id: user.id,
    role: user.role,
    email: user.email,
    sessionVersion
  });

  res.json({
    success: true,
    message: 'Email verified successfully!',
    token,
    user: safeUser(user)
  });
});

authRouter.post('/resend-email-code', rateLimit(10, 3_600_000), async (req: Request, res: Response) => {
  const { email } = req.body || {};
  if (typeof email !== 'string' || !email.trim()) return res.status(400).json({ error: 'Email is required.' });
  const normalizedEmail = email.trim().toLowerCase();
  const generic = { success: true, message: 'If this email needs verification, a new code has been sent.' };
  const user = await store.getUserByEmail(normalizedEmail);
  if (!user || user.emailVerified) return res.json(generic);

  const now = Date.now();
  const newCode = generate6DigitCode();
  const expiresAtMs = now + 30 * 60 * 1000;

  if (isPostgresEnabled()) {
    const pool = postgresStore.getPool();
    try {
      const existingRes = await pool.query(
        `SELECT last_resend_at FROM auth_verification_codes WHERE email = $1 AND type = 'verify'`,
        [normalizedEmail]
      );
      if (existingRes.rows.length > 0 && now - Number(existingRes.rows[0].last_resend_at || 0) < 30_000) {
        return res.status(429).json({ error: 'Please wait 30 seconds before requesting a new resend.' });
      }
      await pool.query(
        `INSERT INTO auth_verification_codes (email, code, type, attempts, last_resend_at, expires_at, created_at)
         VALUES ($1, $2, 'verify', 0, $3, $4, NOW())
         ON CONFLICT (email, type) DO UPDATE SET code = $2, attempts = 0, last_resend_at = $3, expires_at = $4, created_at = NOW()`,
        [normalizedEmail, newCode, now, new Date(expiresAtMs)]
      );
    } catch (e) {
      console.error('[Auth] Failed to persist resend verification code to DB:', e);
      return res.status(500).json({ error: 'Failed to generate verification code.' });
    }
  } else {
    if (IS_PRODUCTION) {
      return res.status(500).json({ error: 'Security verification requires database connection in production.' });
    }
    const existing = emailVerificationCodes.get(normalizedEmail);
    if (existing && now - existing.lastResendAt < 30_000) {
      return res.status(429).json({ error: 'Please wait 30 seconds before requesting a new resend.' });
    }
    emailVerificationCodes.set(normalizedEmail, {
      code: newCode,
      expiresAt: expiresAtMs,
      lastResendAt: now,
      attempts: 0
    });
  }

  deliverSecurityCode(normalizedEmail, 'EMAIL_VERIFICATION', newCode);

  recordUserEmail({
    id: 'email_' + Date.now() + '_' + randomUUID().slice(0, 8),
    userId: user.id,
    userEmail: normalizedEmail,
    subject: `Your New ${SITE_CONFIG.brandName} Verification Code`,
    snippet: 'A new verification code was dispatched.',
    body: 'A new verification code was requested for your account. Please enter the code sent to your registered contact channel.',
    date: new Date().toLocaleDateString(),
    read: false,
    type: 'GENERAL'
  });

  res.json({
    ...generic,
    ...(shouldExposeMockCodes() ? { mockCode: newCode, mockEmailCode: newCode } : {})
  });
});

// 3. Mobile / SMS Verification & Resend
authRouter.post('/verify-sms', rateLimit(30, 3_600_000), async (req: Request, res: Response) => {
  const { mobile, code: rawCode } = req.body || {};
  if (typeof mobile !== 'string' || !mobile.trim() || rawCode === undefined || rawCode === null || String(rawCode).trim() === '') {
    return res.status(400).json({ error: 'Mobile number and code are required.' });
  }
  const code = String(rawCode).trim();
  const cleanMobile = mobile.trim();

  if (isPostgresEnabled()) {
    try {
      const result = await postgresStore.executeInTransaction(async (client) => {
        const codeRes = await client.query(
          `SELECT * FROM auth_verification_codes WHERE email = $1 AND type = 'sms' FOR UPDATE`,
          [cleanMobile]
        );
        if (codeRes.rows.length === 0) {
          return { status: 400, error: 'No SMS verification code found or expired.' };
        }
        const row = codeRes.rows[0];
        if (new Date() > new Date(row.expires_at)) {
          await client.query(`DELETE FROM auth_verification_codes WHERE email = $1 AND type = 'sms'`, [cleanMobile]);
          return { status: 400, error: 'SMS verification code has expired.' };
        }
        if (Number(row.attempts || 0) >= 5) {
          await client.query(`DELETE FROM auth_verification_codes WHERE email = $1 AND type = 'sms'`, [cleanMobile]);
          return { status: 429, error: 'Too many failed attempts.' };
        }
        if (row.code === code) {
          await client.query(`DELETE FROM auth_verification_codes WHERE email = $1 AND type = 'sms'`, [cleanMobile]);
          return { ok: true };
        }
        const upd = await client.query(
          `UPDATE auth_verification_codes SET attempts = attempts + 1 WHERE email = $1 AND type = 'sms' RETURNING attempts`,
          [cleanMobile]
        );
        if (Number(upd.rows[0]?.attempts || 0) >= 5) {
          await client.query(`DELETE FROM auth_verification_codes WHERE email = $1 AND type = 'sms'`, [cleanMobile]);
          return { status: 429, error: 'Too many failed attempts.' };
        }
        return { status: 400, error: 'Invalid SMS verification code.' };
      });
      if (result.error) {
        return res.status(result.status).json({ error: result.error });
      }
      smsVerificationCodes.delete(cleanMobile);
    } catch (e) {
      console.error('[Auth] Error verifying SMS code in DB:', e);
      return res.status(500).json({ error: 'Failed to verify SMS code.' });
    }
  } else {
    const record = smsVerificationCodes.get(cleanMobile);
    if (!record) return res.status(400).json({ error: 'No SMS verification code found or expired.' });
    if (Date.now() > record.expiresAt) {
      smsVerificationCodes.delete(cleanMobile);
      return res.status(400).json({ error: 'SMS verification code has expired.' });
    }
    if (record.attempts >= 5) {
      smsVerificationCodes.delete(cleanMobile);
      return res.status(429).json({ error: 'Too many failed attempts.' });
    }
    if (record.code !== code) {
      record.attempts++;
      return res.status(400).json({ error: 'Invalid SMS verification code.' });
    }
    smsVerificationCodes.delete(cleanMobile);
  }

  const user = await store.getUserByMobile(cleanMobile);
  if (user) {
    user.mobileVerified = true;
    const requireEmailVerification = siteSettings.getSettings()?.security?.requireEmailVerification !== false;
    if (!requireEmailVerification || user.emailVerified) {
      user.verified = true;
    }
    await store.saveUser(user);
  }
  res.json({ success: true, message: 'Mobile verified successfully via SMS!' });
});

authRouter.post('/resend-sms-code', requireAuth, rateLimit(10, 3_600_000, 'resend_sms'), async (req: Request, res: Response) => {
  const caller = (req as any).authenticatedUser;
  const { mobile } = req.body || {};
  const cleanMobile = (typeof mobile === 'string' && mobile.trim()) ? mobile.trim() : String(caller?.mobile || '').trim();
  if (!cleanMobile) return res.status(400).json({ error: 'Mobile number is required.' });
  if (!isValidMobile(cleanMobile)) return res.status(400).json({ error: 'Please enter a valid mobile number.' });

  // Enforce phone ownership so users cannot spam arbitrary phone numbers
  if (caller?.mobile && caller.mobile.trim() !== cleanMobile && !isStaffUser(caller)) {
    return res.status(403).json({ error: 'Forbidden: Mobile number does not match your account.' });
  }
  const existingOwner = await store.getUserByMobile(cleanMobile);
  if (existingOwner && existingOwner.id !== caller?.id && !isStaffUser(caller)) {
    return res.status(409).json({ error: 'This mobile number is already registered to another account.' });
  }

  const now = Date.now();
  const newCode = generate6DigitCode();
  const expiresAtMs = now + 30 * 60 * 1000;

  if (isPostgresEnabled()) {
    const pool = postgresStore.getPool();
    try {
      const existingRes = await pool.query(
        `SELECT last_resend_at FROM auth_verification_codes WHERE email = $1 AND type = 'sms'`,
        [cleanMobile]
      );
      if (existingRes.rows.length > 0 && now - Number(existingRes.rows[0].last_resend_at || 0) < 30_000) {
        return res.status(429).json({ error: 'Please wait 30 seconds before resending SMS.' });
      }
      await pool.query(
        `INSERT INTO auth_verification_codes (email, code, type, attempts, last_resend_at, expires_at, created_at)
         VALUES ($1, $2, 'sms', 0, $3, $4, NOW())
         ON CONFLICT (email, type) DO UPDATE SET code = $2, attempts = 0, last_resend_at = $3, expires_at = $4, created_at = NOW()`,
        [cleanMobile, newCode, now, new Date(expiresAtMs)]
      );
    } catch (e) {
      console.error('[Auth] Failed to persist resend SMS code to DB:', e);
      return res.status(500).json({ error: 'Failed to generate SMS verification code.' });
    }
  } else {
    const existing = smsVerificationCodes.get(cleanMobile);
    if (existing && now - existing.lastResendAt < 30_000) {
      return res.status(429).json({ error: 'Please wait 30 seconds before resending SMS.' });
    }
  }

  smsVerificationCodes.set(cleanMobile, {
    code: newCode,
    expiresAt: expiresAtMs,
    lastResendAt: now,
    attempts: 0
  });

  deliverSecurityCode(cleanMobile, 'SMS_OTP', newCode);
  res.json({ success: true, message: 'New SMS OTP dispatched.' });
});

// 4. Login Endpoints
authRouter.post('/login', rateLimit(15, 15 * 60_000, 'auth_login'), handleLogin);
authRouter.post('/login/verify', rateLimit(15, 15 * 60_000, 'auth_login_verify'), handleLogin);

// 4b. Server-side Logout (revokes active sessions and closes WebSockets)
authRouter.post('/logout', requireAuth, async (req: Request, res: Response) => {
  try {
    const authUserId = resolveAuthenticatedUserId(req);
    if (!authUserId) return res.status(401).json({ error: 'Unauthorized' });
    const user = await store.getUser(authUserId);
    if (user) {
      await revokeAllUserSessionsAtomic(user, 'User logged out');
    }
    return res.json({ success: true, message: 'Logged out successfully.' });
  } catch (err: any) {
    return res.status(500).json({ error: 'Failed to revoke session.' });
  }
});

// 4c. First-Run One-Time Admin Setup (only active when ADMIN_INITIAL_PASSWORD is unset and no super_admin has a password yet)
async function getUnclaimedSuperAdmins(): Promise<User[]> {
  const allUsers = await store.listUsers();
  const superAdmins = allUsers.filter((u) => u.role === 'super_admin');
  const hasConfiguredAdmin = superAdmins.some((u) => typeof u.password === 'string' && u.password.trim().length > 0);
  if (hasConfiguredAdmin || (process.env.ADMIN_INITIAL_PASSWORD || '').trim().length > 0) {
    return [];
  }
  return superAdmins;
}

authRouter.get('/admin-setup-status', async (_req: Request, res: Response) => {
  try {
    const unclaimed = await getUnclaimedSuperAdmins();
    if (unclaimed.length === 0) {
      return res.json({ needsSetup: false });
    }
    return res.json({
      needsSetup: true,
      suggestedEmail: unclaimed[0]?.email || 'admin@joymediapr.com'
    });
  } catch {
    return res.json({ needsSetup: false });
  }
});

authRouter.post('/admin-setup', rateLimit(10, 15 * 60_000, 'admin_setup'), async (req: Request, res: Response) => {
  try {
    if ((process.env.ADMIN_INITIAL_PASSWORD || '').trim().length > 0) {
      return res.status(403).json({ error: 'Initial administrator setup is managed via environment configuration.' });
    }
    const { email, password, confirmPassword } = req.body || {};
    if (typeof email !== 'string' || !email.trim() || !isValidEmail(email.trim().toLowerCase())) {
      return res.status(400).json({ error: 'Please provide a valid administrator email address.' });
    }
    if (typeof password !== 'string' || password.length < 10) {
      return res.status(400).json({ error: 'Initial administrator password must be at least 10 characters long.' });
    }
    if (confirmPassword !== undefined && password !== confirmPassword) {
      return res.status(400).json({ error: 'Passwords do not match.' });
    }

    const targetEmail = email.trim().toLowerCase();
    const hashed = await bcrypt.hash(password, 10);

    if (isPostgresEnabled()) {
      const result = await postgresStore.executeInTransaction(async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext('admin_initial_setup'))");

        const metaRes = await client.query(
          "SELECT value FROM app_metadata WHERE key = 'admin_setup_completed' LIMIT 1"
        );
        if (metaRes.rows.length > 0 && metaRes.rows[0].value === 'true') {
          return { status: 403, error: 'Initial administrator setup has already been completed.' };
        }

        const saRes = await client.query(
          "SELECT id, email, password, password_hash FROM users WHERE LOWER(role) = 'super_admin' ORDER BY id ASC FOR UPDATE"
        );
        const alreadyClaimed = saRes.rows.some(
          (r: any) => (typeof r.password === 'string' && r.password.trim().length > 0) ||
                      (typeof r.password_hash === 'string' && r.password_hash.trim().length > 0)
        );
        if (saRes.rows.length === 0 || alreadyClaimed) {
          return { status: 403, error: 'Initial administrator setup has already been completed.' };
        }

        const targetRow = saRes.rows.find((r: any) => String(r.email || '').toLowerCase() === targetEmail) || saRes.rows[0];
        const emailConflict = await client.query(
          'SELECT id FROM users WHERE LOWER(email) = LOWER($1) AND id <> $2 LIMIT 1',
          [targetEmail, targetRow.id]
        );
        if (emailConflict.rows.length > 0) {
          return { status: 409, error: 'This email address is already registered to another account.' };
        }

        await client.query(
          `UPDATE users
           SET email = $1, password = $2, password_hash = $2, known_devices = $3, email_verified = TRUE, verified = TRUE
           WHERE id = $4`,
          [targetEmail, hashed, [], targetRow.id]
        );
        await client.query(
          `INSERT INTO app_metadata (key, value) VALUES ('admin_setup_completed', 'true')
           ON CONFLICT (key) DO UPDATE SET value = 'true'`
        );
        return { ok: true, email: targetEmail };
      });

      if ('error' in result && result.error) {
        return res.status(result.status ?? 400).json({ error: result.error });
      }
      return res.json({
        success: true,
        email: result.email,
        message: 'Initial administrator password configured. Please sign in with your new credentials.'
      });
    }

    const unclaimed = await getUnclaimedSuperAdmins();
    if (unclaimed.length === 0) {
      return res.status(403).json({ error: 'Initial administrator setup has already been completed.' });
    }
    const targetAdmin = unclaimed.find((u) => u.email.toLowerCase() === targetEmail) || unclaimed[0];
    const existing = await store.getUserByEmail(targetEmail);
    if (existing && existing.id !== targetAdmin.id) {
      return res.status(409).json({ error: 'This email address is already registered to another account.' });
    }
    targetAdmin.email = targetEmail;
    targetAdmin.password = hashed;
    targetAdmin.knownDevices = [];
    await store.saveUser(targetAdmin);

    return res.json({
      success: true,
      email: targetAdmin.email,
      message: 'Initial administrator password configured. Please sign in with your new credentials.'
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'Failed to complete initial administrator setup.' });
  }
});

// 5. Current Session (Me)
authRouter.get('/me', async (req: Request, res: Response) => {
  const authUserId = resolveAuthenticatedUserId(req);
  if (!authUserId) {
    return res.status(401).json({ error: 'Unauthenticated session token.' });
  }
  const u = await store.getUser(authUserId);
  if (!u) {
    return res.status(401).json({ error: 'User account not found.' });
  }
  if (u.status !== 'active') {
    return res.status(403).json({ error: `Account is ${u.status}.` });
  }
  return res.json({ success: true, user: safeUser(u) });
});

// 6. Demo Session (disabled in agency/production mode; test-only)
authRouter.post('/demo-session', async (req: Request, res: Response) => {
  if ((SITE_CONFIG.AGENCY_MODE || IS_PRODUCTION) && !isTestEnv) return res.status(404).json({ error: 'Not found.' });
  const { userId } = req.body || {};
  const user = await store.getUser(userId);
  if (!user) return res.status(404).json({ error: 'Demo user not found.' });
  if (isStaffUser(user)) {
    return res.status(403).json({ error: 'Demo login is not available for privileged accounts.' });
  }
  let sessionVersion: number;
  try {
    sessionVersion = await registerNewUserSessionAtomic(user);
  } catch (err: any) {
    return res.status(500).json({ error: 'Failed to persist demo session.' });
  }
  const token = signToken({ id: user.id, role: user.role, email: user.email, sessionVersion });
  return res.json({ success: true, token, user: safeUser(user) });
});

// 7. Forgot Password Flow
authRouter.post('/forgot-password/request', rateLimit(10, 3_600_000), async (req: Request, res: Response) => {
  const { emailOrMobile, query: reqQuery } = req.body || {};
  const rawInput = emailOrMobile || reqQuery;
  if (typeof rawInput !== 'string' || !rawInput.trim()) return res.status(400).json({ error: 'Email or mobile is required.' });
  const query = rawInput.trim().toLowerCase();
  const genericResponse = { success: true, message: 'If an account exists, a recovery code has been sent.' };

  const user = await store.getUserByEmailOrMobile(query);
  if (!user) {
    return res.json(genericResponse);
  }

  const now = Date.now();
  const code = generate6DigitCode();
  const expiresAtMs = now + 30 * 60 * 1000;
  const emailKey = (user.email || query).toLowerCase();

  if (isPostgresEnabled()) {
    const pool = postgresStore.getPool();
    try {
      const existingRes = await pool.query(
        `SELECT last_resend_at FROM auth_verification_codes WHERE email = $1 AND type = 'reset'`,
        [emailKey]
      );
      if (existingRes.rows.length > 0 && now - Number(existingRes.rows[0].last_resend_at || 0) < 30_000) {
        return res.json(genericResponse);
      }
      await pool.query(
        `INSERT INTO auth_verification_codes (email, code, type, attempts, last_resend_at, expires_at, created_at)
         VALUES ($1, $2, 'reset', 0, $3, $4, NOW())
         ON CONFLICT (email, type) DO UPDATE SET code = $2, attempts = 0, last_resend_at = $3, expires_at = $4, created_at = NOW()`,
        [emailKey, code, now, new Date(expiresAtMs)]
      );
    } catch (e) {
      console.error('[Auth] Failed to persist reset code to DB:', e);
      return res.status(500).json({ error: 'Failed to generate recovery code.' });
    }
  } else {
    if (IS_PRODUCTION) {
      return res.status(500).json({ error: 'Security verification requires database connection in production.' });
    }
    const existing = forgotPasswordCodes.get(query);
    if (existing && now - existing.lastResendAt < 30_000) {
      return res.json(genericResponse);
    }
    forgotPasswordCodes.set(query, {
      code,
      expiresAt: expiresAtMs,
      lastResendAt: now,
      attempts: 0
    });
  }

  if (user.role === 'admin' || user.role === 'super_admin') {
    deliverAdminCode(user.email, code);
  } else if (user.email) {
    deliverSecurityCode(user.email, 'PASSWORD_RESET', code);
  } else if (user.mobile) {
    deliverSecurityCode(user.mobile, 'PASSWORD_RESET', code);
  }

  res.json({
    ...genericResponse,
    ...(shouldExposeMockCodes() ? { mockCode: code, mockEmailCode: code } : {})
  });
});

authRouter.post('/forgot-password/verify', rateLimit(10, 15 * 60_000, 'auth_reset_verify'), async (req: Request, res: Response) => {
  const { emailOrMobile, query: reqQuery, code } = req.body || {};
  const rawInput = emailOrMobile || reqQuery;
  if (typeof rawInput !== 'string' || !rawInput.trim() || !code) return res.status(400).json({ error: 'Identifier and code are required.' });
  const query = rawInput.trim().toLowerCase();
  const trimmedCode = String(code).trim();

  if (isPostgresEnabled()) {
    try {
      const errRes = await postgresStore.executeInTransaction(async (client) => {
        const codeRes = await client.query(
          `SELECT * FROM auth_verification_codes WHERE (email = $1 OR email = (SELECT LOWER(email) FROM users WHERE mobile = $1 LIMIT 1)) AND type = 'reset' FOR UPDATE`,
          [query]
        );
        if (codeRes.rows.length === 0) {
          return { status: 400, error: 'Invalid or expired recovery code.' };
        }
        const row = codeRes.rows[0];
        if (new Date() > new Date(row.expires_at)) {
          await client.query(`DELETE FROM auth_verification_codes WHERE email = $1 AND type = 'reset'`, [row.email]);
          return { status: 400, error: 'Invalid or expired recovery code.' };
        }
        if (Number(row.attempts || 0) >= 5) {
          await client.query(`DELETE FROM auth_verification_codes WHERE email = $1 AND type = 'reset'`, [row.email]);
          return { status: 429, error: 'Too many failed attempts. Please request a new recovery code.' };
        }
        if (row.code !== trimmedCode) {
          const upd = await client.query(
            `UPDATE auth_verification_codes SET attempts = attempts + 1 WHERE email = $1 AND type = 'reset' RETURNING attempts`,
            [row.email]
          );
          if (Number(upd.rows[0]?.attempts || 0) >= 5) {
            await client.query(`DELETE FROM auth_verification_codes WHERE email = $1 AND type = 'reset'`, [row.email]);
            return { status: 429, error: 'Too many failed attempts. Please request a new recovery code.' };
          }
          return { status: 400, error: 'Invalid or expired recovery code.' };
        }
        return null;
      });

      if (errRes) {
        return res.status(errRes.status).json({ error: errRes.error });
      }
      return res.json({ success: true, message: 'Code verified successfully.' });
    } catch (e) {
      console.error('[Auth] Error verifying reset code from DB:', e);
      return res.status(500).json({ error: 'Failed to verify recovery code.' });
    }
  }

  if (IS_PRODUCTION) {
    return res.status(500).json({ error: 'Security verification requires database connection in production.' });
  }

  const check = checkRecoveryCode(query, trimmedCode, true);
  if (check === 'locked') return res.status(429).json({ error: 'Too many failed attempts. Please request a new recovery code.' });
  if (check !== 'ok') {
    return res.status(400).json({ error: 'Invalid or expired recovery code.' });
  }

  res.json({ success: true, message: 'Code verified successfully.' });
});

authRouter.post('/forgot-password/reset', rateLimit(10, 15 * 60_000, 'auth_reset_exec'), async (req: Request, res: Response) => {
  const { emailOrMobile, query: reqQuery, code, newPassword, confirmPassword, confirmNewPassword } = req.body || {};
  const rawInput = emailOrMobile || reqQuery;
  if (typeof rawInput !== 'string' || !rawInput.trim() || !code || typeof newPassword !== 'string' || !newPassword) {
    return res.status(400).json({ error: 'All fields are required.' });
  }
  const confirmToUse = confirmPassword || confirmNewPassword;
  if (confirmToUse && newPassword !== confirmToUse) {
    return res.status(400).json({ error: 'Passwords do not match.' });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters long.' });
  }
  const query = rawInput.trim().toLowerCase();
  const trimmedCode = String(code).trim();

  if (isPostgresEnabled()) {
    try {
      const errRes = await postgresStore.executeInTransaction(async (client) => {
        const codeRes = await client.query(
          `SELECT * FROM auth_verification_codes WHERE (email = $1 OR email = (SELECT LOWER(email) FROM users WHERE mobile = $1 LIMIT 1)) AND type = 'reset' FOR UPDATE`,
          [query]
        );
        if (codeRes.rows.length === 0) {
          return { status: 400, error: 'Invalid or expired recovery code. Please request a new one.' };
        }
        const row = codeRes.rows[0];
        if (new Date() > new Date(row.expires_at)) {
          await client.query(`DELETE FROM auth_verification_codes WHERE email = $1 AND type = 'reset'`, [row.email]);
          return { status: 400, error: 'Invalid or expired recovery code. Please request a new one.' };
        }
        if (Number(row.attempts || 0) >= 5) {
          await client.query(`DELETE FROM auth_verification_codes WHERE email = $1 AND type = 'reset'`, [row.email]);
          return { status: 429, error: 'Too many failed attempts. Please request a new recovery code.' };
        }
        if (row.code !== trimmedCode) {
          const upd = await client.query(
            `UPDATE auth_verification_codes SET attempts = attempts + 1 WHERE email = $1 AND type = 'reset' RETURNING attempts`,
            [row.email]
          );
          if (Number(upd.rows[0]?.attempts || 0) >= 5) {
            await client.query(`DELETE FROM auth_verification_codes WHERE email = $1 AND type = 'reset'`, [row.email]);
            return { status: 429, error: 'Too many failed attempts. Please request a new recovery code.' };
          }
          return { status: 400, error: 'Invalid or expired recovery code. Please request a new one.' };
        }
        await client.query(`DELETE FROM auth_verification_codes WHERE email = $1 AND type = 'reset'`, [row.email]);
        return null;
      });

      if (errRes) {
        return res.status(errRes.status).json({ error: errRes.error });
      }
    } catch (e) {
      console.error('[Auth] Error querying reset code during reset:', e);
      return res.status(500).json({ error: 'Failed to reset password.' });
    }
  } else {
    if (IS_PRODUCTION) {
      return res.status(500).json({ error: 'Security verification requires database connection in production.' });
    }
    const record = forgotPasswordCodes.get(query);
    if (!record || record.code !== trimmedCode || Date.now() > record.expiresAt) {
      return res.status(400).json({ error: 'Invalid or expired recovery code. Please request a new one.' });
    }
    forgotPasswordCodes.delete(query);
  }

  const user = await store.getUserByEmailOrMobile(query);
  if (!user) return res.status(404).json({ error: 'User not found.' });

  user.password = await bcrypt.hash(newPassword, 10);
  await store.saveUser(user);
  await revokeAllUserSessionsAtomic(user, 'Password reset');

  res.json({ success: true, message: 'Password reset successfully. Please log in with your new password.' });
});

// 8. Withdrawal Code Request & Execute
authRouter.post('/withdrawal/request-code', requireAuth, requireFinancialActiveStatus, async (req: Request, res: Response) => {
  const authUserId = resolveAuthenticatedUserId(req);
  const caller = authUserId ? await store.getUser(authUserId) : null;
  if (!caller || !caller.email) return res.status(400).json({ error: 'User email not found.' });
  if (!canManageAgencyPayouts(caller, SITE_CONFIG.AGENCY_MODE)) {
    return res.status(403).json({ error: 'Forbidden: Only agency administrators and staff can request payouts or withdrawals.' });
  }

  if (req.body?.amount !== undefined && req.body?.amount !== null && String(req.body.amount).trim() !== '') {
    const numAmount = Number(req.body.amount);
    if (!Number.isFinite(numAmount) || numAmount <= 0 || Math.abs(Math.round(numAmount * 100) - numAmount * 100) > 1e-6) {
      return res.status(400).json({ error: 'Please enter a valid withdrawal amount greater than $0.00 with at most 2 decimal places.' });
    }
    const { siteSettings, DEFAULT_SITE_SETTINGS } = await import('../domains/admin/siteSettings.js');
    const liveSettings = siteSettings.getSettings();
    const walletConfig = liveSettings?.wallets || DEFAULT_SITE_SETTINGS.wallets;
    const minPayout = Number(walletConfig?.minimumWithdrawalAmount ?? 3.00);
    const maxPerTx = Number(walletConfig?.maximumWithdrawalPerTransaction ?? 5000.00);
    if (numAmount < minPayout) {
      return res.status(400).json({ error: `Minimum payout withdrawal amount is $${minPayout.toFixed(2)}.` });
    }
    if (numAmount > maxPerTx) {
      return res.status(400).json({ error: `Maximum withdrawal per transaction is $${maxPerTx.toFixed(2)}.` });
    }
    if (isPostgresEnabled()) {
      const wRes = await postgresStore.getPool().query('SELECT available_balance FROM wallets WHERE user_id = $1', [caller.id]);
      const availBal = wRes.rows.length > 0 ? Number(wRes.rows[0].available_balance || 0) : Number(caller.walletBalance || 0);
      if (numAmount > availBal) {
        return res.status(400).json({ error: 'Insufficient available balance.' });
      }
    }
  }

  const now = Date.now();
  const expiresAtMs = now + 30 * 60 * 1000;
  let code = generate6DigitCode();
  let preservedAttempts = 0;

  if (isPostgresEnabled()) {
    const pool = postgresStore.getPool();
    try {
      const existingRes = await pool.query(
        `SELECT code, attempts, last_resend_at, expires_at FROM auth_verification_codes WHERE email = $1 AND type = 'withdrawal'`,
        [caller.id]
      );
      if (existingRes.rows.length > 0) {
        const row = existingRes.rows[0];
        const currentAttempts = Number(row.attempts || 0);
        const lastTimestamp = Number(row.last_resend_at || 0);
        if (currentAttempts >= WITHDRAWAL_MAX_ATTEMPTS) {
          const elapsed = now - lastTimestamp;
          if (elapsed < WITHDRAWAL_COOLDOWN_MS) {
            const remainingMins = Math.max(1, Math.ceil((WITHDRAWAL_COOLDOWN_MS - elapsed) / 60_000));
            return res.status(429).json({
              error: `Too many failed attempts. Please wait ${remainingMins} minute${remainingMins === 1 ? '' : 's'} before requesting a new withdrawal code.`
            });
          }
          // Cooldown elapsed: reset attempts to 0 and issue a new code
          preservedAttempts = 0;
        } else {
          const isUnexpired = row.expires_at && new Date(row.expires_at).getTime() > now;
          if (isUnexpired && typeof row.code === 'string' && row.code.trim()) {
            code = row.code.trim();
            preservedAttempts = currentAttempts;
          }
        }
      }
      await pool.query(
        `INSERT INTO auth_verification_codes (email, code, type, attempts, last_resend_at, expires_at, created_at)
         VALUES ($1, $2, 'withdrawal', $3, $4, $5, NOW())
         ON CONFLICT (email, type) DO UPDATE SET code = $2, attempts = $3, last_resend_at = $4, expires_at = $5, created_at = NOW()`,
        [caller.id, code, preservedAttempts, now, new Date(expiresAtMs)]
      );
    } catch (e) {
      console.error('[Auth] Failed to persist withdrawal verification code to DB:', e);
      return res.status(500).json({ error: 'Failed to generate withdrawal verification code.' });
    }
  } else {
    if (IS_PRODUCTION) {
      return res.status(500).json({ error: 'Security verification requires database connection in production.' });
    }
    const existing = withdrawalVerificationCodes.get(caller.id);
    if (existing) {
      if (existing.attempts >= WITHDRAWAL_MAX_ATTEMPTS) {
        const elapsed = now - existing.lastResendAt;
        if (elapsed < WITHDRAWAL_COOLDOWN_MS) {
          const remainingMins = Math.max(1, Math.ceil((WITHDRAWAL_COOLDOWN_MS - elapsed) / 60_000));
          return res.status(429).json({
            error: `Too many failed attempts. Please wait ${remainingMins} minute${remainingMins === 1 ? '' : 's'} before requesting a new withdrawal code.`
          });
        }
        preservedAttempts = 0;
      } else if (existing.expiresAt > now && existing.code) {
        code = existing.code;
        preservedAttempts = existing.attempts;
      }
    }
    withdrawalVerificationCodes.set(caller.id, {
      code,
      expiresAt: expiresAtMs,
      lastResendAt: now,
      attempts: preservedAttempts
    });
  }

  deliverSecurityCode(caller.email, 'WITHDRAWAL', code);

  recordUserEmail({
    id: 'email_' + Date.now() + '_' + randomUUID().slice(0, 8),
    userId: caller.id,
    userEmail: caller.email,
    subject: 'Withdrawal Email Verification Requested',
    snippet: 'Withdrawal verification code dispatched.',
    body: `You requested a withdrawal from your ${SITE_CONFIG.brandName} account. Please use the verification code sent to your registered contact channel to complete the transaction.`,
    date: new Date().toLocaleDateString(),
    read: false,
    type: 'GENERAL'
  });

  res.json({
    success: true,
    message: 'Withdrawal verification code sent to your registered email.',
    codeRequired: true,
    ...(shouldExposeMockCodes() ? { mockCode: code } : {})
  });
});

authRouter.post('/withdrawal/verify-and-execute', requireAuth, requireActiveStatus, requireFinancialActiveStatus, rateLimit(10, 60_000), (req: Request, res: Response) => {
  const caller = (req as any).authenticatedUser;
  if (!canManageAgencyPayouts(caller, SITE_CONFIG.AGENCY_MODE)) {
    return res.status(403).json({ error: 'Forbidden: Only agency administrators and staff can request payouts or withdrawals.' });
  }
  req.body.userId = caller.id;
  return handlePayoutRequest(req, res);
});

// ==========================================
// 9. GOOGLE OAUTH 2.0 LOGIN & REGISTRATION
// ==========================================

function resolveGoogleRedirectUri(req: Request): string {
  const fallbackOrigin = process.env.APP_URL
    ? process.env.APP_URL.trim().replace(/\/+$/, '')
    : `${req.protocol}://${req.get('host')}`;
  const allowedOrigins = new Set<string>();
  try { allowedOrigins.add(new URL(fallbackOrigin).origin); } catch {}
  try { allowedOrigins.add(new URL(`${req.protocol}://${req.get('host')}`).origin); } catch {}
  if (process.env.APP_URL) {
    try { allowedOrigins.add(new URL(process.env.APP_URL.trim()).origin); } catch {}
  }

  let selectedOrigin = fallbackOrigin;
  if (typeof req.query.origin === 'string' && req.query.origin.trim()) {
    try {
      const parsed = new URL(req.query.origin.trim());
      if ((parsed.protocol === 'https:' || parsed.protocol === 'http:') && allowedOrigins.has(parsed.origin)) {
        selectedOrigin = parsed.origin;
      }
    } catch {}
  }
  return `${selectedOrigin.replace(/\/+$/, '')}/auth/callback`;
}

function signOAuthState(payload: { redirectUri: string; deviceId: string; nonce: string; exp: number }): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', resolveJwtSecret()).update(encoded).digest('base64url');
  return `${encoded}.${sig}`;
}

function verifyOAuthState(state: string): { redirectUri: string; deviceId: string; nonce: string; exp: number } | null {
  if (!state || typeof state !== 'string') return null;
  const parts = state.split('.');
  if (parts.length !== 2) return null;
  const [encoded, sig] = parts;
  const expectedSig = createHmac('sha256', resolveJwtSecret()).update(encoded).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf-8'));
    if (!parsed || typeof parsed.exp !== 'number' || parsed.exp <= Date.now()) {
      return null;
    }
    if (typeof parsed.redirectUri !== 'string' || !parsed.redirectUri) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function findOrCreateGoogleUser(params: {
  email: string;
  name?: string;
  picture?: string;
  deviceId?: string;
}): Promise<{ user: User; token: string; isNewUser: boolean }> {
  const normalizedEmail = params.email.trim().toLowerCase();
  if (!isValidEmail(normalizedEmail)) {
    throw new Error('Invalid Google account email address.');
  }

  const deviceId = params.deviceId && params.deviceId.trim() ? params.deviceId.trim() : '';
  let user = await store.getUserByEmail(normalizedEmail);
  let isNewUser = false;

  if (user) {
    if (user.status !== 'active') {
      throw new Error(`Account is ${user.status}.`);
    }
    if (user.role === 'admin' || user.role === 'super_admin') {
      throw new Error('Administrator accounts must sign in through the Admin Portal with 2FA verification.');
    }
    user.emailVerified = true;
    user.verified = true;
    if (params.picture && (!user.avatar || user.avatar.includes('unsplash.com'))) {
      user.avatar = params.picture;
    }
    if (!Array.isArray(user.knownDevices)) {
      user.knownDevices = [];
    }
    if (deviceId && deviceId !== 'dev_default_session' && !user.knownDevices.includes(deviceId)) {
      user.knownDevices.push(deviceId);
    }
    await store.saveUser(user);
  } else {
    const secSettings = siteSettings.getSettings().security;
    if (secSettings && secSettings.allowNewRegistrations === false) {
      throw new Error('New user registrations are currently disabled by platform administration.');
    }

    isNewUser = true;
    const randomPass = randomBytes(24).toString('hex');
    const hashedPassword = await bcrypt.hash(randomPass, 10);
    const newUserId = 'user_' + Date.now() + '_' + randomBytes(3).toString('hex');
    const displayName = (typeof params.name === 'string' && params.name.trim())
      ? params.name.trim().slice(0, 80)
      : normalizedEmail.split('@')[0];

    user = {
      id: newUserId,
      name: displayName,
      email: normalizedEmail,
      role: 'user',
      avatar: params.picture || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=400&h=400&fit=crop',
      title: SITE_CONFIG.AGENCY_MODE ? 'Client' : 'Freelancer / Member',
      rating: 0,
      reviewsCount: 0,
      hourlyRate: 50,
      earned: 0,
      completedJobs: 0,
      bio: `Client on ${SITE_CONFIG.brandName}.`,
      skills: ['General'],
      status: 'active',
      verified: true,
      emailVerified: true,
      mobileVerified: false,
      walletBalance: 0,
      createdAt: new Date().toISOString().substring(0, 10),
      password: hashedPassword,
      sessionVersion: 1,
      activeSessionVersions: [1],
      knownDevices: deviceId && deviceId !== 'dev_default_session' ? [deviceId] : []
    };

    await store.saveUser(user);
    await ensureWallet(newUserId);
  }

  const sessionVersion = await registerNewUserSessionAtomic(user);
  const token = signToken({ id: user.id, role: user.role, email: user.email, sessionVersion });
  return { user, token, isNewUser };
}

authRouter.get('/google/url', (req: Request, res: Response) => {
  const clientId = (process.env.GOOGLE_CLIENT_ID || '').trim();
  const redirectUri = resolveGoogleRedirectUri(req);
  const deviceId = typeof req.query.deviceId === 'string' && req.query.deviceId.trim()
    ? req.query.deviceId.trim()
    : '';

  if (!clientId) {
    return res.json({
      configured: false,
      redirectUri
    });
  }

  const statePayload = signOAuthState({
    redirectUri,
    deviceId,
    nonce: randomBytes(16).toString('hex'),
    exp: Date.now() + 10 * 60 * 1000
  });
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'online',
    prompt: 'select_account',
    state: statePayload
  });

  return res.json({
    configured: true,
    url: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
    redirectUri
  });
});

export async function handleGoogleOAuthCallback(req: Request, res: Response) {
  const defaultRedirectUri = resolveGoogleRedirectUri(req);
  let targetOrigin = '';
  try {
    targetOrigin = new URL(defaultRedirectUri).origin;
  } catch {
    targetOrigin = `${req.protocol}://${req.get('host')}`;
  }

  const sendPopupResult = (payload: Record<string, any>, originOverride?: string) => {
    const serialized = JSON.stringify(payload).replace(/</g, '\\u003c');
    const resolvedOrigin = JSON.stringify(originOverride || targetOrigin);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(`<!DOCTYPE html>
<html>
  <head><title>Google Authentication</title></head>
  <body style="font-family: system-ui, sans-serif; padding: 2rem; text-align: center; color: #0f172a;">
    <script>
      (function() {
        var data = ${serialized};
        var expectedOrigin = ${resolvedOrigin};
        if (window.opener) {
          window.opener.postMessage(data, expectedOrigin);
          window.close();
        } else {
          window.location.href = '/';
        }
      })();
    </script>
    <p>Completing Google sign-in... This window will close automatically.</p>
  </body>
</html>`);
  };

  try {
    const { code, state, error } = req.query;
    if (error) {
      return sendPopupResult({ type: 'OAUTH_AUTH_ERROR', error: String(error) });
    }
    if (!code || typeof code !== 'string') {
      return sendPopupResult({ type: 'OAUTH_AUTH_ERROR', error: 'Missing authorization code from Google.' });
    }
    if (!state || typeof state !== 'string') {
      return sendPopupResult({ type: 'OAUTH_AUTH_ERROR', error: 'Missing OAuth state parameter.' });
    }

    const verifiedState = verifyOAuthState(state);
    if (!verifiedState) {
      return sendPopupResult({ type: 'OAUTH_AUTH_ERROR', error: 'Invalid or expired OAuth state parameter. Please try again.' });
    }

    const redirectUri = verifiedState.redirectUri;
    const deviceId = verifiedState.deviceId || '';
    let stateOrigin = targetOrigin;
    try {
      stateOrigin = new URL(redirectUri).origin;
    } catch {}

    const clientId = (process.env.GOOGLE_CLIENT_ID || '').trim();
    const clientSecret = (process.env.GOOGLE_CLIENT_SECRET || '').trim();
    if (!clientId || !clientSecret) {
      return sendPopupResult({
        type: 'OAUTH_AUTH_ERROR',
        error: 'Google OAuth credentials (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET) are not configured on the server.'
      }, stateOrigin);
    }

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code'
      }).toString()
    });

    const tokenData: any = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.access_token) {
      return sendPopupResult({
        type: 'OAUTH_AUTH_ERROR',
        error: tokenData?.error_description || tokenData?.error || 'Failed to exchange Google authorization code.'
      }, stateOrigin);
    }

    const userRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    const profile: any = await userRes.json();
    const isEmailVerified = profile?.email_verified === true || profile?.email_verified === 'true';
    if (!userRes.ok || !profile?.email || !isEmailVerified) {
      return sendPopupResult({
        type: 'OAUTH_AUTH_ERROR',
        error: 'Your Google account email must be verified to sign in.'
      }, stateOrigin);
    }

    const { user, token, isNewUser } = await findOrCreateGoogleUser({
      email: profile.email,
      name: profile.name,
      picture: profile.picture,
      deviceId
    });

    return sendPopupResult({
      type: 'OAUTH_AUTH_SUCCESS',
      token,
      user: safeUser(user),
      isNewUser
    }, stateOrigin);
  } catch (err: any) {
    return sendPopupResult({
      type: 'OAUTH_AUTH_ERROR',
      error: err?.message || 'Google authentication failed.'
    });
  }
}

authRouter.get(['/google/callback', '/google/callback/'], handleGoogleOAuthCallback);

// Direct Google Sign-In / Registration endpoint (strictly requires verified Google OAuth token)
authRouter.post('/google', rateLimit(20, 60_000, 'auth_google'), async (req: Request, res: Response) => {
  try {
    const clientId = (process.env.GOOGLE_CLIENT_ID || '').trim();
    if (!clientId) {
      return res.status(503).json({ error: 'Google OAuth is not configured on this server.' });
    }

    const { accessToken, idToken } = req.body || {};
    const rawDeviceId = req.body?.deviceId || req.headers['x-device-id'];
    const deviceId = rawDeviceId ? String(rawDeviceId).trim() : '';

    let verifiedEmail = '';
    let verifiedName = '';
    let verifiedPicture = '';

    if (typeof accessToken === 'string' && accessToken.trim()) {
      const tokenInfoRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(accessToken.trim())}`);
      const tokenInfo: any = await tokenInfoRes.json().catch(() => ({}));
      const audMatch = tokenInfo?.aud === clientId || tokenInfo?.azp === clientId;
      if (!tokenInfoRes.ok || !audMatch) {
        return res.status(401).json({ error: 'Google access token audience does not match this application.' });
      }
      const userRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${accessToken.trim()}` }
      });
      const profile: any = await userRes.json();
      const isEmailVerified = profile?.email_verified === true || profile?.email_verified === 'true';
      if (!userRes.ok || !profile?.email || !isEmailVerified) {
        return res.status(401).json({ error: 'Invalid Google access token or unverified email address.' });
      }
      verifiedEmail = profile.email;
      verifiedName = profile.name || '';
      verifiedPicture = profile.picture || '';
    } else if (typeof idToken === 'string' && idToken.trim()) {
      const tokenRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken.trim())}`);
      const payload: any = await tokenRes.json();
      const audMatch = payload?.aud === clientId || payload?.azp === clientId;
      const issMatch = payload?.iss === 'accounts.google.com' || payload?.iss === 'https://accounts.google.com';
      const isEmailVerified = payload?.email_verified === true || payload?.email_verified === 'true';
      if (!tokenRes.ok || !payload?.email || !audMatch || !issMatch || !isEmailVerified) {
        return res.status(401).json({ error: 'Invalid Google ID token or unverified email address.' });
      }
      verifiedEmail = payload.email;
      verifiedName = payload.name || '';
      verifiedPicture = payload.picture || '';
    } else {
      return res.status(400).json({ error: 'A verified Google OAuth token is required.' });
    }

    const { user, token, isNewUser } = await findOrCreateGoogleUser({
      email: verifiedEmail,
      name: verifiedName,
      picture: verifiedPicture,
      deviceId
    });

    return res.json({
      success: true,
      token,
      user: safeUser(user),
      isNewUser
    });
  } catch (err: any) {
    return res.status(400).json({ error: err?.message || 'Google authentication failed.' });
  }
});
