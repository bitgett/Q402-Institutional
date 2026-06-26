"use client";

/**
 * GoogleSigninButton — custom-styled "Continue with Google" button backed
 * by Google Identity Services (GIS).
 *
 * Why the overlay pattern: GIS only ships its own rendered button widget
 * with a fixed theme/size/shape API (filled_blue/large/pill). The large
 * white circular G mark on that widget reads as visually heavy next to
 * our other dark-glass buttons. To get full visual control without
 * losing GIS's verified ID-token flow, we render the GIS button at
 * opacity 0 so it still receives the click + handles the consent
 * popup, then layer our own styled markup on top with
 * `pointer-events: none` so clicks fall through.
 *
 * Env required:
 *   NEXT_PUBLIC_GOOGLE_CLIENT_ID — OAuth 2.0 Client ID from Google Cloud
 *   Console. Set "Authorized JavaScript origins" to the production +
 *   localhost URLs that render this button.
 *
 * When the env is missing we render a disabled stub with a console.warn —
 * preview deploys never throw on load, the operator sees the gap in logs.
 */

import { useEffect, useRef, useState } from "react";

interface GoogleAccountsId {
  initialize: (cfg: {
    client_id: string;
    callback: (resp: { credential: string }) => void;
    auto_select?: boolean;
    cancel_on_tap_outside?: boolean;
    locale?: string;
  }) => void;
  renderButton: (
    el: HTMLElement,
    opts: {
      type?: "standard" | "icon";
      theme?: "outline" | "filled_blue" | "filled_black";
      size?: "small" | "medium" | "large";
      text?: "signin_with" | "signup_with" | "continue_with";
      shape?: "rectangular" | "pill";
      logo_alignment?: "left" | "center";
      width?: number;
      locale?: string;
    },
  ) => void;
  prompt: () => void;
  disableAutoSelect: () => void;
}

declare global {
  interface Window {
    google?: {
      accounts: {
        id: GoogleAccountsId;
      };
    };
  }
}

const GIS_SCRIPT = "https://accounts.google.com/gsi/client?hl=en";

interface Props {
  onSuccess?: (data: {
    email: string;
    sandboxApiKey: string;
    hasWallet: boolean;
    name?: string;
  }) => void;
  onError?: (error: string) => void;
  /** Width in pixels — the GIS rendered button takes a fixed pixel-width API. */
  width?: number;
}

function GoogleGIcon({ className = "w-[18px] h-[18px]" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
      />
    </svg>
  );
}

export default function GoogleSigninButton({ onSuccess, onError, width = 320 }: Props) {
  const gisRef = useRef<HTMLDivElement | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;

  useEffect(() => {
    if (!clientId) {
      console.warn("[GoogleSigninButton] NEXT_PUBLIC_GOOGLE_CLIENT_ID is not set");
      return;
    }
    if (window.google?.accounts?.id) {
      setLoaded(true);
      return;
    }
    const existing = document.querySelector(`script[src="${GIS_SCRIPT}"]`);
    if (existing) {
      existing.addEventListener("load", () => setLoaded(true));
      return;
    }
    const script = document.createElement("script");
    script.src = GIS_SCRIPT;
    script.async = true;
    script.defer = true;
    script.onload = () => setLoaded(true);
    script.onerror = () => {
      console.error("[GoogleSigninButton] failed to load Google Identity Services");
      onError?.("Google sign-in script failed to load");
    };
    document.head.appendChild(script);
  }, [clientId, onError]);

  // Initialize GIS once it's loaded (re-runs only if the callbacks change),
  // kept separate from rendering so a width change doesn't re-initialize.
  useEffect(() => {
    if (!loaded || !clientId || !window.google) return;
    window.google.accounts.id.initialize({
      client_id: clientId,
      callback: async ({ credential }) => {
        if (!credential) return;
        setSubmitting(true);
        try {
          const res = await fetch("/api/auth/google", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ idToken: credential }),
          });
          const data = await res.json();
          if (!res.ok || !data.ok) {
            onError?.(data.error ?? "Google sign-in failed");
            return;
          }
          onSuccess?.(data);
        } catch (e) {
          onError?.(e instanceof Error ? e.message : "Google sign-in failed");
        } finally {
          setSubmitting(false);
        }
      },
      auto_select: false,
      cancel_on_tap_outside: true,
      locale: "en",
    });
  }, [loaded, clientId, onSuccess, onError]);

  // Render the GIS button (and re-render when the responsive width changes).
  // It sits beneath our overlay at opacity 0 and accepts the actual click that
  // triggers the consent popup. Clear the container first: GIS APPENDS a fresh
  // button on every renderButton call, so without this a width change would
  // stack duplicate hidden widgets.
  useEffect(() => {
    if (!loaded || !clientId || !gisRef.current || !window.google) return;
    gisRef.current.innerHTML = "";
    window.google.accounts.id.renderButton(gisRef.current, {
      type: "standard",
      theme: "filled_blue",
      size: "large",
      text: "continue_with",
      shape: "pill",
      logo_alignment: "left",
      width,
      locale: "en",
    });
  }, [loaded, clientId, width]);

  if (!clientId) {
    return (
      <div
        className="inline-flex items-center justify-center rounded-full bg-white/5 border border-white/10 text-white/30 text-xs font-medium px-6 py-3 cursor-not-allowed"
        style={{ width, maxWidth: "100%" }}
      >
        Google sign-in unavailable
      </div>
    );
  }

  return (
    <div
      className="relative inline-block overflow-hidden"
      style={{ width, height: 44, maxWidth: "100%" }}
    >
      {/* Hidden GIS button — receives the real click. Opacity 0 + auto
          pointer events keeps it operable while invisible. */}
      <div
        ref={gisRef}
        className="absolute inset-0 opacity-0"
        style={{ pointerEvents: "auto" }}
        aria-hidden="true"
      />

      {/* Visible styled overlay — pointer-events: none so clicks fall
          through to the hidden GIS button. group on the parent gives
          hover state via :group-hover descendants. */}
      <div
        className="absolute inset-0 flex items-center justify-center gap-2.5 rounded-full border transition-all"
        style={{
          pointerEvents: "none",
          background: "rgba(255,255,255,0.06)",
          borderColor: "rgba(255,255,255,0.10)",
        }}
      >
        <GoogleGIcon />
        <span className="text-white font-medium text-sm">
          {submitting ? "Signing in…" : loaded ? "Continue with Google" : "Loading…"}
        </span>
      </div>

      {/* Hover state — re-applied on the outer wrapper since :hover
          on a pointer-events: none element doesn't fire. */}
      <style jsx>{`
        div:hover > div:last-of-type {
          background: rgba(255, 255, 255, 0.1) !important;
          border-color: rgba(255, 255, 255, 0.18) !important;
        }
      `}</style>
    </div>
  );
}
