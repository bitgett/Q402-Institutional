"use client";

/**
 * GoogleSigninButton — renders the "Continue with Google" button using
 * Google Identity Services (GIS). On click, GIS pops Google's consent
 * sheet, returns an ID token, and we POST it to /api/auth/google to
 * complete the session.
 *
 * Why GIS instead of NextAuth / a server-redirect flow:
 *   - Zero dependencies (script tag only)
 *   - Stays a SPA flow — no full-page redirect breaks the Hero animation
 *   - Token verification lives entirely on our backend (lib/google-auth.ts)
 *
 * Env required:
 *   NEXT_PUBLIC_GOOGLE_CLIENT_ID — OAuth 2.0 Client ID from Google Cloud
 *   Console. Set "Authorized JavaScript origins" to the production +
 *   localhost URLs that will render this button.
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

const GIS_SCRIPT = "https://accounts.google.com/gsi/client";

interface Props {
  /** Called after successful POST /api/auth/google. */
  onSuccess?: (data: {
    email: string;
    sandboxApiKey: string;
    hasWallet: boolean;
    name?: string;
  }) => void;
  onError?: (error: string) => void;
  /** Width in pixels, default 320 — Google's button has a fixed pixel-width API. */
  width?: number;
}

export default function GoogleSigninButton({ onSuccess, onError, width = 320 }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;

  useEffect(() => {
    if (!clientId) {
      console.warn("[GoogleSigninButton] NEXT_PUBLIC_GOOGLE_CLIENT_ID is not set");
      return;
    }

    // Idempotent script-tag inject. GIS notifies via `window.google` once
    // its bundle has parsed. Multiple mounts share the same load.
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

  useEffect(() => {
    if (!loaded || !clientId || !ref.current || !window.google) return;

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
    });
    window.google.accounts.id.renderButton(ref.current, {
      type: "standard",
      theme: "filled_blue",
      size: "large",
      text: "continue_with",
      shape: "pill",
      logo_alignment: "center",
      width,
    });
  }, [loaded, clientId, onSuccess, onError, width]);

  if (!clientId) {
    return (
      <div
        className="inline-flex items-center justify-center rounded-full bg-white/5 border border-white/10 text-white/30 text-xs font-medium px-6 py-3 cursor-not-allowed"
        style={{ width }}
      >
        Google sign-in unavailable (admin: set NEXT_PUBLIC_GOOGLE_CLIENT_ID)
      </div>
    );
  }

  return (
    <div className="relative inline-block" style={{ width }}>
      <div ref={ref} />
      {submitting && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/40 rounded-full">
          <span className="text-white/70 text-xs font-medium">Signing in…</span>
        </div>
      )}
    </div>
  );
}
