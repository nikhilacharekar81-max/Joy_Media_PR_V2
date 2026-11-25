import React, { useState, useEffect, useMemo } from 'react';
import {
  LayoutDashboard, Users, Briefcase, Layers, Shield, Sliders,
  FileText, CheckCircle2, DollarSign, Wallet, ShieldCheck, Scale,
  CornerDownLeft, TrendingUp, Star, MessageCircle, Flag, HelpCircle,
  FileCode, Settings, Activity, ShieldAlert, LogOut, Award, CreditCard, Sparkles
} from 'lucide-react';
import { UserAccount, Gig, Project, Proposal, Order } from '../types';
import { SITE_CONFIG } from '../siteConfig';
import { getDeviceId as defaultGetDeviceId } from '../utils/deviceId';
import { PaymentsModule } from '../components/PaymentsModule';
import {
  AdminOverviewModule,
  AdminUsersModule,
  AdminProjectsModule,
  AdminGigsModule,
  AdminCategoriesModule,
  AdminProposalsModule,
  AdminContractsModule,
  AdminEscrowModule,
  AdminDisputesModule,
  AdminRefundsModule,
  AdminPayoutsModule,
  AdminReviewsModule,
  AdminMessagesModule,
  AdminReportsModule,
  AdminSupportModule,
  AdminCmsModule,
  AdminActivityModule,
  AdminMembershipsQuotasModule,
  AdminPaymentGatewaysModule,
  AdminOrdersManager,
  SiteFeeSettingsModule,
  UserWalletsLedgerModule
} from '../components/admin_modules';
import type { AuditLogEvent } from '../components/admin_modules/AdminActivityModule';
import { getAuthToken, setAuthToken } from '../utils/authToken';

export interface AdminPageProps {
  currentUser: UserAccount | null;
  impersonatedUser: UserAccount | null;
  updateCurrentUser: (u: UserAccount | null | ((prev: UserAccount | null) => UserAccount | null)) => void;
  setImpersonatedUser: (u: UserAccount | null) => void;
  usersList: UserAccount[];
  setUsersList: React.Dispatch<React.SetStateAction<UserAccount[]>>;
  projects: Project[];
  gigs: Gig[];
  orders: Order[];
  proposals: Proposal[];
  platformFee?: number;
  clientServiceFee?: number;
  smallOrderFeeThreshold?: number;
  smallOrderFeeAmount?: number;
  escrowProtectionDays?: number;
  navigate: (to: string, e?: React.MouseEvent) => void;
  refresh: () => Promise<void> | void;
  getDeviceId?: () => string;
}

export const AdminPage: React.FC<AdminPageProps> = ({
  currentUser,
  impersonatedUser,
  updateCurrentUser,
  setImpersonatedUser,
  usersList,
  setUsersList,
  projects,
  gigs,
  orders,
  proposals,
  platformFee = SITE_CONFIG.AGENCY_MODE ? 0 : 20,
  clientServiceFee = SITE_CONFIG.AGENCY_MODE ? 0 : 1,
  smallOrderFeeThreshold = SITE_CONFIG.AGENCY_MODE ? 0 : 200,
  smallOrderFeeAmount = SITE_CONFIG.AGENCY_MODE ? 0 : 1,
  escrowProtectionDays = 14,
  navigate,
  refresh,
  getDeviceId = defaultGetDeviceId
}) => {
  // Navigation: 21 Admin Modules
  const [adminTab, setAdminTab] = useState<
    'overview' | 'users' | 'projects' | 'gigs' | 'categories' | 
    'proposals' | 'contracts' | 'payments' | 'wallet' | 'escrow' | 
    'disputes' | 'refunds' | 'payouts' | 'reviews' | 'messages' | 
    'reports' | 'support' | 'cms' | 'settings' | 'security' | 'activity' | 'orders' | 'memberships' | 'paymentGateways'
  >('overview');

  // Admin Auth & 2FA State
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [adminLoginRequiresCode, setAdminLoginRequiresCode] = useState(false);
  const [adminLoginCode, setAdminLoginCode] = useState('');
  const [adminMockCodeDisplay, setAdminMockCodeDisplay] = useState('');
  const [adminAuthNotice, setAdminAuthNotice] = useState<{ type: 'error' | 'success' | 'info'; message: string } | null>(null);
  const [needsInitialSetup, setNeedsInitialSetup] = useState(false);
  const [setupConfirmPassword, setSetupConfirmPassword] = useState('');
  const [isSubmittingAuth, setIsSubmittingAuth] = useState(false);

  const isUserAdmin = currentUser?.role === 'super_admin' || currentUser?.role === 'admin' || impersonatedUser?.role === 'super_admin' || impersonatedUser?.role === 'admin';

  useEffect(() => {
    if (isUserAdmin) return;
    fetch('/api/auth/admin-setup-status')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.needsSetup) {
          setNeedsInitialSetup(true);
          if (data.suggestedEmail && !loginEmail) {
            setLoginEmail(data.suggestedEmail);
          }
        } else {
          setNeedsInitialSetup(false);
        }
      })
      .catch(() => {});
  }, [isUserAdmin]);

  // Admin Domain Relational State
  const [adminDisputes, setAdminDisputes] = useState<any[]>([]);
  const [adminRefunds, setAdminRefunds] = useState<any[]>([]);
  const [adminPayouts, setAdminPayouts] = useState<any[]>([]);
  const [adminReviews, setAdminReviews] = useState<any[]>([]);
  const [adminTickets, setAdminTickets] = useState<any[]>([]);
  const [adminReports, setAdminReports] = useState<any[]>([]);
  const [adminThreads, setAdminThreads] = useState<any[]>([]);
  const [adminAuditLogs, setAdminAuditLogs] = useState<AuditLogEvent[]>([]);

  const getAdminHeaders = (withJson = false): Record<string, string> => {
    const token = getAuthToken();
    const headers: Record<string, string> = {
      'x-device-id': getDeviceId()
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (withJson) headers['Content-Type'] = 'application/json';
    return headers;
  };

  const assertOkResponse = async (res: Response, fallbackMessage: string) => {
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err?.error || fallbackMessage);
    }
    return res;
  };

  const mapAuditLogs = (rows: any[]): AuditLogEvent[] =>
    (Array.isArray(rows) ? rows : []).map((r: any) => {
      const action = String(r.action || '');
      const category: AuditLogEvent['category'] =
        /FINANC|ESCROW|PAYOUT|REFUND|WALLET|LEDGER|PAYMENT|FEE/i.test(action)
          ? 'financial'
          : /USER|IMPERSONAT|SUSPEND|ROLE/i.test(action)
          ? 'user_management'
          : /MOD|REPORT|REVIEW|DISPUTE|PROJECT|GIG|MESSAGE|PROPOSAL|TICKET/i.test(action)
          ? 'moderation'
          : /LOGIN|AUTH|VERIFY|SETUP|PASSWORD|2FA/i.test(action)
          ? 'auth'
          : 'system';
      const severity: AuditLogEvent['severity'] =
        /SECURITY|AUTH|IMPERSONAT/i.test(action)
          ? 'security'
          : /DELETE|SUSPEND|FREEZE|TERMINAT|FORCE|REJECT/i.test(action)
          ? 'critical'
          : /MOD|FLAG|DISPUTE|WARN/i.test(action)
          ? 'warning'
          : 'info';
      return {
        id: String(r.id || ''),
        timestamp: r.timestamp || new Date().toISOString(),
        adminName: r.actor || 'Admin',
        adminEmail: r.role || '',
        adminAvatar: '',
        action,
        category,
        severity,
        targetResource: r.target || '',
        ipAddress: r.ipAddress || 'server',
        userAgent: r.userAgent || '',
        status: 'success',
        details: r.details || ''
      };
    });

  const fetchAuditLogs = async () => {
    try {
      const res = await fetch('/api/audit-logs', { headers: getAdminHeaders() });
      if (res.ok) {
        const rows = await res.json();
        setAdminAuditLogs(mapAuditLogs(rows));
      }
    } catch (err) {
      console.warn('Failed to fetch audit logs:', err);
    }
  };

  useEffect(() => {
    if (!isUserAdmin) return;
    const fetchAdminData = async () => {
      try {
        const headers = getAdminHeaders();
        if (adminTab === 'disputes') {
          const res = await fetch('/api/admin/disputes', { headers });
          if (res.ok) setAdminDisputes(await res.json());
        } else if (adminTab === 'refunds') {
          const res = await fetch('/api/admin/refunds', { headers });
          if (res.ok) setAdminRefunds(await res.json());
        } else if (adminTab === 'payouts') {
          const res = await fetch('/api/admin/payouts', { headers });
          if (res.ok) setAdminPayouts(await res.json());
        } else if (adminTab === 'reviews') {
          const res = await fetch('/api/admin/reviews', { headers });
          if (res.ok) setAdminReviews(await res.json());
        } else if (adminTab === 'support') {
          const res = await fetch('/api/admin/support/tickets', { headers });
          if (res.ok) setAdminTickets(await res.json());
        } else if (adminTab === 'reports') {
          const res = await fetch('/api/admin/reports', { headers });
          if (res.ok) setAdminReports(await res.json());
        } else if (adminTab === 'messages') {
          const res = await fetch('/api/admin/messages/threads', { headers });
          if (res.ok) setAdminThreads(await res.json());
        } else if (adminTab === 'activity' || adminTab === 'security') {
          await fetchAuditLogs();
        }
      } catch (err) {
        console.warn('Failed to fetch admin tab data:', err);
      }
    };
    fetchAdminData();
  }, [adminTab, isUserAdmin]);

  const contractsData = useMemo(() => {
    const userById = new Map((usersList || []).map(u => [String(u.id), u]));
    return (orders || []).map(o => {
      const buyer = userById.get(String(o.buyerId || ''));
      const seller = userById.get(String(o.sellerId || ''));
      const statusLower = String(o.status || '').toLowerCase();
      const isUnfundedOrVoid = ['cancelled', 'refunded', 'payment_pending', 'pending_payment', 'draft'].includes(statusLower);
      return {
        id: o.id,
        title: o.title,
        clientName: buyer?.name || o.buyerUsername || 'Client',
        clientEmail: buyer?.email || '',
        clientAvatar: buyer?.avatar || '',
        freelancerName: seller?.name || o.sellerUsername || SITE_CONFIG.brandName,
        freelancerEmail: seller?.email || '',
        freelancerAvatar: seller?.avatar || '',
        totalAmount: o.amount || 0,
        fundedInEscrow: isUnfundedOrVoid ? 0 : (o.amount || 0),
        releasedAmount: statusLower === 'completed' ? (o.amount || 0) : 0,
        startDate: o.createdAt,
        endDate: o.dueDate,
        status: (statusLower === 'completed' ? 'completed' : (statusLower === 'cancelled' || statusLower === 'refunded' ? 'terminated' : (statusLower === 'disputed' ? 'disputed' : 'active'))) as any,
        milestones: [{ id: 'ms_' + o.id, title: 'Contract Deliverable', amount: o.amount || 0, dueDate: o.dueDate || o.createdAt, status: (statusLower === 'completed' ? 'released' : 'funded') as any }],
        termsAgreedAt: o.createdAt
      };
    });
  }, [orders, usersList]);

  // 1. Unauthenticated or Non-Admin Gate
  if (!isUserAdmin) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center p-4 font-sans">
        <div className="bg-white border border-slate-200 rounded-3xl p-8 max-w-md w-full shadow-2xl space-y-6 text-slate-800">
          <div className="text-center space-y-2">
            <div className="w-12 h-12 rounded-2xl bg-emerald-600 text-white flex items-center justify-center font-bold text-xl mx-auto shadow-md">
              {SITE_CONFIG.brandName.charAt(0)}
            </div>
            <h2 className="text-2xl font-bold text-agency-dark tracking-tight">
              {needsInitialSetup ? 'Initial Admin Setup' : 'Admin Portal Login'}
            </h2>
            <p className="text-xs text-agency-muted">
              {needsInitialSetup
                ? `Set your initial Super Administrator password to unlock the ${SITE_CONFIG.brandName} Admin Suite.`
                : `Enter your Administrator credentials to access the ${SITE_CONFIG.brandName} Super Admin Suite.`}
            </p>
          </div>

          {adminAuthNotice && (
            <div
              className={`p-3 rounded-2xl text-xs font-medium border ${
                adminAuthNotice.type === 'error'
                  ? 'bg-red-50 border-red-200 text-red-800'
                  : adminAuthNotice.type === 'success'
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                  : 'bg-slate-50 border-slate-200 text-slate-800'
              }`}
            >
              {adminAuthNotice.message}
            </div>
          )}

          {needsInitialSetup ? (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                setAdminAuthNotice(null);
                const emailToUse = loginEmail.trim();
                if (!emailToUse || !loginPassword) {
                  setAdminAuthNotice({ type: 'error', message: 'Email and password are required.' });
                  return;
                }
                if (loginPassword.length < 10) {
                  setAdminAuthNotice({ type: 'error', message: 'Password must be at least 10 characters long.' });
                  return;
                }
                if (loginPassword !== setupConfirmPassword) {
                  setAdminAuthNotice({ type: 'error', message: 'Passwords do not match.' });
                  return;
                }
                setIsSubmittingAuth(true);
                try {
                  const res = await fetch('/api/auth/admin-setup', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      email: emailToUse,
                      password: loginPassword,
                      confirmPassword: setupConfirmPassword
                    })
                  });
                  const data = await res.json();
                  if (!res.ok) throw new Error(data.error || 'Failed to configure admin password.');
                  setNeedsInitialSetup(false);
                  setSetupConfirmPassword('');
                  setAdminAuthNotice({
                    type: 'success',
                    message: data.message || 'Admin password configured. Please sign in below.'
                  });
                } catch (err: any) {
                  setAdminAuthNotice({ type: 'error', message: err?.message || 'Setup failed.' });
                } finally {
                  setIsSubmittingAuth(false);
                }
              }}
              className="space-y-4 text-xs"
            >
              <div>
                <label className="block text-agency-dark font-bold uppercase mb-1">Admin Email ID</label>
                <input
                  type="email"
                  placeholder="admin@joymediapr.com"
                  value={loginEmail}
                  onChange={(e) => setLoginEmail(e.target.value)}
                  required
                  className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-agency-dark focus:outline-none focus:border-emerald-500 font-medium"
                />
              </div>

              <div>
                <label className="block text-agency-dark font-bold uppercase mb-1">Create Strong Password (min 10 chars)</label>
                <input
                  type="password"
                  placeholder="Enter a strong password"
                  value={loginPassword}
                  onChange={(e) => setLoginPassword(e.target.value)}
                  minLength={10}
                  required
                  className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-agency-dark focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div>
                <label className="block text-agency-dark font-bold uppercase mb-1">Confirm Password</label>
                <input
                  type="password"
                  placeholder="Confirm your password"
                  value={setupConfirmPassword}
                  onChange={(e) => setSetupConfirmPassword(e.target.value)}
                  minLength={10}
                  required
                  className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-agency-dark focus:outline-none focus:border-emerald-500"
                />
              </div>

              <button
                type="submit"
                disabled={isSubmittingAuth}
                className="w-full py-3.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 text-white font-bold rounded-xl shadow-md transition-colors text-sm cursor-pointer"
              >
                {isSubmittingAuth ? 'Configuring...' : 'Complete Initial Admin Setup'}
              </button>

              <div className="pt-4 border-t border-slate-100 text-center">
                <a
                  href="/services"
                  onClick={(e) => navigate('/services', e)}
                  className="text-xs text-agency-muted hover:text-slate-800 font-medium"
                >
                  ← Return to {SITE_CONFIG.brandName} Home
                </a>
              </div>
            </form>
          ) : (
            <form onSubmit={async (e) => {
              e.preventDefault();
              setAdminAuthNotice(null);
              const emailToUse = loginEmail.trim();
              const passToUse = loginPassword;
              if (!emailToUse || !passToUse) {
                setAdminAuthNotice({ type: 'error', message: 'Admin email and password are required.' });
                return;
              }
              const deviceId = getDeviceId();
              setIsSubmittingAuth(true);
              try {
                const payload: any = {
                  email: emailToUse,
                  password: passToUse,
                  deviceId
                };
                if (adminLoginRequiresCode && adminLoginCode.trim()) {
                  payload.code = adminLoginCode.trim();
                }

                const res = await fetch('/api/auth/login', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(payload)
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Authentication failed');

                if (data.requiresVerification) {
                  setAdminLoginRequiresCode(true);
                  const codeVal = data.mockEmailCode || data.mockCode;
                  if (codeVal) {
                    setAdminMockCodeDisplay(codeVal);
                    if (!adminLoginCode) setAdminLoginCode(codeVal);
                  }
                  setAdminAuthNotice({ type: 'info', message: 'Admin 2FA verification code generated and dispatched.' });
                  return;
                }

                if (data.token) {
                  setAuthToken(data.token);
                }
                if (data.user) {
                  updateCurrentUser(data.user);
                  setImpersonatedUser(null);
                }
                setAdminLoginRequiresCode(false);
                setAdminLoginCode('');
                refresh();
              } catch (err: any) {
                setAdminAuthNotice({ type: 'error', message: err?.message || 'Authentication failed' });
              } finally {
                setIsSubmittingAuth(false);
              }
            }} className="space-y-4 text-xs">
              {adminLoginRequiresCode ? (
                <div className="space-y-4">
                  <div className="p-3 bg-slate-50 border border-slate-200 rounded-2xl text-xs text-slate-800 space-y-1">
                    <div className="flex items-center gap-1.5 font-bold text-slate-900">
                      <ShieldAlert className="w-4 h-4 text-emerald-600" />
                      <span>Admin Verification Code Sent</span>
                    </div>
                    <p>Enter the 6-digit email verification code sent to {loginEmail.trim()}.</p>
                  </div>

                  {adminMockCodeDisplay && (
                    <div className="p-3 bg-amber-50 border border-amber-300 rounded-2xl text-xs text-amber-900 flex items-center justify-between">
                      <span className="font-bold uppercase tracking-wider text-[11px] flex items-center gap-1.5">
                        <Sparkles className="w-3.5 h-3.5 text-amber-600 shrink-0" />
                        <span>TEST MODE - code: {adminMockCodeDisplay}</span>
                      </span>
                      <button
                        type="button"
                        onClick={() => setAdminLoginCode(adminMockCodeDisplay)}
                        className="px-2.5 py-1 bg-amber-600 hover:bg-amber-700 text-white font-bold text-[10px] rounded-lg transition cursor-pointer shrink-0"
                      >
                        Fill code
                      </button>
                    </div>
                  )}

                  <div>
                    <label className="block text-agency-dark font-bold uppercase mb-1">Enter 6-Digit Email Code</label>
                    <input 
                      type="text" 
                      maxLength={6} 
                      placeholder="123456" 
                      value={adminLoginCode} 
                      onChange={(e) => setAdminLoginCode(e.target.value)} 
                      required 
                      autoFocus
                      className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-center text-lg font-mono font-bold tracking-widest text-agency-dark focus:outline-none focus:border-emerald-500" 
                    />
                  </div>

                  <button 
                    type="submit" 
                    disabled={isSubmittingAuth}
                    className="w-full py-3.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 text-white font-bold rounded-xl shadow-md transition-colors text-sm cursor-pointer"
                  >
                    Verify Email Code & Unlock Admin Suite
                  </button>

                  <div className="flex items-center justify-between text-xs pt-1">
                    <button 
                      type="button" 
                      onClick={async () => {
                        try {
                          const res = await fetch('/api/auth/resend-email-code', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ email: loginEmail.trim() })
                          });
                          const data = await res.json();
                          const codeVal = data.mockEmailCode || data.mockCode;
                          if (res.ok) {
                            if (codeVal) {
                              setAdminMockCodeDisplay(codeVal);
                              setAdminLoginCode(codeVal);
                            }
                            setAdminAuthNotice({ type: 'info', message: 'A new verification code has been dispatched.' });
                          } else {
                            setAdminAuthNotice({ type: 'error', message: data.error || 'Could not resend code.' });
                          }
                        } catch {
                          setAdminAuthNotice({ type: 'error', message: 'Network error while resending code.' });
                        }
                      }} 
                      className="text-emerald-700 font-semibold hover:underline cursor-pointer"
                    >
                      Resend Code
                    </button>
                    <button 
                      type="button" 
                      onClick={() => { setAdminLoginRequiresCode(false); setAdminLoginCode(''); setAdminAuthNotice(null); }} 
                      className="text-agency-muted hover:text-slate-800 cursor-pointer"
                    >
                      Back to Password
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div>
                    <label className="block text-agency-dark font-bold uppercase mb-1">Admin Email ID</label>
                    <input 
                      type="email" 
                      placeholder="Enter Admin Email"
                      value={loginEmail}
                      onChange={(e) => setLoginEmail(e.target.value)}
                      required
                      className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-agency-dark focus:outline-none focus:border-emerald-500 font-medium"
                    />
                  </div>

                  <div>
                    <label className="block text-agency-dark font-bold uppercase mb-1">Admin Password</label>
                    <input 
                      type="password" 
                      placeholder="••••••••••••"
                      value={loginPassword}
                      onChange={(e) => setLoginPassword(e.target.value)}
                      required
                      className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-agency-dark focus:outline-none focus:border-emerald-500"
                    />
                  </div>

                  <button 
                    type="submit" 
                    disabled={isSubmittingAuth}
                    className="w-full py-3.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 text-white font-bold rounded-xl shadow-md transition-colors text-sm cursor-pointer"
                  >
                    Authenticate & Request Email Code
                  </button>
                </>
              )}

              <div className="pt-4 border-t border-slate-100 text-center">
                <a 
                  href="/services" 
                  onClick={(e) => navigate('/services', e)}
                  className="text-xs text-agency-muted hover:text-slate-800 font-medium"
                >
                  ← Return to {SITE_CONFIG.brandName} Home
                </a>
              </div>
            </form>
          )}
        </div>
      </div>
    );
  }

  const effectiveAdminUser = impersonatedUser || currentUser || usersList.find(u => u.role === 'admin' || u.role === 'super_admin') || usersList[0];

  return (
    <div className="min-h-screen bg-slate-50 text-agency-dark flex font-sans selection:bg-emerald-500 selection:text-white">
      {/* ADMIN SIDEBAR */}
      <aside className="w-72 bg-white border-r border-slate-200 flex flex-col justify-between p-5 shrink-0 sticky top-0 h-screen overflow-y-auto shadow-xs">
        <div>
          {/* Admin Brand */}
          <div className="flex items-center justify-between pb-6 mb-6 border-b border-slate-200">
            <a href="/services" onClick={(e) => navigate('/services', e)} className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-xl bg-emerald-600 text-white flex items-center justify-center font-bold text-base shadow-sm">
                {SITE_CONFIG.brandName.charAt(0)}
              </div>
              <div>
                <span className="text-sm font-bold text-agency-dark block leading-none">{SITE_CONFIG.brandName}</span>
                <span className="text-[10px] text-emerald-600 font-semibold tracking-wider uppercase">Super Admin Suite</span>
              </div>
            </a>
            <span className="text-[9px] bg-emerald-50 text-emerald-700 font-mono px-2 py-0.5 rounded border border-emerald-200">v3.0 RBAC</span>
          </div>

          {/* Sidebar Navigation: 21 Modules */}
          <nav className="space-y-1">
            {[
              { id: 'overview', label: '1. Dashboard Overview', icon: LayoutDashboard },
              { id: 'users', label: '2. User Management', icon: Users },
              { id: 'projects', label: '3. Projects & RFPs', icon: Briefcase },
              { id: 'gigs', label: '4. Services & Gigs', icon: Layers },
              { id: 'orders', label: '5. All Orders', icon: Shield },
              { id: 'categories', label: '6. Categories & Slugs', icon: Sliders },
              { id: 'proposals', label: '7. Proposals & Bids', icon: FileText },
              { id: 'contracts', label: '8. Contracts & Milestones', icon: CheckCircle2 },
              { id: 'paymentGateways', label: '9. Payment Gateways (PayPal)', icon: CreditCard },
              { id: 'wallet', label: '10. Wallet & Double Ledger', icon: Wallet },
              { id: 'escrow', label: '11. Escrow Vault (14-Day)', icon: ShieldCheck },
              { id: 'disputes', label: '12. Dispute Resolution', icon: Scale },
              { id: 'refunds', label: '13. Refund Requests', icon: CornerDownLeft },
              { id: 'payouts', label: '14. Freelancer Payouts', icon: TrendingUp },
              { id: 'reviews', label: '15. Reviews & Moderation', icon: Star },
              { id: 'messages', label: '16. Messages & Chat Audit', icon: MessageCircle },
              { id: 'reports', label: '17. Flagged Reports', icon: Flag },
              { id: 'support', label: '18. Support Ticket Desk', icon: HelpCircle },
              { id: 'cms', label: '19. CMS & Legal Policies', icon: FileCode },
              { id: 'settings', label: '20. Site & Fee Settings', icon: Settings },
              { id: 'memberships', label: '21. Memberships & Quotas', icon: Award },
              { id: 'activity', label: '22. Activity & Audit Trail', icon: Activity }
            ].map(item => {
              const IconComp = item.icon;
              const isActive = adminTab === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => setAdminTab(item.id as any)}
                  className={`w-full flex items-center gap-3 px-3 py-2 rounded-xl text-xs font-semibold transition-all cursor-pointer ${
                    isActive ? 'bg-emerald-600 text-white shadow-xs font-bold' : 'text-agency-dark hover:text-agency-dark hover:bg-slate-100'
                  }`}
                >
                  <IconComp className="w-4 h-4 shrink-0" />
                  <span className="truncate">{item.label}</span>
                </button>
              );
            })}
          </nav>
        </div>

        {/* System Status & Exit */}
        <div className="space-y-4 pt-6 border-t border-slate-200 mt-6">
          <div className="bg-slate-50 border border-slate-200 rounded-xl p-3">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[10px] uppercase font-bold text-agency-muted tracking-wider">Gateway Telemetry</span>
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
            </div>
            <p className="text-[11px] text-agency-dark font-medium">RBAC Active · 14-Day Escrow Locked</p>
          </div>

          <a 
            href="/services" 
            onClick={(e) => navigate('/services', e)}
            className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl text-xs font-bold text-agency-dark bg-slate-100 hover:bg-slate-200 transition-colors border border-slate-200 cursor-pointer"
          >
            <LogOut className="w-4 h-4 text-emerald-600" />
            <span>Exit Admin Portal</span>
          </a>
        </div>
      </aside>

      {/* MAIN ADMIN CONTENT AREA */}
      <main className="flex-1 p-8 overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-8 pb-6 border-b border-slate-200">
          <div>
            <span className="text-xs font-semibold text-emerald-600 block mb-1">Super Administrator Console</span>
            <h1 className="text-2xl font-bold text-agency-dark">
              {adminTab === 'overview' && '1. Admin Dashboard & Metrics'}
              {adminTab === 'users' && '2. User Management & Impersonation'}
              {adminTab === 'projects' && '3. Projects & RFP Moderation'}
              {adminTab === 'gigs' && '4. Services & Gigs Management'}
              {adminTab === 'orders' && '5. All Orders Management'}
              {adminTab === 'categories' && '6. Categories, Subcategories & Slugs'}
              {adminTab === 'proposals' && '7. Proposals & Bid Audit'}
              {adminTab === 'contracts' && '8. Contracts & Milestone Timelines'}
              {(adminTab === 'payments' || adminTab === 'paymentGateways') && '9. Payment Gateways & Transaction Logs'}
              {adminTab === 'wallet' && '10. User Wallets & Double-Entry Ledger'}
              {adminTab === 'escrow' && '11. Escrow Management (Mandatory 14-Day Protection)'}
              {adminTab === 'disputes' && '12. Dispute Investigation & Resolution'}
              {adminTab === 'refunds' && '13. Refund Requests & Approvals'}
              {adminTab === 'payouts' && '14. Freelancer Payouts & Disbursements'}
              {adminTab === 'reviews' && '15. Reviews & Ratings Moderation'}
              {adminTab === 'messages' && '16. Messages & Conversation Audit'}
              {adminTab === 'reports' && '17. Flagged Reports & Cases'}
              {adminTab === 'support' && '18. Support Ticket Help Desk'}
              {adminTab === 'cms' && '19. CMS Pages & Legal Policies'}
              {adminTab === 'settings' && '20. Site & Fee Settings'}
              {adminTab === 'memberships' && '21. Memberships & Quotas'}
              {(adminTab === 'security' || adminTab === 'activity') && '22. Admin Activity Logs & Security Audit Trail'}
            </h1>
          </div>

          <div className="flex items-center gap-3">
            <span className="text-xs text-agency-dark bg-white px-3 py-1.5 rounded-lg border border-slate-200 font-mono shadow-xs">
              RBAC Level: {effectiveAdminUser?.role || 'admin'}
            </span>
          </div>
        </div>

        {/* MODULE 1: DASHBOARD OVERVIEW */}
        {adminTab === 'overview' && (
          <AdminOverviewModule 
            allUsers={usersList} 
            allProjects={projects} 
            allGigs={gigs} 
            allOrders={orders} 
            escrowAccounts={orders} 
            platformBalance={orders
              .filter(o => !['cancelled', 'refunded', 'payment_pending', 'pending_payment', 'draft'].includes(String(o.status || '').toLowerCase()))
              .reduce((sum, o) => sum + (Number(o.amount) || 0), 0) * (platformFee / 100)} 
          />
        )}

        {/* MODULE 2: USER MANAGEMENT */}
        {adminTab === 'users' && (
          <AdminUsersModule 
            allUsers={usersList} 
            onImpersonateUser={async (userId) => {
              const res = await fetch(`/api/admin/users/${userId}/impersonate`, {
                method: 'POST',
                headers: getAdminHeaders(true)
              });
              await assertOkResponse(res, 'Failed to impersonate user');
              const data = await res.json();
              const originalAdminToken = getAuthToken();
              if (originalAdminToken && typeof window !== 'undefined') {
                try {
                  sessionStorage.setItem('admin_restore_token', originalAdminToken);
                } catch {}
              }
              if (data.token) {
                setAuthToken(data.token);
              }
              const targetUser = data.user || usersList.find(x => x.id === userId);
              if (targetUser) {
                setImpersonatedUser(targetUser);
                navigate('/services');
                if (refresh) await refresh();
              }
            }} 
            onToggleUserStatus={async (userId) => {
              const target = usersList.find(x => x.id === userId);
              const nextStatus = target?.status === 'suspended' ? 'active' : 'suspended';
              const res = await fetch(`/api/admin/users/${userId}`, {
                method: 'PATCH',
                headers: getAdminHeaders(true),
                body: JSON.stringify({ status: nextStatus })
              });
              await assertOkResponse(res, 'Failed to update user status');
              setUsersList(prev => prev.map(u => u.id === userId ? { ...u, status: nextStatus } : u));
              if (refresh) await refresh();
            }}
            onUpdateUser={async (updatedUser) => {
              const res = await fetch(`/api/admin/users/${updatedUser.id}`, {
                method: 'PATCH',
                headers: getAdminHeaders(true),
                body: JSON.stringify(updatedUser)
              });
              await assertOkResponse(res, 'Failed to update user profile');
              setUsersList(prev => prev.map(u => u.id === updatedUser.id ? updatedUser : u));
              if (refresh) await refresh();
            }}
            onDeleteUser={async (userId) => {
              const res = await fetch(`/api/admin/users/${userId}`, {
                method: 'DELETE',
                headers: getAdminHeaders()
              });
              await assertOkResponse(res, 'Failed to delete user account');
              setUsersList(prev => prev.filter(u => String(u.id) !== String(userId)));
              if (refresh) await refresh();
            }}
          />
        )}

        {/* MODULE 3: PROJECTS MANAGEMENT */}
        {adminTab === 'projects' && (
          <AdminProjectsModule
            allProjects={projects}
            onUpdateProjectStatus={async (projectId, status, moderationStatus, moderationNotes) => {
              const res = await fetch(`/api/admin/projects/${projectId}`, {
                method: 'PATCH',
                headers: getAdminHeaders(true),
                body: JSON.stringify({
                  status,
                  moderationStatus,
                  ...(moderationNotes !== undefined ? { moderationNotes } : {})
                })
              });
              await assertOkResponse(res, 'Failed to update project status');
              if (refresh) await refresh();
            }}
            onDeleteProject={async (projectId) => {
              const res = await fetch(`/api/admin/projects/${projectId}`, {
                method: 'DELETE',
                headers: getAdminHeaders()
              });
              await assertOkResponse(res, 'Failed to delete project');
              if (refresh) await refresh();
            }}
          />
        )}

        {/* MODULE 4: FREELANCER GIGS & SERVICES MANAGEMENT */}
        {adminTab === 'gigs' && (
          <AdminGigsModule
            allGigs={gigs}
            allUsers={usersList}
            onUpdateGigStatus={async (gigId, status) => {
              const res = await fetch(`/api/admin/gigs/${gigId}/status`, {
                method: 'PATCH',
                headers: getAdminHeaders(true),
                body: JSON.stringify({ status })
              });
              await assertOkResponse(res, 'Failed to update gig status');
              if (refresh) await refresh();
            }}
            onToggleFeatured={async (gigId, featured) => {
              const res = await fetch(`/api/admin/gigs/${gigId}/feature`, {
                method: 'PATCH',
                headers: getAdminHeaders(true),
                body: JSON.stringify({ featured })
              });
              await assertOkResponse(res, 'Failed to update gig featured flag');
              if (refresh) await refresh();
            }}
            onDeleteGig={async (gigId) => {
              const res = await fetch(`/api/admin/gigs/${gigId}`, {
                method: 'DELETE',
                headers: getAdminHeaders()
              });
              await assertOkResponse(res, 'Failed to delete gig');
              if (refresh) await refresh();
            }}
          />
        )}

        {/* MODULE 5: CATEGORIES & SUBCATEGORIES MANAGEMENT */}
        {adminTab === 'categories' && (
          <AdminCategoriesModule />
        )}

        {/* MODULE 6: ALL ORDERS MANAGEMENT (Real AdminOrdersManager) */}
        {adminTab === 'orders' && (
          <AdminOrdersManager
            orders={orders}
            users={usersList}
            gigs={gigs}
            currentUser={effectiveAdminUser}
            onRefreshOrders={refresh}
            getGigUrl={(gig: any) => `/${gig.freelancerUsername || 'user'}/${gig.slug || gig.id}`}
          />
        )}

        {/* MODULE 7: PROPOSALS & BIDS MANAGEMENT */}
        {adminTab === 'proposals' && (
          <AdminProposalsModule
            initialProposals={proposals as any}
            onUpdateProposalStatus={async (id, status) => {
              const res = await fetch(`/api/admin/proposals/${id}/status`, {
                method: 'PATCH',
                headers: getAdminHeaders(true),
                body: JSON.stringify({ status })
              });
              await assertOkResponse(res, 'Failed to update proposal status');
              if (refresh) await refresh();
            }}
            onDeleteProposal={async (id) => {
              const res = await fetch(`/api/admin/proposals/${id}`, {
                method: 'DELETE',
                headers: getAdminHeaders()
              });
              await assertOkResponse(res, 'Failed to delete proposal');
              if (refresh) await refresh();
            }}
          />
        )}

        {/* MODULE 8: CONTRACTS & MILESTONES */}
        {adminTab === 'contracts' && (
          <AdminContractsModule initialContracts={contractsData} />
        )}

        {/* MODULE 9: PAYMENTS (Real PaymentsModule) */}
        {adminTab === 'payments' && (
          <PaymentsModule
            gigs={gigs}
            orders={orders}
            projects={projects}
            proposals={proposals}
            currentUser={effectiveAdminUser}
            onBalanceUpdate={refresh}
          />
        )}

        {/* MODULE 10: USER WALLETS (Real UserWalletsLedgerModule) */}
        {adminTab === 'wallet' && (
          <UserWalletsLedgerModule
            currentUser={effectiveAdminUser}
          />
        )}

        {/* MODULE 11: ESCROW MANAGEMENT */}
        {adminTab === 'escrow' && (
          <AdminEscrowModule
            escrowAccounts={orders}
            onReleaseEscrow={async (orderId) => {
              const res = await fetch(`/api/admin/finance/escrow/${orderId}/release`, {
                method: 'POST',
                headers: getAdminHeaders(true),
                body: JSON.stringify({ reason: 'Admin manual release from Admin Console' })
              });
              await assertOkResponse(res, 'Failed to release escrow funds');
              await refresh();
            }}
            onRefundEscrow={async (orderId) => {
              const res = await fetch(`/api/admin/finance/escrow/${orderId}/refund`, {
                method: 'POST',
                headers: getAdminHeaders(true),
                body: JSON.stringify({ reason: 'Admin manual refund from Admin Console' })
              });
              await assertOkResponse(res, 'Failed to refund escrow funds');
              await refresh();
            }}
          />
        )}

        {/* MODULE 12: DISPUTES */}
        {adminTab === 'disputes' && (
          <AdminDisputesModule
            initialDisputes={adminDisputes}
            onResolveDispute={async (disputeId, resolution, details) => {
              const res = await fetch(`/api/admin/disputes/${disputeId}/resolve`, {
                method: 'PATCH',
                headers: getAdminHeaders(true),
                body: JSON.stringify({
                  status: resolution,
                  buyerPercent: details?.buyerPercent,
                  sellerPercent: details?.sellerPercent,
                  resolutionNotes: details?.resolutionNotes
                })
              });
              await assertOkResponse(res, 'Failed to resolve dispute');
              const refreshed = await fetch('/api/admin/disputes', { headers: getAdminHeaders() });
              if (refreshed.ok) setAdminDisputes(await refreshed.json());
              if (refresh) await refresh();
            }}
          />
        )}

        {/* MODULE 13: REFUNDS */}
        {adminTab === 'refunds' && (
          <AdminRefundsModule
            initialRefunds={adminRefunds}
            onApproveRefund={async (refundId, details) => {
              const res = await fetch(`/api/admin/refunds/${refundId}/approve`, {
                method: 'POST',
                headers: getAdminHeaders(true),
                body: JSON.stringify({ amount: details?.amount, reason: details?.reason })
              });
              await assertOkResponse(res, 'Failed to approve refund');
              const refreshed = await fetch('/api/admin/refunds', { headers: getAdminHeaders() });
              if (refreshed.ok) setAdminRefunds(await refreshed.json());
              if (refresh) await refresh();
            }}
            onRejectRefund={async (refundId, details) => {
              const res = await fetch(`/api/admin/refunds/${refundId}/reject`, {
                method: 'POST',
                headers: getAdminHeaders(true),
                body: JSON.stringify({ reason: details?.reason })
              });
              await assertOkResponse(res, 'Failed to reject refund');
              const refreshed = await fetch('/api/admin/refunds', { headers: getAdminHeaders() });
              if (refreshed.ok) setAdminRefunds(await refreshed.json());
              if (refresh) await refresh();
            }}
          />
        )}

        {/* MODULE 14: PAYOUTS */}
        {adminTab === 'payouts' && (
          <AdminPayoutsModule
            initialPayouts={adminPayouts}
            onApprovePayout={async (payoutId, note) => {
              const res = await fetch(`/api/admin/finance/payouts/${payoutId}/approve`, {
                method: 'POST',
                headers: getAdminHeaders(true),
                body: JSON.stringify({ reason: note || 'Approved by Admin' })
              });
              await assertOkResponse(res, 'Failed to approve payout');
              const refreshed = await fetch('/api/admin/payouts', { headers: getAdminHeaders() });
              if (refreshed.ok) setAdminPayouts(await refreshed.json());
              if (refresh) await refresh();
            }}
            onProcessPayout={async (payoutId, transactionRef, note) => {
              const res = await fetch(`/api/admin/finance/payouts/${payoutId}/process`, {
                method: 'POST',
                headers: getAdminHeaders(true),
                body: JSON.stringify({ transactionRef, reason: note || 'Processed by Admin' })
              });
              await assertOkResponse(res, 'Failed to process payout');
              const refreshed = await fetch('/api/admin/payouts', { headers: getAdminHeaders() });
              if (refreshed.ok) setAdminPayouts(await refreshed.json());
              if (refresh) await refresh();
            }}
            onRejectPayout={async (payoutId, note) => {
              const res = await fetch(`/api/admin/finance/payouts/${payoutId}/reject`, {
                method: 'POST',
                headers: getAdminHeaders(true),
                body: JSON.stringify({ reason: note || 'Rejected by Admin' })
              });
              await assertOkResponse(res, 'Failed to reject payout');
              const refreshed = await fetch('/api/admin/payouts', { headers: getAdminHeaders() });
              if (refreshed.ok) setAdminPayouts(await refreshed.json());
              if (refresh) await refresh();
            }}
          />
        )}

        {/* MODULE 15: REVIEWS */}
        {adminTab === 'reviews' && (
          <AdminReviewsModule
            initialReviews={adminReviews}
            onUpdateReviewStatus={async (id, status, reason) => {
              const res = await fetch(`/api/admin/reviews/${id}/status`, {
                method: 'PATCH',
                headers: getAdminHeaders(true),
                body: JSON.stringify({ status, moderationStatus: status, reason })
              });
              await assertOkResponse(res, 'Failed to update review status');
              const refreshed = await fetch('/api/admin/reviews', { headers: getAdminHeaders() });
              if (refreshed.ok) setAdminReviews(await refreshed.json());
              if (refresh) await refresh();
            }}
            onDeleteReview={async (id) => {
              const res = await fetch(`/api/admin/reviews/${id}`, {
                method: 'DELETE',
                headers: getAdminHeaders()
              });
              await assertOkResponse(res, 'Failed to delete review');
              const refreshed = await fetch('/api/admin/reviews', { headers: getAdminHeaders() });
              if (refreshed.ok) setAdminReviews(await refreshed.json());
              if (refresh) await refresh();
            }}
          />
        )}

        {/* MODULE 16: MESSAGES */}
        {adminTab === 'messages' && (
          <AdminMessagesModule
            initialThreads={adminThreads}
            onModerateThread={async (threadId, action, note) => {
              const res = await fetch(`/api/admin/messages/moderate`, {
                method: 'POST',
                headers: getAdminHeaders(true),
                body: JSON.stringify({ threadId, action, note })
              });
              await assertOkResponse(res, 'Failed to moderate thread');
              if (refresh) await refresh();
            }}
          />
        )}

        {/* MODULE 17: REPORTS */}
        {adminTab === 'reports' && (
          <AdminReportsModule
            initialReports={adminReports}
            onTakeAction={async (reportId, action) => {
              const res = await fetch(`/api/admin/reports/${reportId}`, {
                method: 'PATCH',
                headers: getAdminHeaders(true),
                body: JSON.stringify({ action, status: 'resolved' })
              });
              await assertOkResponse(res, 'Failed to take action on report');
              if (refresh) await refresh();
            }}
            onDismissReport={async (reportId) => {
              const res = await fetch(`/api/admin/reports/${reportId}`, {
                method: 'PATCH',
                headers: getAdminHeaders(true),
                body: JSON.stringify({ status: 'dismissed' })
              });
              await assertOkResponse(res, 'Failed to dismiss report');
              if (refresh) await refresh();
            }}
          />
        )}

        {/* MODULE 18: SUPPORT TICKETS */}
        {adminTab === 'support' && (
          <AdminSupportModule
            initialTickets={adminTickets}
            onReplyTicket={async (ticketId, replyText) => {
              const res = await fetch(`/api/admin/tickets/${ticketId}/reply`, {
                method: 'POST',
                headers: getAdminHeaders(true),
                body: JSON.stringify({ text: replyText })
              });
              await assertOkResponse(res, 'Failed to reply to ticket');
              if (refresh) await refresh();
            }}
            onUpdateTicketStatus={async (ticketId, status) => {
              const res = await fetch(`/api/admin/tickets/${ticketId}/status`, {
                method: 'PATCH',
                headers: getAdminHeaders(true),
                body: JSON.stringify({ status })
              });
              await assertOkResponse(res, 'Failed to update ticket status');
              if (refresh) await refresh();
            }}
          />
        )}

        {/* MODULE 19: CMS */}
        {adminTab === 'cms' && (
          <AdminCmsModule />
        )}

        {/* MODULE 20: SETTINGS (Real SiteFeeSettingsModule) */}
        {adminTab === 'settings' && (
          <SiteFeeSettingsModule
            currentUser={effectiveAdminUser}
            initialTakeRate={platformFee}
            initialClientServiceFee={clientServiceFee}
            initialSmallOrderFeeThreshold={smallOrderFeeThreshold}
            initialSmallOrderFeeAmount={smallOrderFeeAmount}
            initialEscrowHoldDays={escrowProtectionDays}
            onSettingsSaved={() => refresh()}
          />
        )}

        {/* MODULE 21: MEMBERSHIPS & QUOTAS */}
        {adminTab === 'memberships' && (
          <AdminMembershipsQuotasModule />
        )}

        {/* MODULE 9: PAYMENT GATEWAYS */}
        {(adminTab === 'paymentGateways' || adminTab === 'payments') && (
          <AdminPaymentGatewaysModule />
        )}

        {/* MODULE 23: ACTIVITY & AUDIT */}
        {(adminTab === 'security' || adminTab === 'activity') && (
          <AdminActivityModule
            initialLogs={adminAuditLogs}
            onRefreshLogs={fetchAuditLogs}
          />
        )}

        {/* FALLBACK FOR OTHER MODULES */}
        {!['overview', 'users', 'projects', 'gigs', 'categories', 'orders', 'proposals', 'contracts', 'payments', 'wallet', 'escrow', 'payouts', 'disputes', 'refunds', 'reviews', 'messages', 'reports', 'support', 'cms', 'settings', 'memberships', 'paymentGateways', 'security', 'activity'].includes(adminTab) && (
          <div className="bg-white border border-slate-200 rounded-3xl p-8 text-center space-y-3 shadow-xs">
            <ShieldCheck className="w-8 h-8 text-emerald-600 mx-auto" />
            <h3 className="text-base font-bold text-agency-dark uppercase">{adminTab} Module Active</h3>
            <p className="text-xs text-agency-muted">All data records and audit logs for this module are synchronized with PostgreSQL storage.</p>
          </div>
        )}
      </main>
    </div>
  );
};
