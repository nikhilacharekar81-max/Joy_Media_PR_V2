import React, { useState, useEffect } from 'react';
import { RefreshCw, AlertCircle } from 'lucide-react';
import { UserAccount } from '../../types';
import { setAuthToken } from '../../utils/authToken';
import { getDeviceId } from '../../utils/deviceId';

interface GoogleAuthButtonProps {
  mode: 'login' | 'signup';
  onAuthSuccess: (user: UserAccount, token: string) => void;
  onAuthError?: (message: string) => void;
}

export const GoogleAuthButton: React.FC<GoogleAuthButtonProps> = ({
  mode,
  onAuthSuccess,
  onAuthError
}) => {
  const [isLoading, setIsLoading] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (typeof window === 'undefined' || event.origin !== window.location.origin) {
        return;
      }

      if (event.data?.type === 'OAUTH_AUTH_SUCCESS' && event.data?.token && event.data?.user) {
        setIsLoading(false);
        setAuthToken(event.data.token);
        onAuthSuccess(event.data.user, event.data.token);
      } else if (event.data?.type === 'OAUTH_AUTH_ERROR') {
        setIsLoading(false);
        const msg = event.data.error || 'Google authentication failed.';
        setLocalError(msg);
        if (onAuthError) onAuthError(msg);
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [onAuthSuccess, onAuthError]);

  const handleGoogleClick = async () => {
    setLocalError(null);
    setIsLoading(true);
    try {
      const origin = typeof window !== 'undefined' ? window.location.origin : '';
      const deviceId = getDeviceId();
      const res = await fetch(
        `/api/auth/google/url?origin=${encodeURIComponent(origin)}&deviceId=${encodeURIComponent(deviceId)}`
      );
      const data = await res.json();

      if (res.ok && data.configured && data.url) {
        const width = 520;
        const height = 640;
        const left = window.screenX + Math.max(0, (window.outerWidth - width) / 2);
        const top = window.screenY + Math.max(0, (window.outerHeight - height) / 2);
        const popup = window.open(
          data.url,
          'google_oauth_popup',
          `width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=yes`
        );
        if (!popup) {
          setIsLoading(false);
          const msg = 'Popup was blocked by your browser. Please allow popups for this site.';
          setLocalError(msg);
          if (onAuthError) onAuthError(msg);
        }
        return;
      }

      setIsLoading(false);
      const msg = 'Google Sign-In is not configured on this server. Please use email and password instead.';
      setLocalError(msg);
      if (onAuthError) onAuthError(msg);
    } catch (err: any) {
      setIsLoading(false);
      const msg = err?.message || 'Unable to initialize Google authentication.';
      setLocalError(msg);
      if (onAuthError) onAuthError(msg);
    }
  };

  return (
    <div className="space-y-3 mb-4">
      <button
        type="button"
        onClick={handleGoogleClick}
        disabled={isLoading}
        className="w-full py-2.5 px-4 bg-white hover:bg-slate-50 active:bg-slate-100 text-slate-800 font-bold text-xs rounded-xl border border-slate-300 shadow-2xs transition flex items-center justify-center gap-2.5 cursor-pointer disabled:opacity-60"
      >
        {isLoading ? (
          <RefreshCw className="w-4 h-4 animate-spin text-slate-600" />
        ) : (
          <svg className="w-4 h-4 shrink-0" viewBox="0 0 48 48" aria-hidden="true">
            <path
              fill="#EA4335"
              d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
            />
            <path
              fill="#4285F4"
              d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
            />
            <path
              fill="#FBBC05"
              d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
            />
            <path
              fill="#34A853"
              d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
            />
          </svg>
        )}
        <span>{mode === 'signup' ? 'Register with Google' : 'Continue with Google'}</span>
      </button>

      {localError && (
        <div className="p-2.5 bg-red-50 border border-red-200 rounded-xl text-[11px] text-red-800 flex items-center gap-1.5">
          <AlertCircle className="w-3.5 h-3.5 text-red-600 shrink-0" />
          <span>{localError}</span>
        </div>
      )}

      <div className="relative flex items-center justify-center">
        <div className="border-t border-slate-200 w-full" />
        <span className="bg-white px-2.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400 shrink-0">
          or with email
        </span>
        <div className="border-t border-slate-200 w-full" />
      </div>
    </div>
  );
};
