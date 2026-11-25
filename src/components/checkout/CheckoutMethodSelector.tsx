import React, { useEffect, useState } from 'react';
import { Check, CreditCard, Globe, Lock, ShieldCheck, Wallet } from 'lucide-react';
import type { SupportedGateway } from '../../utils/gatewayCheckout';

export interface PublicGatewayInfo {
  id: SupportedGateway;
  label: string;
  subtitle: string;
  priority: number;
  enabled: boolean;
  configured: boolean;
  environment?: 'sandbox' | 'live';
}

interface CachedGateways {
  fetchedAt: number;
  gateways: PublicGatewayInfo[];
}

const DEFAULT_GATEWAYS: PublicGatewayInfo[] = [
  {
    id: 'paypal',
    label: 'PayPal',
    subtitle: 'Pay securely on PayPal',
    priority: 1,
    enabled: true,
    configured: false,
    environment: 'sandbox',
  },
  {
    id: 'stripe',
    label: 'Card (Stripe)',
    subtitle: 'Credit or debit card via Stripe Checkout',
    priority: 2,
    enabled: true,
    configured: false,
  },
  {
    id: 'razorpay',
    label: 'Razorpay',
    subtitle: 'UPI, NetBanking & Cards via Razorpay',
    priority: 3,
    enabled: true,
    configured: false,
  },
];

let gatewayCache: CachedGateways | null = null;

function formatUsd(amount: number): string {
  const safe = Number.isFinite(amount) ? amount : 0;
  return `$${safe.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export interface CheckoutMethodSelectorProps {
  orderTotal: number;
  walletBalance?: number;
  selectedGateway: SupportedGateway;
  onSelectGateway: (gw: SupportedGateway) => void;
  useWallet?: boolean;
  onToggleWallet?: (use: boolean) => void;
  showWalletOption?: boolean;
  compact?: boolean;
}

export const CheckoutMethodSelector: React.FC<CheckoutMethodSelectorProps> = ({
  orderTotal,
  walletBalance = 0,
  selectedGateway,
  onSelectGateway,
  useWallet = false,
  onToggleWallet,
  showWalletOption = true,
  compact = false,
}) => {
  const [gateways, setGateways] = useState<PublicGatewayInfo[]>(
    gatewayCache ? gatewayCache.gateways : DEFAULT_GATEWAYS
  );

  useEffect(() => {
    let cancelled = false;
    const now = Date.now();
    if (gatewayCache && now - gatewayCache.fetchedAt < 60_000) {
      setGateways(gatewayCache.gateways);
      return;
    }

    fetch('/api/payments/gateways/public')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled || !data || !Array.isArray(data.gateways)) return;
        const enabledList = data.gateways.filter((g: PublicGatewayInfo) => g.enabled);
        const list = enabledList.length > 0 ? enabledList : DEFAULT_GATEWAYS;
        gatewayCache = { fetchedAt: Date.now(), gateways: list };
        setGateways(list);
        if (!list.some((g: PublicGatewayInfo) => g.id === selectedGateway)) {
          onSelectGateway(list[0].id);
        }
      })
      .catch(() => {
        // Keep default fallback list gracefully
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const safeTotal = Math.max(0, Number(orderTotal || 0));
  const safeBalance = Math.max(0, Number(walletBalance || 0));
  const canUseWallet = showWalletOption && safeBalance > 0 && Boolean(onToggleWallet);

  const rawWalletApplied = canUseWallet && useWallet ? Math.min(safeTotal, safeBalance) : 0;
  let walletApplied = Number(rawWalletApplied.toFixed(2));
  let gatewayAmount = Number(Math.max(0, safeTotal - walletApplied).toFixed(2));
  // Align with server $1.00 gateway minimum on split checkouts
  if (gatewayAmount > 0 && gatewayAmount < 1 && safeTotal >= 1) {
    walletApplied = Number(Math.max(0, safeTotal - 1).toFixed(2));
    gatewayAmount = Number((safeTotal - walletApplied).toFixed(2));
  }
  const fullyCoveredByWallet = canUseWallet && useWallet && gatewayAmount === 0 && safeTotal > 0;

  const activeGatewayObj = gateways.find((g) => g.id === selectedGateway) || gateways[0];

  return (
    <div className={compact ? 'space-y-3' : 'space-y-3.5 pt-4 border-t border-slate-100'}>
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-bold uppercase tracking-wider text-slate-700">
          Payment Method
        </span>
        <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-emerald-700">
          <Lock className="w-3 h-3" />
          Hosted Checkout
        </span>
      </div>

      {/* Optional Account Credit / Wallet Toggle */}
      {canUseWallet && (
        <label
          className={`flex items-start gap-2.5 p-3 rounded-2xl border cursor-pointer transition-all ${
            useWallet
              ? 'bg-emerald-50/70 border-emerald-300'
              : 'bg-slate-50 border-slate-200 hover:bg-slate-100/80'
          }`}
        >
          <input
            type="checkbox"
            checked={useWallet}
            onChange={(e) => onToggleWallet?.(e.target.checked)}
            className="mt-0.5 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500 w-4 h-4 shrink-0 cursor-pointer"
          />
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-bold text-slate-900 flex items-center gap-1.5">
                <Wallet className="w-3.5 h-3.5 text-emerald-600" />
                Apply Account Credit
              </span>
              <span className="text-[11px] font-bold text-emerald-700 shrink-0">
                {formatUsd(safeBalance)} available
              </span>
            </div>
            {useWallet && (
              <p className="text-[11px] text-slate-600 mt-1">
                {fullyCoveredByWallet ? (
                  <span className="text-emerald-700 font-semibold">
                    Covers 100% of this order ({formatUsd(walletApplied)}) — instant activation.
                  </span>
                ) : (
                  <span>
                    Uses <strong className="text-slate-900">{formatUsd(walletApplied)}</strong> credit +{' '}
                    <strong className="text-slate-900">{formatUsd(gatewayAmount)}</strong> via{' '}
                    {activeGatewayObj?.label || 'PayPal'}.
                  </span>
                )}
              </p>
            )}
          </div>
        </label>
      )}

      {/* Hosted Payment Gateways (PayPal #1, Stripe #2, Razorpay #3) */}
      {!fullyCoveredByWallet && (
        <div className="space-y-2" role="radiogroup" aria-label="Choose hosted payment gateway">
          {gateways.map((gw) => {
            const isSelected = selectedGateway === gw.id;
            return (
              <button
                key={gw.id}
                type="button"
                role="radio"
                aria-checked={isSelected}
                onClick={() => onSelectGateway(gw.id)}
                className={`w-full text-left px-3.5 py-2.5 rounded-2xl border transition-all flex items-center justify-between gap-3 cursor-pointer ${
                  isSelected
                    ? 'bg-slate-900 text-white border-slate-900 shadow-xs'
                    : 'bg-white text-slate-800 border-slate-200 hover:border-slate-300 hover:bg-slate-50'
                }`}
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <div
                    className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 ${
                      isSelected
                        ? 'bg-white/15 text-white'
                        : gw.id === 'paypal'
                        ? 'bg-blue-50 text-blue-700'
                        : gw.id === 'stripe'
                        ? 'bg-indigo-50 text-indigo-700'
                        : 'bg-sky-50 text-sky-700'
                    }`}
                  >
                    {gw.id === 'stripe' ? (
                      <CreditCard className="w-4 h-4" />
                    ) : gw.id === 'razorpay' ? (
                      <Globe className="w-4 h-4" />
                    ) : (
                      <ShieldCheck className="w-4 h-4" />
                    )}
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-bold truncate">{gw.label}</span>
                      {gw.id === 'paypal' && (
                        <span
                          className={`text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-md ${
                            isSelected ? 'bg-emerald-500/25 text-emerald-200' : 'bg-blue-50 text-blue-700'
                          }`}
                        >
                          Recommended
                        </span>
                      )}
                    </div>
                    <span
                      className={`text-[11px] block truncate ${
                        isSelected ? 'text-slate-300' : 'text-slate-500'
                      }`}
                    >
                      {gw.subtitle}
                    </span>
                  </div>
                </div>
                <div
                  className={`w-5 h-5 rounded-full flex items-center justify-center shrink-0 border ${
                    isSelected
                      ? 'bg-emerald-500 border-emerald-500 text-white'
                      : 'border-slate-300 bg-white'
                  }`}
                >
                  {isSelected && <Check className="w-3 h-3 stroke-[3]" />}
                </div>
              </button>
            );
          })}

          <p className="text-[11px] text-slate-500 leading-relaxed pt-0.5">
            You&apos;ll complete payment on{' '}
            <span className="font-semibold text-slate-700">
              {selectedGateway === 'stripe'
                ? 'Stripe Checkout'
                : selectedGateway === 'razorpay'
                ? 'Razorpay'
                : 'PayPal'}
            </span>{' '}
            and return automatically to activate your {showWalletOption ? 'order' : 'account credit'}.
          </p>
        </div>
      )}
    </div>
  );
};
