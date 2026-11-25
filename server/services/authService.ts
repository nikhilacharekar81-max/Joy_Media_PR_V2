import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { randomInt, randomUUID } from 'crypto';
import { store } from '../store.js';
import { postgresStore, isPostgresEnabled } from '../db/postgresStore.js';
import {
  signToken,
  safeUser,
  registerNewUserSession,
  registerNewUserSessionAtomic,
  MAX_ACTIVE_SESSIONS,
  IS_PRODUCTION
} from '../middleware/auth.js';
import { disconnectUserSockets } from '../websocket.js';
import {
  deliverSecurityCode,
  deliverAdminCode,
  recordUserEmail
} from './notificationService.js';
import { siteSettings } from '../domains/admin/siteSettings.js';

const LOGIN_LOCKOUT_WINDOW_MS = 15 * 60 * 1000;
const inMemoryLoginAttempts = new Map<string, { attempts: number; expiresAt: number }>();

export interface VerificationRecord {
  code: string;
  expiresAt: number;
  lastResendAt: number;
  attempts: number;
  verified?: boolean;
}

export const emailVerificationCodes = new Map<string, VerificationRecord>();
export const smsVerificationCodes = new Map<string, VerificationRecord>();
export const forgotPasswordCodes = new Map<string, VerificationRecord>();
export const withdrawalVerificationCodes = new Map<string, VerificationRecord>();

export function generate6DigitCode(): string {
  return randomInt(100000, 1000000).toString();
}

import { shouldExposeMockCodes } from './mockCodeHelper.js';

export function mockCode(key: string, code: string): Record<string, string> {
  return shouldExposeMockCodes() ? { [key]: code } : {};
}

const USER_DEVICE_VERIFICATION = process.env.USER_DEVICE_VERIFICATION === 'true';

export function isValidEmail(v: string): boolean {
  return v.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

export function isValidMobile(v: string): boolean {
  return /^\+?[0-9][0-9\s\-()]{6,18}$/.test(v);
}

export const WITHDRAWAL_MAX_ATTEMPTS = 3;
export const WITHDRAWAL_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

export async function verifyAndConsumeWithdrawalCode(
  userId: string,
  code: unknown,
  externalClient?: any
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  if (!code || typeof code !== 'string' || !code.trim()) {
    return { ok: false, status: 400, error: 'Email verification code is required for withdrawal. Please request a code first via /api/auth/withdrawal/request-code.' };
  }
  const trimmedCode = code.trim();
  const now = Date.now();

  if (isPostgresEnabled()) {
    const runVerification = async (client: any): Promise<{ ok: true } | { ok: false; status: number; error: string }> => {
      const res = await client.query(
        `SELECT * FROM auth_verification_codes
         WHERE (email = $1 OR email = (SELECT LOWER(email) FROM users WHERE id = $1 LIMIT 1))
           AND type = 'withdrawal'
         FOR UPDATE`,
        [userId]
      );
      if (res.rows.length === 0) {
        return { ok: false, status: 400, error: 'No active withdrawal verification code found. Please request a new code via /api/auth/withdrawal/request-code.' };
      }
      const row = res.rows[0];
      const currentAttempts = Number(row.attempts || 0);
      const lastTimestamp = Number(row.last_resend_at || 0);

      if (currentAttempts >= WITHDRAWAL_MAX_ATTEMPTS) {
        const elapsed = now - lastTimestamp;
        if (elapsed < WITHDRAWAL_COOLDOWN_MS) {
          const remainingMins = Math.max(1, Math.ceil((WITHDRAWAL_COOLDOWN_MS - elapsed) / 60_000));
          return {
            ok: false,
            status: 429,
            error: `Too many failed attempts. Please wait ${remainingMins} minute${remainingMins === 1 ? '' : 's'} before trying again.`
          };
        }
        await client.query(`DELETE FROM auth_verification_codes WHERE email = $1 AND type = 'withdrawal'`, [row.email]);
        return { ok: false, status: 400, error: 'Withdrawal verification code has expired. Please request a new code.' };
      }

      if (new Date(now) > new Date(row.expires_at)) {
        await client.query(`DELETE FROM auth_verification_codes WHERE email = $1 AND type = 'withdrawal'`, [row.email]);
        return { ok: false, status: 400, error: 'Withdrawal verification code has expired. Please request a new code.' };
      }

      if (row.code !== trimmedCode) {
        const nextAttempts = currentAttempts + 1;
        const cooldownStart = nextAttempts >= WITHDRAWAL_MAX_ATTEMPTS ? now : lastTimestamp;
        await client.query(
          `UPDATE auth_verification_codes SET attempts = $1, last_resend_at = $2 WHERE email = $3 AND type = 'withdrawal'`,
          [nextAttempts, cooldownStart, row.email]
        );
        if (nextAttempts >= WITHDRAWAL_MAX_ATTEMPTS) {
          return {
            ok: false,
            status: 429,
            error: 'Too many failed attempts (3 maximum). Please wait 10 minutes before trying again.'
          };
        }
        const remaining = WITHDRAWAL_MAX_ATTEMPTS - nextAttempts;
        return {
          ok: false,
          status: 400,
          error: `Invalid verification code. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`
        };
      }

      await client.query(`DELETE FROM auth_verification_codes WHERE email = $1 AND type = 'withdrawal'`, [row.email]);
      return { ok: true };
    };

    if (externalClient) {
      return runVerification(externalClient);
    }
    return postgresStore.executeInTransaction(runVerification);
  }

  if (IS_PRODUCTION) {
    return { ok: false, status: 500, error: 'Security verification requires PostgreSQL database in production.' };
  }

  const record = withdrawalVerificationCodes.get(userId);
  if (!record) {
    return { ok: false, status: 400, error: 'No active withdrawal verification code found. Please request a new code via /api/auth/withdrawal/request-code.' };
  }
  if (record.attempts >= WITHDRAWAL_MAX_ATTEMPTS) {
    const elapsed = now - record.lastResendAt;
    if (elapsed < WITHDRAWAL_COOLDOWN_MS) {
      const remainingMins = Math.max(1, Math.ceil((WITHDRAWAL_COOLDOWN_MS - elapsed) / 60_000));
      return {
        ok: false,
        status: 429,
        error: `Too many failed attempts. Please wait ${remainingMins} minute${remainingMins === 1 ? '' : 's'} before trying again.`
      };
    }
    withdrawalVerificationCodes.delete(userId);
    return { ok: false, status: 400, error: 'Withdrawal verification code has expired. Please request a new code.' };
  }
  if (now > record.expiresAt) {
    withdrawalVerificationCodes.delete(userId);
    return { ok: false, status: 400, error: 'Withdrawal verification code has expired. Please request a new code.' };
  }
  if (record.code !== trimmedCode) {
    record.attempts++;
    if (record.attempts >= WITHDRAWAL_MAX_ATTEMPTS) {
      record.lastResendAt = now;
      return {
        ok: false,
        status: 429,
        error: 'Too many failed attempts (3 maximum). Please wait 10 minutes before trying again.'
      };
    }
    const remaining = WITHDRAWAL_MAX_ATTEMPTS - record.attempts;
    return {
      ok: false,
      status: 400,
      error: `Invalid verification code. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`
    };
  }
  withdrawalVerificationCodes.delete(userId);
  return { ok: true };
}

export async function checkRecoveryCodeAsync(query: string, code: unknown, markVerified = false): Promise<'ok' | 'invalid' | 'locked'> {
  const queryEmail = query.toLowerCase().trim();
  const trimmedCode = typeof code === 'string' || typeof code === 'number' ? String(code).trim() : '';

  if (isPostgresEnabled()) {
    return postgresStore.executeInTransaction(async (client) => {
      const res = await client.query(
        `SELECT * FROM auth_verification_codes WHERE email = $1 AND (type = 'password_reset' OR type = 'reset') FOR UPDATE`,
        [queryEmail]
      );
      if (res.rows.length === 0) return 'invalid';
      const row = res.rows[0];
      if (new Date() > new Date(row.expires_at)) {
        await client.query(`DELETE FROM auth_verification_codes WHERE email = $1 AND (type = 'password_reset' OR type = 'reset')`, [queryEmail]);
        return 'invalid';
      }
      if (Number(row.attempts || 0) >= 5) {
        await client.query(`DELETE FROM auth_verification_codes WHERE email = $1 AND (type = 'password_reset' OR type = 'reset')`, [queryEmail]);
        return 'locked';
      }
      if (row.code !== trimmedCode) {
        await client.query(
          `UPDATE auth_verification_codes SET attempts = attempts + 1 WHERE email = $1 AND (type = 'password_reset' OR type = 'reset')`,
          [queryEmail]
        );
        return 'invalid';
      }
      if (markVerified) {
        await client.query(
          `UPDATE auth_verification_codes SET attempts = 0 WHERE email = $1 AND (type = 'password_reset' OR type = 'reset')`,
          [queryEmail]
        );
      }
      return 'ok';
    });
  }

  if (IS_PRODUCTION) {
    return 'invalid';
  }

  const record = forgotPasswordCodes.get(query);
  if (!record || Date.now() > record.expiresAt) return 'invalid';
  if (record.attempts >= 5) {
    forgotPasswordCodes.delete(query);
    return 'locked';
  }
  if (!trimmedCode) return 'invalid';
  if (record.code !== trimmedCode) {
    record.attempts++;
    return 'invalid';
  }
  if (markVerified) record.verified = true;
  return 'ok';
}

export function checkRecoveryCode(query: string, code: unknown, markVerified = false): 'ok' | 'invalid' | 'locked' {
  if (IS_PRODUCTION) return 'invalid';
  const record = forgotPasswordCodes.get(query);
  if (!record || Date.now() > record.expiresAt) return 'invalid';
  if (record.attempts >= 5) {
    forgotPasswordCodes.delete(query);
    return 'locked';
  }
  if (typeof code !== 'string' && typeof code !== 'number') return 'invalid';
  if (record.code !== String(code).trim()) {
    record.attempts++;
    return 'invalid';
  }
  if (markVerified) record.verified = true;
  return 'ok';
}

export async function handleLogin(req: Request, res: Response) {
  const clientIp = (req.ip || req.socket.remoteAddress || 'unknown-client').toString().trim();
  const { email, password, userId, code, verificationCode, emailCode } = req.body || {};
  const lookupEmail = typeof email === 'string' && email.trim() ? email.trim().toLowerCase() : null;
  const lookupId = typeof userId === 'string' && userId.trim() ? userId.trim() : null;
  const maxFailedAttempts = Math.max(
    3,
    Number(siteSettings.getSettings()?.security?.maxFailedLoginsLockout || 5)
  );

  if (!lookupEmail && !lookupId) {
    return res.status(401).json({ error: 'Email is required for login.' });
  }

  if (typeof password !== 'string' || !password.trim()) {
    return res.status(401).json({ error: 'Password is required.' });
  }

  let user: any = null;
  if (lookupEmail) {
    user = await store.getUserByEmail(lookupEmail);
  } else if (lookupId) {
    user = await store.getUser(lookupId);
  }

  // Scope lockout by canonical (user.id, clientIp) so attackers cannot alternate email/userId
  // to bypass throttling AND cannot DoS an admin/user account from a different IP address.
  const canonicalTarget = user?.id || lookupEmail || lookupId || 'unknown';
  const lockoutKey = `login:${canonicalTarget}:${clientIp}`;

  async function isLockedOut(): Promise<boolean> {
    const now = Date.now();
    if (isPostgresEnabled()) {
      try {
        const pool = postgresStore.getPool();
        const resRow = await pool.query(
          `SELECT attempts, expires_at FROM auth_verification_codes WHERE email = $1 AND type = 'login_attempts'`,
          [lockoutKey]
        );
        if (resRow.rows.length > 0) {
          const row = resRow.rows[0];
          const expMs = new Date(row.expires_at).getTime();
          if (expMs > now && Number(row.attempts || 0) >= maxFailedAttempts) {
            return true;
          }
          if (expMs <= now) {
            await pool.query(
              `DELETE FROM auth_verification_codes WHERE email = $1 AND type = 'login_attempts'`,
              [lockoutKey]
            );
          }
        }
      } catch (err) {
        console.warn('[Auth] Failed to check login lockout:', err);
      }
    }
    const mem = inMemoryLoginAttempts.get(lockoutKey);
    if (mem) {
      if (mem.expiresAt > now && mem.attempts >= maxFailedAttempts) return true;
      if (mem.expiresAt <= now) inMemoryLoginAttempts.delete(lockoutKey);
    }
    return false;
  }

  async function recordFailedLogin() {
    const now = Date.now();
    const expiresAtMs = now + LOGIN_LOCKOUT_WINDOW_MS;
    if (isPostgresEnabled()) {
      try {
        const pool = postgresStore.getPool();
        await pool.query(
          `INSERT INTO auth_verification_codes (email, code, type, attempts, last_resend_at, expires_at, created_at)
           VALUES ($1, '0', 'login_attempts', 1, $2, $3, NOW())
           ON CONFLICT (email, type) DO UPDATE SET
             attempts = CASE
               WHEN auth_verification_codes.expires_at <= NOW() THEN 1
               ELSE auth_verification_codes.attempts + 1
             END,
             last_resend_at = $2,
             expires_at = $3`,
          [lockoutKey, now, new Date(expiresAtMs)]
        );
      } catch (err) {
        console.warn('[Auth] Failed to record failed login audit event:', err);
      }
    }
    const existing = inMemoryLoginAttempts.get(lockoutKey);
    if (!existing || existing.expiresAt <= now) {
      inMemoryLoginAttempts.set(lockoutKey, { attempts: 1, expiresAt: expiresAtMs });
    } else {
      existing.attempts += 1;
      existing.expiresAt = expiresAtMs;
    }
    if (inMemoryLoginAttempts.size > 5000) {
      const oldestKey = inMemoryLoginAttempts.keys().next().value;
      if (oldestKey) inMemoryLoginAttempts.delete(oldestKey);
    }
  }

  if (await isLockedOut()) {
    return res.status(429).json({
      error: 'Too many failed login attempts from this IP. Please try again in 15 minutes.'
    });
  }

  if (!user) {
    await recordFailedLogin();
    return res.status(401).json({ error: 'Invalid email or password.' });
  }

  const passwordMatch = typeof user.password === 'string' && user.password.length > 0 && (await bcrypt.compare(password, user.password));
  if (!passwordMatch) {
    await recordFailedLogin();
    return res.status(401).json({ error: 'Invalid email or password.' });
  }

  if (user.status !== 'active') {
    return res.status(403).json({ error: `Account is ${user.status}.` });
  }

  if (!user.emailVerified) {
    const userEmailKey = (user.email || lookupEmail || user.id).toLowerCase();
    const newCode = generate6DigitCode();
    const expiresAtMs = Date.now() + 30 * 60 * 1000;
    if (isPostgresEnabled()) {
      try {
        await postgresStore.getPool().query(
          `INSERT INTO auth_verification_codes (email, code, type, attempts, last_resend_at, expires_at, created_at)
           VALUES ($1, $2, 'verify', 0, $3, $4, NOW())
           ON CONFLICT (email, type) DO UPDATE SET code = $2, attempts = 0, last_resend_at = $3, expires_at = $4, created_at = NOW()`,
          [userEmailKey, newCode, Date.now(), new Date(expiresAtMs)]
        );
      } catch (err) {
        console.error('[Auth] Failed to persist login verification code for unverified account:', err);
      }
    } else {
      emailVerificationCodes.set(userEmailKey, {
        code: newCode,
        expiresAt: expiresAtMs,
        lastResendAt: Date.now(),
        attempts: 0
      });
    }

    deliverSecurityCode(user.email, 'SIGNUP_EMAIL', newCode);

    return res.status(403).json({
      error: 'Email address has not been verified. Please verify your email before logging in.',
      requiresVerification: true,
      email: user.email,
      ...(shouldExposeMockCodes() ? { mockCode: newCode, mockEmailCode: newCode } : {})
    });
  }

  const rawDeviceId = req.body?.deviceId || req.headers['x-device-id'];
  const deviceId = rawDeviceId ? String(rawDeviceId).trim() : 'dev_default_session';

  if (!user.knownDevices || !Array.isArray(user.knownDevices)) {
    user.knownDevices = [];
  }

  const isAdminRole = user.role === 'admin' || user.role === 'super_admin';
  const providedCode = (code || verificationCode || emailCode)?.toString().trim();
  const isPlaceholderDevice = deviceId === 'dev_default_session' || deviceId === 'unknown';
  const trustedDevice = user.knownDevices.includes(deviceId) && !(isAdminRole && isPlaceholderDevice);
  const devBypass = !IS_PRODUCTION && !isAdminRole && (isPlaceholderDevice || Boolean(req.body?.skipDeviceVerification));
  const requiresVerification = isAdminRole
    ? !trustedDevice
    : (USER_DEVICE_VERIFICATION && !trustedDevice && !devBypass);

  if (requiresVerification) {
    const userEmailKey = (user.email || lookupEmail || user.id).toLowerCase();
    const memLogin2faKey = `login_2fa:${userEmailKey}`;

    if (!providedCode) {
      const newCode = generate6DigitCode();
      const expiresAtMs = Date.now() + 30 * 60 * 1000;
      if (isPostgresEnabled()) {
        try {
          await postgresStore.getPool().query(
            `INSERT INTO auth_verification_codes (email, code, type, attempts, last_resend_at, expires_at, created_at)
             VALUES ($1, $2, 'login_2fa', 0, $3, $4, NOW())
             ON CONFLICT (email, type) DO UPDATE SET code = $2, attempts = 0, last_resend_at = $3, expires_at = $4, created_at = NOW()`,
            [userEmailKey, newCode, Date.now(), new Date(expiresAtMs)]
          );
        } catch (err) {
          console.error('[Auth] Failed to persist login verification code:', err);
          return res.status(500).json({ error: 'Failed to generate security verification code.' });
        }
      } else {
        emailVerificationCodes.set(memLogin2faKey, {
          code: newCode,
          expiresAt: expiresAtMs,
          lastResendAt: Date.now(),
          attempts: 0
        });
      }

      deliverSecurityCode(user.email, isAdminRole ? 'ADMIN_2FA' : 'DEVICE_LOGIN', newCode);

      recordUserEmail({
        id: 'email_' + Date.now() + '_' + randomUUID().slice(0, 8),
        userId: user.id,
        userEmail: user.email,
        subject: isAdminRole ? 'Admin Login Security Notice' : 'New Device Login Security Notice',
        snippet: 'Security verification code dispatched.',
        body: isAdminRole
          ? 'An administrator login attempt was initiated. Please enter the verification code sent to your registered admin contact channel to access the Admin Dashboard.'
          : `A login attempt from a new device (${deviceId}) was detected. Please enter the verification code sent to your registered contact channel.`,
        date: new Date().toLocaleDateString(),
        read: false,
        type: 'GENERAL'
      });

      return res.status(200).json({
        requiresVerification: true,
        requireCode: true,
        message: isAdminRole
          ? 'Admin login requires an email verification code. Code sent to your registered admin email.'
          : 'New device detected. Please provide the email verification code sent to your email.',
        deviceId,
        ...(shouldExposeMockCodes() ? { mockCode: newCode, mockEmailCode: newCode } : {})
      });
    }

    if (isPostgresEnabled()) {
      const codeCheckErr = await postgresStore.executeInTransaction(async (client) => {
        const codeRes = await client.query(
          `SELECT * FROM auth_verification_codes WHERE email = $1 AND type = 'login_2fa' FOR UPDATE`,
          [userEmailKey]
        );
        if (codeRes.rows.length === 0) {
          return { status: 400, error: 'Invalid or expired email verification code.' };
        }
        const row = codeRes.rows[0];
        if (new Date() > new Date(row.expires_at)) {
          await client.query(`DELETE FROM auth_verification_codes WHERE email = $1 AND type = 'login_2fa'`, [userEmailKey]);
          return { status: 400, error: 'Invalid or expired email verification code.' };
        }
        if (Number(row.attempts || 0) >= 5) {
          await client.query(`DELETE FROM auth_verification_codes WHERE email = $1 AND type = 'login_2fa'`, [userEmailKey]);
          return { status: 429, error: 'Too many failed attempts. Please log in again to receive a new code.' };
        }
        if (row.code !== providedCode) {
          const upd = await client.query(
            `UPDATE auth_verification_codes SET attempts = attempts + 1 WHERE email = $1 AND type = 'login_2fa' RETURNING attempts`,
            [userEmailKey]
          );
          if (Number(upd.rows[0]?.attempts || 0) >= 5) {
            await client.query(`DELETE FROM auth_verification_codes WHERE email = $1 AND type = 'login_2fa'`, [userEmailKey]);
            return { status: 429, error: 'Too many failed attempts. Please log in again to receive a new code.' };
          }
          return { status: 400, error: 'Invalid or expired email verification code.' };
        }
        await client.query(`DELETE FROM auth_verification_codes WHERE email = $1 AND type = 'login_2fa'`, [userEmailKey]);
        return null;
      });

      if (codeCheckErr) {
        await recordFailedLogin();
        return res.status(codeCheckErr.status).json({ error: codeCheckErr.error });
      }
    } else {
      if (IS_PRODUCTION) {
        return res.status(500).json({ error: 'Security verification requires database connection in production.' });
      }
      const record = emailVerificationCodes.get(memLogin2faKey);
      if (!record || Date.now() > record.expiresAt) {
        await recordFailedLogin();
        return res.status(400).json({ error: 'Invalid or expired email verification code.' });
      }
      if (record.attempts >= 5) {
        emailVerificationCodes.delete(memLogin2faKey);
        return res.status(429).json({ error: 'Too many failed attempts. Please log in again to receive a new code.' });
      }
      if (record.code !== providedCode) {
        record.attempts++;
        await recordFailedLogin();
        return res.status(400).json({ error: 'Invalid or expired email verification code.' });
      }
      emailVerificationCodes.delete(memLogin2faKey);
    }

    if (!user.knownDevices.includes(deviceId)) {
      user.knownDevices.push(deviceId);
      if (user.knownDevices.length > 10) user.knownDevices.shift();
    }
  }

  inMemoryLoginAttempts.delete(lockoutKey);
  if (user.id) inMemoryLoginAttempts.delete(`login:${user.id}:${clientIp}`);
  if (isPostgresEnabled()) {
    try {
      const targets = Array.from(new Set([lockoutKey, `login:${user.id}:${clientIp}`]));
      await postgresStore.getPool().query(
        `DELETE FROM auth_verification_codes WHERE email = ANY($1::text[]) AND type = 'login_attempts'`,
        [targets]
      );
    } catch {}
  }

  let sessionVersion: number;
  try {
    sessionVersion = await registerNewUserSessionAtomic(user);
  } catch (err: any) {
    return res.status(500).json({ error: 'Failed to persist login session.' });
  }

  const token = signToken({ id: user.id, role: user.role, email: user.email, sessionVersion });
  return res.json({
    success: true,
    token,
    user: safeUser(user)
  });
}
