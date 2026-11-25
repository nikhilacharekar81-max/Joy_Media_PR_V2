import { getAuthToken } from './authToken';
import { getDeviceId } from './deviceId';

export type SupportedGateway = 'paypal' | 'stripe' | 'razorpay';

export interface CheckoutReturnMetadata {
  returnAction?:
    | 'wallet_topup'
    | 'create_gig_order'
    | 'accept_proposal'
    | 'accept_offer'
    | 'escrow_deposit'
    | 'feature_gig';
  returnPath?: string;
  title?: string;
  directOrderCheckout?: boolean;
  orderTotal?: number;
  walletApplied?: number;
  gatewayAmount?: number;
  orderFunded?: boolean;
  partialFundingRequired?: boolean;
  shortfallAmount?: number;
  gigOrderPayload?: {
    title: string;
    amount: number;
    buyerId?: string;
    sellerId: string;
    gigId?: string;
    extraIds?: string[];
    dueDate?: string;
    requirements?: string;
  };
  proposalId?: string;
  projectId?: string;
  offerId?: string;
  orderId?: string;
  escrowPayload?: {
    orderId: string;
    amount: number;
    title?: string;
  };
  featureGigId?: string;
  actionCompleted?: boolean;
  actionResult?: any;
}

export interface InitiateGatewayCheckoutParams {
  amount: number;
  currency?: string;
  gateway?: SupportedGateway;
  purpose?: 'deposit' | 'order_payment' | 'escrow_funding';
  orderId?: string;
  description?: string;
  metadata?: CheckoutReturnMetadata;
  headers?: Record<string, string>;
}

export interface StartUnifiedCheckoutParams {
  purpose: 'order_payment' | 'wallet_topup';
  gigId?: string;
  extraIds?: string[];
  orderId?: string;
  amount?: number;
  requirements?: string;
  gateway?: SupportedGateway;
  useWallet?: boolean;
  returnPath?: string;
  headers?: Record<string, string>;
}

export interface StartUnifiedCheckoutResult {
  success: boolean;
  paidImmediately: boolean;
  redirected: boolean;
  orderId?: string;
  workspaceId?: string;
  order?: any;
  sessionId?: string;
  gateway: string;
  orderTotal: number;
  walletApplied: number;
  gatewayAmount: number;
  redirectUrl?: string;
}

/**
 * Validates that a redirect URL is either a safe relative app path or an http(s) URL.
 * Blocks javascript:, data:, vbscript:, and protocol-relative // URLs.
 */
export function isSafeBrowserRedirectUrl(rawUrl: unknown): boolean {
  if (typeof rawUrl !== 'string') return false;
  const trimmed = rawUrl.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('/')) {
    return !trimmed.startsWith('//') && !trimmed.includes('\\');
  }
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * Sanitizes an internal app path to guarantee navigation stays within this SPA.
 */
export function sanitizeInternalPath(rawPath: unknown, fallback = '/'): string {
  if (typeof rawPath !== 'string') return fallback;
  const trimmed = rawPath.trim();
  if (!trimmed.startsWith('/') || trimmed.startsWith('//') || trimmed.includes('\\')) {
    return fallback;
  }
  if (/[\r\n\t]/.test(trimmed)) return fallback;
  return trimmed;
}

export async function startUnifiedCheckout(
  params: StartUnifiedCheckoutParams
): Promise<StartUnifiedCheckoutResult> {
  const token = getAuthToken();
  const reqHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-device-id': getDeviceId(),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(params.headers || {})
  };

  const res = await fetch('/api/checkout/start', {
    method: 'POST',
    headers: reqHeaders,
    body: JSON.stringify({
      purpose: params.purpose,
      ...(params.gigId ? { gigId: params.gigId } : {}),
      ...(params.extraIds ? { extraIds: params.extraIds } : {}),
      ...(params.orderId ? { orderId: params.orderId } : {}),
      ...(params.amount !== undefined ? { amount: Number(Number(params.amount).toFixed(2)) } : {}),
      ...(params.requirements ? { requirements: params.requirements } : {}),
      ...(params.gateway ? { gateway: params.gateway } : {}),
      useWallet: Boolean(params.useWallet),
      ...(params.returnPath ? { returnPath: sanitizeInternalPath(params.returnPath, '/') } : {})
    })
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Failed to start checkout (HTTP ${res.status}).`);
  }

  if (data.paidImmediately) {
    return {
      success: true,
      paidImmediately: true,
      redirected: false,
      orderId: data.orderId,
      workspaceId: data.workspaceId,
      order: data.order,
      gateway: data.gateway || 'wallet',
      orderTotal: Number(data.orderTotal || 0),
      walletApplied: Number(data.walletApplied || 0),
      gatewayAmount: 0,
      redirectUrl: data.redirectUrl
    };
  }

  if (data.redirectUrl && isSafeBrowserRedirectUrl(data.redirectUrl) && typeof window !== 'undefined') {
    window.location.href = data.redirectUrl;
    return {
      success: true,
      paidImmediately: false,
      redirected: true,
      orderId: data.orderId,
      workspaceId: data.workspaceId,
      sessionId: data.sessionId || data.checkoutId,
      gateway: data.gateway || params.gateway || 'paypal',
      orderTotal: Number(data.orderTotal || data.amount || 0),
      walletApplied: Number(data.walletApplied || 0),
      gatewayAmount: Number(data.gatewayAmount || data.amount || 0),
      redirectUrl: data.redirectUrl
    };
  }

  throw new Error('Payment gateway did not return a valid secure checkout URL.');
}

export async function initiateGatewayCheckout(
  params: InitiateGatewayCheckoutParams
): Promise<{ redirected: boolean; sessionId: string; redirectUrl: string; providerOrderId?: string }> {
  const token = getAuthToken();
  const cleanAmount = Math.max(1, Number(Number(params.amount || 0).toFixed(2)));
  const reqHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-device-id': getDeviceId(),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(params.headers || {})
  };

  const res = await fetch('/api/payments/gateway/checkout', {
    method: 'POST',
    headers: reqHeaders,
    body: JSON.stringify({
      amount: cleanAmount,
      currency: params.currency || 'USD',
      ...(params.gateway ? { gateway: params.gateway } : {}),
      purpose: params.purpose || 'deposit',
      ...(params.orderId ? { orderId: params.orderId } : {}),
      ...(params.description ? { description: params.description } : {}),
      ...(params.metadata ? { metadata: params.metadata } : {})
    })
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Failed to initialize payment gateway checkout (HTTP ${res.status}).`);
  }

  if (data.redirectUrl && isSafeBrowserRedirectUrl(data.redirectUrl) && typeof window !== 'undefined') {
    window.location.href = data.redirectUrl;
    return {
      redirected: true,
      sessionId: data.sessionId,
      redirectUrl: data.redirectUrl,
      providerOrderId: data.providerOrderId
    };
  }

  throw new Error('Payment gateway did not return a valid secure approval URL.');
}
