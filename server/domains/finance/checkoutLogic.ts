export type SupportedGatewayId = 'paypal' | 'stripe' | 'razorpay';

export interface CheckoutSplitInput {
  orderTotal: number;
  walletBalance: number;
  useWallet: boolean;
}

export interface CheckoutSplitResult {
  orderTotal: number;
  walletApplied: number;
  gatewayAmount: number;
  payFullyWithWallet: boolean;
}

export interface PublicGatewayOption {
  id: SupportedGatewayId;
  label: string;
  subtitle: string;
  priority: number;
  enabled: boolean;
  configured: boolean;
  environment?: 'sandbox' | 'live';
}

export interface GatewayAvailabilityInput {
  paypal: {
    enabled: boolean;
    configured: boolean;
    environment?: 'sandbox' | 'live';
  };
  stripe: {
    enabled: boolean;
    configured: boolean;
  };
  razorpay: {
    enabled: boolean;
    configured: boolean;
  };
}

export function toCents(amount: number): number {
  if (!Number.isFinite(amount)) return 0;
  return Math.round(amount * 100);
}

export function fromCents(cents: number): number {
  return Number((cents / 100).toFixed(2));
}

/**
 * Pure cent-accurate calculator for direct, 100% wallet, and split (wallet + gateway) checkout.
 */
export function computeCheckoutSplit(input: CheckoutSplitInput): CheckoutSplitResult {
  const totalCents = Math.max(0, toCents(Number(input.orderTotal) || 0));
  const rawWalletCents = Math.max(0, toCents(Number(input.walletBalance) || 0));

  if (totalCents === 0) {
    return {
      orderTotal: 0,
      walletApplied: 0,
      gatewayAmount: 0,
      payFullyWithWallet: true,
    };
  }

  if (!input.useWallet || rawWalletCents <= 0) {
    return {
      orderTotal: fromCents(totalCents),
      walletApplied: 0,
      gatewayAmount: fromCents(totalCents),
      payFullyWithWallet: false,
    };
  }

  const walletAppliedCents = Math.min(totalCents, rawWalletCents);
  const gatewayCents = totalCents - walletAppliedCents;

  return {
    orderTotal: fromCents(totalCents),
    walletApplied: fromCents(walletAppliedCents),
    gatewayAmount: fromCents(gatewayCents),
    payFullyWithWallet: gatewayCents === 0,
  };
}

export type CanonicalPaymentMethodType =
  | 'bank_transfer'
  | 'wire_transfer'
  | 'paypal'
  | 'stripe'
  | 'razorpay'
  | 'card'
  | 'crypto'
  | 'upi'
  | 'other';

/**
 * Normalizes human-readable or snake_case payment method types into canonical identifiers
 * so masking and encryption rules can never be bypassed by casing or spaces.
 */
export function normalizePaymentMethodType(rawType: unknown): CanonicalPaymentMethodType {
  const cleaned = String(rawType || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');

  switch (cleaned) {
    case 'bank':
    case 'bank_transfer':
    case 'bank_account':
    case 'ach':
    case 'sepa':
    case 'iban':
      return 'bank_transfer';
    case 'wire':
    case 'wire_transfer':
    case 'swift':
      return 'wire_transfer';
    case 'paypal':
      return 'paypal';
    case 'stripe':
      return 'stripe';
    case 'razorpay':
      return 'razorpay';
    case 'card':
    case 'credit_card':
    case 'debit_card':
      return 'card';
    case 'crypto':
    case 'usdt':
    case 'usdc':
    case 'bitcoin':
    case 'btc':
    case 'eth':
      return 'crypto';
    case 'upi':
      return 'upi';
    default:
      return 'other';
  }
}

export function isBankLikePaymentMethod(rawType: unknown): boolean {
  const normalized = normalizePaymentMethodType(rawType);
  return normalized === 'bank_transfer' || normalized === 'wire_transfer';
}

export function isCardLikePaymentMethod(rawType: unknown): boolean {
  const normalized = normalizePaymentMethodType(rawType);
  return normalized === 'card' || normalized === 'stripe';
}

/**
 * Ensures redirect URLs returned to the browser are either relative internal paths
 * or safe http(s) URLs (blocking javascript:, data:, vbscript:, protocol-relative //, etc.).
 */
export function isSafeRedirectUrl(rawUrl: unknown, allowedOrigins?: string[]): boolean {
  if (typeof rawUrl !== 'string') return false;
  const trimmed = rawUrl.trim();
  if (!trimmed) return false;

  // Internal relative path (single leading slash, not protocol-relative //)
  if (trimmed.startsWith('/')) {
    if (trimmed.startsWith('//') || trimmed.includes('\\')) return false;
    return true;
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return false;
    }
    if (allowedOrigins && allowedOrigins.length > 0) {
      return allowedOrigins.includes(parsed.origin);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensures in-app return paths can only navigate to safe relative routes inside the SPA.
 */
export function sanitizeSafeReturnPath(rawPath: unknown, fallback = '/'): string {
  if (typeof rawPath !== 'string') return fallback;
  const trimmed = rawPath.trim();
  if (!trimmed.startsWith('/') || trimmed.startsWith('//') || trimmed.includes('\\')) {
    return fallback;
  }
  // Reject embedded control characters
  if (/[\r\n\t]/.test(trimmed)) return fallback;
  return trimmed;
}

/**
 * Builds the ordered list of hosted payment gateways for the checkout UI.
 * PayPal is always prioritized first, followed by Stripe and Razorpay.
 */
export function buildPublicGatewayOptions(
  input: GatewayAvailabilityInput,
  options?: { allowUnconfiguredInDev?: boolean }
): PublicGatewayOption[] {
  const allowDevFallback = Boolean(options?.allowUnconfiguredInDev);

  const catalog: PublicGatewayOption[] = [
    {
      id: 'paypal',
      label: 'PayPal',
      subtitle: 'Pay securely on PayPal',
      priority: 1,
      enabled: input.paypal.enabled && (input.paypal.configured || allowDevFallback),
      configured: input.paypal.configured,
      environment: input.paypal.environment,
    },
    {
      id: 'stripe',
      label: 'Card (Stripe)',
      subtitle: 'Credit or debit card via Stripe Checkout',
      priority: 2,
      enabled: input.stripe.enabled && (input.stripe.configured || allowDevFallback),
      configured: input.stripe.configured,
    },
    {
      id: 'razorpay',
      label: 'Razorpay',
      subtitle: 'UPI, NetBanking & Cards via Razorpay',
      priority: 3,
      enabled: input.razorpay.enabled && (input.razorpay.configured || allowDevFallback),
      configured: input.razorpay.configured,
    },
  ];

  return catalog.sort((a, b) => a.priority - b.priority);
}

/**
 * Neutralizes spreadsheet formula injection (CSV cells starting with =, +, -, @, tab, CR).
 */
export function sanitizeCsvCell(value: unknown): string {
  const str = String(value ?? '');
  const trimmedStart = str.replace(/^[\s]+/, '');
  const needsGuard =
    str.startsWith('=') ||
    str.startsWith('+') ||
    str.startsWith('-') ||
    str.startsWith('@') ||
    str.startsWith('\t') ||
    str.startsWith('\r') ||
    trimmedStart.startsWith('=') ||
    trimmedStart.startsWith('+') ||
    trimmedStart.startsWith('-') ||
    trimmedStart.startsWith('@');
  const safe = needsGuard ? `'${str}` : str;
  return `"${safe.replace(/"/g, '""')}"`;
}
