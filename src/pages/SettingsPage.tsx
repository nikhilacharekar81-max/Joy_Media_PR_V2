import React, { useState, useEffect } from 'react';
import { UserAccount } from '../types';
import { Check, AlertCircle, Sparkles, CreditCard } from 'lucide-react';
import { fetchWithRetry } from '../utils/fetchRetry';
import { setAuthToken } from '../utils/authToken';
import { SITE_CONFIG } from '../siteConfig';

interface SettingsPageProps {
  currentUser: UserAccount | null;
  updateCurrentUser: (u: UserAccount | null | ((prev: UserAccount | null) => UserAccount | null)) => void;
  navigate: (to: string, e?: React.MouseEvent) => void;
}

export const SettingsPage: React.FC<SettingsPageProps> = ({
  currentUser,
  updateCurrentUser,
  navigate
}) => {
  const [activeTab, setActiveTab] = useState<'general' | 'notifications' | 'payments' | 'availability'>('general');

  // Editable row states
  const [editingField, setEditingField] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  // Email change (two-step OTP verification)
  const [emailInput, setEmailInput] = useState(currentUser?.email || '');
  const [emailCurrentPassword, setEmailCurrentPassword] = useState('');
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);
  const [emailOtpInput, setEmailOtpInput] = useState('');
  const [emailMockCode, setEmailMockCode] = useState<string | null>(null);

  // Password change (requires current password)
  const [passwordCurrentInput, setPasswordCurrentInput] = useState('');
  const [newPasswordInput, setNewPasswordInput] = useState('');
  const [confirmPasswordInput, setConfirmPasswordInput] = useState('');

  // Notification states
  const [emailNotifs, setEmailNotifs] = useState(currentUser?.notificationPreferences?.emailNotifications || 'Instant alerts for all messages');
  const [smsNotifs, setSmsNotifs] = useState(() => {
    if (currentUser?.notificationPreferences?.smsNotifications) {
      return currentUser.notificationPreferences.smsNotifications;
    }
    return currentUser?.mobile ? `Enabled (${currentUser.mobile})` : 'Disabled';
  });
  const [marketingNotifs, setMarketingNotifs] = useState(currentUser?.notificationPreferences?.marketingNotifs || 'Subscribed');

  // Availability states
  const [availableStatus, setAvailableStatus] = useState(currentUser?.isAvailableNow ? 'Active' : 'Inactive');

  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const showToast = (message: string, type: 'success' | 'error' = 'success') => {
    setToast({ type, message });
    setTimeout(() => setToast(null), 4000);
  };

  useEffect(() => {
    if (currentUser?.email) {
      setEmailInput(currentUser.email);
    }
    if (currentUser) {
      setAvailableStatus(currentUser.isAvailableNow ? 'Active' : 'Inactive');
      fetchWithRetry('/api/users/notification-preferences')
        .then(res => res.ok ? res.json() : null)
        .then(data => {
          if (data) {
            if (data.emailNotifications) setEmailNotifs(data.emailNotifications);
            if (data.smsNotifications) setSmsNotifs(data.smsNotifications);
            if (data.marketingNotifs) setMarketingNotifs(data.marketingNotifs);
          }
        })
        .catch(err => console.error('Failed to load notification preferences:', err));
    }
  }, [currentUser?.id, currentUser?.email]);

  if (!currentUser) {
    return (
      <div className="min-h-screen bg-[#f5f7fa] flex items-center justify-center p-6 font-sans">
        <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-8 max-w-md w-full text-center space-y-4">
          <h1 className="text-xl font-bold text-slate-900">Sign in to view settings</h1>
          <p className="text-sm text-slate-600">
            Please sign in to manage your account email, password, notifications, and availability preferences.
          </p>
          <button
            type="button"
            onClick={(e) => navigate('/services', e)}
            className="px-5 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-bold rounded-xl transition cursor-pointer"
          >
            Back to Services
          </button>
        </div>
      </div>
    );
  }

  const profileUrl = currentUser.username
    ? `${SITE_CONFIG.domain}/${currentUser.username}`
    : `${SITE_CONFIG.domain}/profile/${currentUser.id}`;

  const handleSaveNotificationPref = async (key: string, value: string) => {
    setEditingField(null);
    try {
      const res = await fetchWithRetry('/api/users/notification-preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [key]: value })
      });
      if (res.ok) {
        const data = await res.json();
        if (data.notificationPreferences) {
          updateCurrentUser((prev) => prev ? {
            ...prev,
            notificationPreferences: {
              ...(prev.notificationPreferences || {}),
              ...data.notificationPreferences
            }
          } : null);
        }
        showToast('Notification preferences saved.');
      } else {
        const errData = await res.json().catch(() => ({}));
        showToast(errData.error || 'Failed to save preferences.', 'error');
      }
    } catch (err) {
      console.error('Error saving notification preferences:', err);
      showToast('Network error saving preferences.', 'error');
    }
  };

  const handleRequestEmailChange = async () => {
    const trimmedEmail = emailInput.trim().toLowerCase();
    if (!trimmedEmail || !trimmedEmail.includes('@')) {
      showToast('Please enter a valid email address.', 'error');
      return;
    }
    if (trimmedEmail === (currentUser.email || '').toLowerCase()) {
      setEditingField(null);
      return;
    }
    if (!emailCurrentPassword) {
      showToast('Please enter your current password to change your email.', 'error');
      return;
    }
    setIsSaving(true);
    try {
      const res = await fetchWithRetry('/api/users/email', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: trimmedEmail, currentPassword: emailCurrentPassword })
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.pendingVerification) {
        setPendingEmail(data.pendingEmail || trimmedEmail);
        setEmailMockCode(data.mockCode || null);
        setEmailOtpInput('');
        showToast(data.message || 'Verification code sent to your new email address.');
      } else if (res.ok) {
        if (data.user) updateCurrentUser(data.user);
        setEditingField(null);
        setEmailCurrentPassword('');
        showToast(data.message || 'Email address updated.');
      } else {
        showToast(data.error || 'Failed to request email change.', 'error');
      }
    } catch (err) {
      console.error('Failed to initiate email change:', err);
      showToast('Network error updating email address.', 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const handleConfirmEmailChange = async () => {
    if (!pendingEmail || !emailOtpInput.trim()) {
      showToast('Please enter the 6-digit verification code.', 'error');
      return;
    }
    setIsSaving(true);
    try {
      const res = await fetchWithRetry('/api/users/email/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: pendingEmail, code: emailOtpInput.trim() })
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        if (data.token) setAuthToken(data.token);
        if (data.user) updateCurrentUser(data.user);
        setEmailInput(data.user?.email || pendingEmail);
        setPendingEmail(null);
        setEmailOtpInput('');
        setEmailMockCode(null);
        setEmailCurrentPassword('');
        setEditingField(null);
        showToast('Email address verified and updated!');
      } else {
        showToast(data.error || 'Invalid or expired verification code.', 'error');
      }
    } catch (err) {
      console.error('Failed to confirm email change:', err);
      showToast('Network error verifying email change.', 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const handleSavePassword = async () => {
    if (!passwordCurrentInput) {
      showToast('Please enter your current password.', 'error');
      return;
    }
    if (newPasswordInput.length < 6) {
      showToast('New password must be at least 6 characters long.', 'error');
      return;
    }
    if (newPasswordInput !== confirmPasswordInput) {
      showToast('New password and confirmation do not match.', 'error');
      return;
    }
    setIsSaving(true);
    try {
      const res = await fetchWithRetry(`/api/users/${currentUser.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          currentPassword: passwordCurrentInput,
          password: newPasswordInput
        })
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        if (data.token) setAuthToken(data.token);
        setPasswordCurrentInput('');
        setNewPasswordInput('');
        setConfirmPasswordInput('');
        setEditingField(null);
        showToast('Password updated and active sessions refreshed.');
      } else {
        showToast(data.error || 'Failed to update password.', 'error');
      }
    } catch (err) {
      console.error('Failed to update password:', err);
      showToast('Network error updating password.', 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const accountStatusLabel = (currentUser.status || 'active').toUpperCase();
  const isAccountActive = (currentUser.status || 'active').toLowerCase() === 'active';

  return (
    <div className="min-h-screen bg-[#f5f7fa] font-sans text-slate-800 py-8 px-4 sm:px-6 lg:px-8">
      {/* Toast Notification */}
      {toast && (
        <div
          role="status"
          className={`fixed top-20 right-6 z-50 text-xs font-bold px-4 py-3 rounded-xl shadow-2xl border flex items-center gap-2 ${
            toast.type === 'error'
              ? 'bg-rose-950 text-white border-rose-800'
              : 'bg-slate-900 text-white border-slate-800'
          }`}
        >
          {toast.type === 'error' ? (
            <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
          ) : (
            <Check className="w-4 h-4 text-emerald-400 shrink-0" />
          )}
          <span>{toast.message}</span>
        </div>
      )}

      <div className="max-w-5xl mx-auto space-y-6">
        {/* Main Title */}
        <div>
          <h1 className="text-3xl font-bold text-slate-800 tracking-tight">Settings</h1>
        </div>

        {/* Navigation Tabs Bar */}
        <div className="bg-[#eef2f6] rounded-xl p-1 flex items-center gap-1 border border-slate-200/60 overflow-x-auto text-sm font-medium">
          <button
            type="button"
            onClick={() => setActiveTab('general')}
            className={`px-6 py-2.5 rounded-lg transition-colors cursor-pointer whitespace-nowrap ${
              activeTab === 'general' ? 'bg-white text-slate-900 font-bold shadow-xs' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            General
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('notifications')}
            className={`px-6 py-2.5 rounded-lg transition-colors cursor-pointer whitespace-nowrap ${
              activeTab === 'notifications' ? 'bg-white text-slate-900 font-bold shadow-xs' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Notifications
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('payments')}
            className={`px-6 py-2.5 rounded-lg transition-colors cursor-pointer whitespace-nowrap ${
              activeTab === 'payments' ? 'bg-white text-slate-900 font-bold shadow-xs' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Billing &amp; Payments
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('availability')}
            className={`px-6 py-2.5 rounded-lg transition-colors cursor-pointer whitespace-nowrap ${
              activeTab === 'availability' ? 'bg-white text-slate-900 font-bold shadow-xs' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Availability
          </button>
        </div>

        {/* Tab Content Cards */}
        <div className="bg-white border border-slate-200/80 rounded-xl shadow-xs overflow-hidden divide-y divide-slate-100">
          {/* GENERAL TAB */}
          {activeTab === 'general' && (
            <>
              {/* Row 0: Public Profile Webpage */}
              <div className="p-5 sm:px-8 flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-emerald-50/40 hover:bg-emerald-50/70 transition-colors border-b border-slate-100">
                <div className="w-full sm:w-1/3 text-sm font-bold text-slate-800">
                  Public Profile Webpage
                </div>
                <div className="w-full sm:w-1/2 text-xs text-slate-600 font-normal">
                  Customize title, bio, portfolio items, languages, and skills on your dedicated edit profile webpage.
                </div>
                <div className="w-full sm:w-1/6 text-left sm:text-right">
                  <button
                    type="button"
                    onClick={(e) => navigate('/edit-profile', e)}
                    className="px-3.5 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold rounded-lg shadow-2xs transition cursor-pointer"
                  >
                    Edit Profile
                  </button>
                </div>
              </div>

              {/* Row 1: Profile URL (read-only) */}
              <div className="p-5 sm:px-8 flex flex-col sm:flex-row sm:items-center justify-between gap-4 hover:bg-slate-50/50 transition-colors">
                <div className="w-full sm:w-1/3 text-sm font-semibold text-slate-800">
                  Profile URL
                </div>
                <div className="w-full sm:w-1/2 text-sm text-slate-600 font-normal break-all">
                  {profileUrl}
                </div>
                <div className="w-full sm:w-1/6 text-left sm:text-right">
                  <span className="text-xs text-slate-400 font-medium">Managed</span>
                </div>
              </div>

              {/* Row 2: Email (two-step OTP verified) */}
              <div className="p-5 sm:px-8 flex flex-col sm:flex-row sm:items-start justify-between gap-4 hover:bg-slate-50/50 transition-colors">
                <div className="w-full sm:w-1/3 text-sm font-semibold text-slate-800 pt-1">
                  Email
                </div>
                <div className="w-full sm:w-1/2 text-sm text-slate-600 font-normal">
                  {editingField === 'email' ? (
                    pendingEmail ? (
                      <div className="space-y-2.5">
                        <p className="text-xs text-slate-600">
                          Enter the 6-digit verification code sent to <strong className="text-slate-900">{pendingEmail}</strong>.
                        </p>
                        {emailMockCode && (
                          <div className="p-2 bg-amber-50 border border-amber-200 rounded-lg text-amber-900 text-xs flex items-center justify-between gap-2">
                            <span className="flex items-center gap-1.5 font-semibold">
                              <Sparkles className="w-3.5 h-3.5 text-amber-600 shrink-0" />
                              Test code: {emailMockCode}
                            </span>
                            <button
                              type="button"
                              onClick={() => setEmailOtpInput(emailMockCode)}
                              className="px-2 py-0.5 bg-amber-600 text-white rounded text-[11px] font-bold cursor-pointer"
                            >
                              Fill
                            </button>
                          </div>
                        )}
                        <input
                          type="text"
                          maxLength={6}
                          placeholder="6-digit code"
                          value={emailOtpInput}
                          onChange={(e) => setEmailOtpInput(e.target.value)}
                          className="px-3 py-1.5 border border-slate-300 rounded-lg text-xs font-mono tracking-widest w-full focus:outline-emerald-500"
                        />
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            disabled={isSaving}
                            onClick={handleConfirmEmailChange}
                            className="px-3 py-1.5 bg-emerald-600 text-white rounded-lg text-xs font-bold hover:bg-emerald-700 disabled:opacity-50 cursor-pointer"
                          >
                            {isSaving ? 'Verifying...' : 'Confirm Email'}
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setPendingEmail(null);
                              setEmailOtpInput('');
                              setEmailMockCode(null);
                            }}
                            className="px-2.5 py-1.5 text-slate-500 hover:text-slate-800 text-xs font-semibold cursor-pointer"
                          >
                            Back
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-2.5">
                        <input
                          type="email"
                          placeholder="New email address"
                          value={emailInput}
                          onChange={(e) => setEmailInput(e.target.value)}
                          className="px-3 py-1.5 border border-slate-300 rounded-lg text-xs w-full focus:outline-emerald-500"
                        />
                        <input
                          type="password"
                          placeholder="Confirm current password"
                          value={emailCurrentPassword}
                          onChange={(e) => setEmailCurrentPassword(e.target.value)}
                          className="px-3 py-1.5 border border-slate-300 rounded-lg text-xs w-full focus:outline-emerald-500"
                        />
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            disabled={isSaving}
                            onClick={handleRequestEmailChange}
                            className="px-3 py-1.5 bg-emerald-600 text-white rounded-lg text-xs font-bold hover:bg-emerald-700 disabled:opacity-50 cursor-pointer"
                          >
                            {isSaving ? 'Sending Code...' : 'Send Verification Code'}
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setEditingField(null);
                              setEmailInput(currentUser.email || '');
                              setEmailCurrentPassword('');
                            }}
                            className="px-2.5 py-1.5 text-slate-500 hover:text-slate-800 text-xs font-semibold cursor-pointer"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    )
                  ) : (
                    <span>{currentUser.email}</span>
                  )}
                </div>
                <div className="w-full sm:w-1/6 text-left sm:text-right pt-1">
                  {editingField !== 'email' && (
                    <button
                      type="button"
                      onClick={() => {
                        setEmailInput(currentUser.email || '');
                        setEmailCurrentPassword('');
                        setPendingEmail(null);
                        setEditingField('email');
                      }}
                      className="text-emerald-600 hover:text-emerald-700 hover:underline text-xs font-semibold cursor-pointer"
                    >
                      Edit
                    </button>
                  )}
                </div>
              </div>

              {/* Row 3: Password (persisted with current password check) */}
              <div className="p-5 sm:px-8 flex flex-col sm:flex-row sm:items-start justify-between gap-4 hover:bg-slate-50/50 transition-colors">
                <div className="w-full sm:w-1/3 text-sm font-semibold text-slate-800 pt-1">
                  Password
                </div>
                <div className="w-full sm:w-1/2 text-sm text-slate-600 font-normal">
                  {editingField === 'password' ? (
                    <div className="space-y-2.5">
                      <input
                        type="password"
                        placeholder="Current password"
                        value={passwordCurrentInput}
                        onChange={(e) => setPasswordCurrentInput(e.target.value)}
                        className="px-3 py-1.5 border border-slate-300 rounded-lg text-xs w-full focus:outline-emerald-500"
                      />
                      <input
                        type="password"
                        placeholder="New password (min 6 characters)"
                        value={newPasswordInput}
                        onChange={(e) => setNewPasswordInput(e.target.value)}
                        className="px-3 py-1.5 border border-slate-300 rounded-lg text-xs w-full focus:outline-emerald-500"
                      />
                      <input
                        type="password"
                        placeholder="Confirm new password"
                        value={confirmPasswordInput}
                        onChange={(e) => setConfirmPasswordInput(e.target.value)}
                        className="px-3 py-1.5 border border-slate-300 rounded-lg text-xs w-full focus:outline-emerald-500"
                      />
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          disabled={isSaving}
                          onClick={handleSavePassword}
                          className="px-3 py-1.5 bg-emerald-600 text-white rounded-lg text-xs font-bold hover:bg-emerald-700 disabled:opacity-50 cursor-pointer"
                        >
                          {isSaving ? 'Updating...' : 'Update Password'}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setEditingField(null);
                            setPasswordCurrentInput('');
                            setNewPasswordInput('');
                            setConfirmPasswordInput('');
                          }}
                          className="px-2.5 py-1.5 text-slate-500 hover:text-slate-800 text-xs font-semibold cursor-pointer"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <span className="tracking-widest">••••••••••••</span>
                  )}
                </div>
                <div className="w-full sm:w-1/6 text-left sm:text-right pt-1">
                  {editingField !== 'password' && (
                    <button
                      type="button"
                      onClick={() => setEditingField('password')}
                      className="text-emerald-600 hover:text-emerald-700 hover:underline text-xs font-semibold cursor-pointer"
                    >
                      Change
                    </button>
                  )}
                </div>
              </div>

              {/* Row 4: Account Status */}
              <div className="p-5 sm:px-8 flex flex-col sm:flex-row sm:items-center justify-between gap-4 hover:bg-slate-50/50 transition-colors">
                <div className="w-full sm:w-1/3 text-sm font-semibold text-slate-800">
                  Account Status
                </div>
                <div className="w-full sm:w-1/2 text-sm text-slate-600 font-normal">
                  <span
                    className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold border ${
                      isAccountActive
                        ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                        : 'bg-amber-50 text-amber-800 border-amber-200'
                    }`}
                  >
                    {accountStatusLabel}
                  </span>
                </div>
                <div className="w-full sm:w-1/6 text-left sm:text-right">
                  <span className="text-xs text-slate-400 font-medium capitalize">{currentUser.role || 'member'}</span>
                </div>
              </div>

              {/* Row 5: Download My Data */}
              <div className="p-5 sm:px-8 flex flex-col sm:flex-row sm:items-center justify-between gap-4 hover:bg-slate-50/50 transition-colors">
                <div className="w-full sm:w-1/3 text-sm font-semibold text-slate-800">
                  Download My Data
                </div>
                <div className="w-full sm:w-1/2 text-xs text-slate-500">
                  Export a JSON copy of your current account profile record.
                </div>
                <div className="w-full sm:w-1/6 text-left sm:text-right">
                  <button
                    type="button"
                    onClick={() => {
                      const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(currentUser, null, 2));
                      const downloadAnchor = document.createElement('a');
                      downloadAnchor.setAttribute("href", dataStr);
                      downloadAnchor.setAttribute("download", `${SITE_CONFIG.brandWordmark.toLowerCase()}_user_data.json`);
                      document.body.appendChild(downloadAnchor);
                      downloadAnchor.click();
                      downloadAnchor.remove();
                      showToast('Account data downloaded.');
                    }}
                    className="text-emerald-600 hover:text-emerald-700 hover:underline text-xs font-semibold cursor-pointer"
                  >
                    Download
                  </button>
                </div>
              </div>
            </>
          )}

          {/* NOTIFICATIONS TAB */}
          {activeTab === 'notifications' && (
            <>
              <div className="p-5 sm:px-8 flex flex-col sm:flex-row sm:items-center justify-between gap-4 hover:bg-slate-50/50 transition-colors">
                <div className="w-full sm:w-1/3 text-sm font-semibold text-slate-800">Email Notifications</div>
                <div className="w-full sm:w-1/2 text-sm text-slate-600 font-normal">
                  {editingField === 'email_notifs' ? (
                    <div className="space-y-2">
                      <select
                        value={emailNotifs}
                        onChange={(e) => setEmailNotifs(e.target.value)}
                        className="px-3 py-1.5 border border-slate-300 rounded-lg text-xs w-full bg-white focus:outline-emerald-500"
                      >
                        <option>Instant alerts for all messages</option>
                        <option>Daily digest</option>
                        <option>Important updates only</option>
                        <option>Disabled</option>
                      </select>
                      <div className="flex items-center gap-2 pt-1">
                        <button type="button" onClick={() => handleSaveNotificationPref('emailNotifications', emailNotifs)} className="px-3 py-1 bg-emerald-600 text-white rounded-lg text-xs font-bold hover:bg-emerald-700 cursor-pointer">Save</button>
                        <button type="button" onClick={() => setEditingField(null)} className="p-1 text-slate-400 hover:text-slate-700 text-xs font-bold cursor-pointer">Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <span>{emailNotifs}</span>
                  )}
                </div>
                <div className="w-full sm:w-1/6 text-left sm:text-right">
                  {editingField !== 'email_notifs' && (
                    <button type="button" onClick={() => setEditingField('email_notifs')} className="text-emerald-600 hover:text-emerald-700 hover:underline text-xs font-semibold cursor-pointer">Edit</button>
                  )}
                </div>
              </div>

              <div className="p-5 sm:px-8 flex flex-col sm:flex-row sm:items-center justify-between gap-4 hover:bg-slate-50/50 transition-colors">
                <div className="w-full sm:w-1/3 text-sm font-semibold text-slate-800">SMS Alerts</div>
                <div className="w-full sm:w-1/2 text-sm text-slate-600 font-normal">
                  {editingField === 'sms_notifs' ? (
                    <div className="space-y-2">
                      <select
                        value={smsNotifs}
                        onChange={(e) => setSmsNotifs(e.target.value)}
                        className="px-3 py-1.5 border border-slate-300 rounded-lg text-xs w-full bg-white focus:outline-emerald-500"
                      >
                        {currentUser?.mobile && <option>Enabled ({currentUser.mobile})</option>}
                        <option>Enabled</option>
                        <option>Disabled</option>
                      </select>
                      <div className="flex items-center gap-2 pt-1">
                        <button type="button" onClick={() => handleSaveNotificationPref('smsNotifications', smsNotifs)} className="px-3 py-1 bg-emerald-600 text-white rounded-lg text-xs font-bold hover:bg-emerald-700 cursor-pointer">Save</button>
                        <button type="button" onClick={() => setEditingField(null)} className="p-1 text-slate-400 hover:text-slate-700 text-xs font-bold cursor-pointer">Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <span>{smsNotifs}</span>
                  )}
                </div>
                <div className="w-full sm:w-1/6 text-left sm:text-right">
                  {editingField !== 'sms_notifs' && (
                    <button type="button" onClick={() => setEditingField('sms_notifs')} className="text-emerald-600 hover:text-emerald-700 hover:underline text-xs font-semibold cursor-pointer">Edit</button>
                  )}
                </div>
              </div>

              <div className="p-5 sm:px-8 flex flex-col sm:flex-row sm:items-center justify-between gap-4 hover:bg-slate-50/50 transition-colors">
                <div className="w-full sm:w-1/3 text-sm font-semibold text-slate-800">Marketing &amp; Newsletters</div>
                <div className="w-full sm:w-1/2 text-sm text-slate-600 font-normal">
                  {editingField === 'marketing_notifs' ? (
                    <div className="space-y-2">
                      <select
                        value={marketingNotifs}
                        onChange={(e) => setMarketingNotifs(e.target.value)}
                        className="px-3 py-1.5 border border-slate-300 rounded-lg text-xs w-full bg-white focus:outline-emerald-500"
                      >
                        <option>Subscribed</option>
                        <option>Unsubscribed</option>
                      </select>
                      <div className="flex items-center gap-2 pt-1">
                        <button type="button" onClick={() => handleSaveNotificationPref('marketingNotifs', marketingNotifs)} className="px-3 py-1 bg-emerald-600 text-white rounded-lg text-xs font-bold hover:bg-emerald-700 cursor-pointer">Save</button>
                        <button type="button" onClick={() => setEditingField(null)} className="p-1 text-slate-400 hover:text-slate-700 text-xs font-bold cursor-pointer">Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <span>{marketingNotifs}</span>
                  )}
                </div>
                <div className="w-full sm:w-1/6 text-left sm:text-right">
                  {editingField !== 'marketing_notifs' && (
                    <button type="button" onClick={() => setEditingField('marketing_notifs')} className="text-emerald-600 hover:text-emerald-700 hover:underline text-xs font-semibold cursor-pointer">Edit</button>
                  )}
                </div>
              </div>
            </>
          )}

          {/* BILLING & PAYMENTS TAB */}
          {activeTab === 'payments' && (
            <div className="p-6 sm:p-8 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="flex items-start gap-3">
                <div className="p-2.5 bg-emerald-50 text-emerald-700 rounded-xl shrink-0">
                  <CreditCard className="w-5 h-5" />
                </div>
                <div>
                  <h2 className="text-sm font-bold text-slate-800">Billing &amp; Invoices</h2>
                  <p className="text-xs text-slate-500 mt-0.5">
                    View your transaction ledger, download invoices, and manage order payments in the Billing Center.
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={(e) => navigate('/payments', e)}
                className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold rounded-lg transition cursor-pointer shrink-0"
              >
                Open Billing Center
              </button>
            </div>
          )}

          {/* AVAILABILITY TAB */}
          {activeTab === 'availability' && (
            <div className="p-6 sm:p-8">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div className="space-y-1 max-w-md">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-bold text-slate-800">Available Now Status</span>
                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${
                      currentUser?.isAvailableNow || availableStatus === 'Active'
                        ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                        : 'bg-slate-100 text-slate-500 border border-slate-200'
                    }`}>
                      {currentUser?.isAvailableNow || availableStatus === 'Active' ? '● Online & Available' : '○ Unavailable'}
                    </span>
                  </div>
                  <p className="text-xs text-slate-500">
                    Display an &ldquo;Available Now&rdquo; badge on your profile so clients know you are actively responding.
                  </p>
                </div>

                {/* Interactive Slider Switch */}
                <button
                  type="button"
                  onClick={async () => {
                    const isNowAvailable = !(currentUser?.isAvailableNow || availableStatus === 'Active');
                    setAvailableStatus(isNowAvailable ? 'Active' : 'Inactive');
                    updateCurrentUser({ ...currentUser, isAvailableNow: isNowAvailable });
                    try {
                      const res = await fetchWithRetry('/api/users/availability', {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ isAvailableNow: isNowAvailable })
                      });
                      if (res.ok) {
                        const data = await res.json();
                        if (data.user) updateCurrentUser(data.user);
                        showToast(isNowAvailable ? 'You are now marked as Available Now.' : 'Availability turned off.');
                      } else {
                        const errData = await res.json().catch(() => ({}));
                        setAvailableStatus(isNowAvailable ? 'Inactive' : 'Active');
                        updateCurrentUser({ ...currentUser, isAvailableNow: !isNowAvailable });
                        showToast(errData.error || 'Failed to update availability.', 'error');
                      }
                    } catch (err) {
                      console.error('Failed to toggle availability:', err);
                      setAvailableStatus(isNowAvailable ? 'Inactive' : 'Active');
                      updateCurrentUser({ ...currentUser, isAvailableNow: !isNowAvailable });
                      showToast('Network error updating availability.', 'error');
                    }
                  }}
                  className={`relative inline-flex h-8 w-16 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                    currentUser?.isAvailableNow || availableStatus === 'Active' ? 'bg-emerald-500' : 'bg-slate-300'
                  }`}
                  role="switch"
                  aria-checked={currentUser?.isAvailableNow || availableStatus === 'Active'}
                >
                  <span className="sr-only">Toggle Availability Status</span>
                  <span
                    className={`pointer-events-none inline-block h-7 w-7 transform rounded-full bg-white shadow-md ring-0 transition duration-200 ease-in-out ${
                      currentUser?.isAvailableNow || availableStatus === 'Active' ? 'translate-x-8' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
