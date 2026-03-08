import React, { useEffect, useRef, useCallback, useState } from 'react';
import type { InstalledApp } from './AppHost.js';

const GAME_APP_ID = 'origin-trail-game';
const FALLBACK_PATH = '/apps/origin-trail-game/';

/**
 * Hosts the OriginTrail Game in an iframe with `allow-scripts` sandbox
 * (no `allow-same-origin`), matching the AppHostPage isolation model.
 * The iframe's effective origin is opaque (`null`), so it cannot access
 * parent DOM or token globals. CORS (`Access-Control-Allow-Origin: *`)
 * on the API server allows the iframe to make authenticated fetch calls
 * using the token injected into its HTML by the daemon's loopback
 * fallback, or delivered via the postMessage nonce handshake.
 */

export function validateTokenRequest(
  nonce: string | null,
  requestNonce: unknown,
): boolean {
  return typeof requestNonce === 'string' && nonce !== null && requestNonce === nonce;
}

export function AppsPage({ apps }: { apps?: InstalledApp[] }) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const nonceRef = useRef<string | null>(null);
  const app = apps?.find(a => a.id === GAME_APP_ID);
  const [src, setSrc] = useState(app?.staticUrl || FALLBACK_PATH);
  const triedStaticRef = useRef(false);

  useEffect(() => {
    triedStaticRef.current = false;
    setSrc(app?.staticUrl || FALLBACK_PATH);
  }, [app?.staticUrl]);

  const handleIframeError = useCallback(() => {
    if (app?.staticUrl && !triedStaticRef.current) {
      triedStaticRef.current = true;
      setSrc(FALLBACK_PATH);
    }
  }, [app?.staticUrl]);

  const sendNonce = useCallback(() => {
    if (!iframeRef.current?.contentWindow) return;
    const nonce = crypto.randomUUID();
    nonceRef.current = nonce;
    iframeRef.current.contentWindow.postMessage({ type: 'dkg-nonce', nonce }, '*');
  }, []);

  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (
        e.data?.type === 'dkg-token-request' &&
        iframeRef.current?.contentWindow === e.source &&
        validateTokenRequest(nonceRef.current, e.data.nonce)
      ) {
        nonceRef.current = null;
        const token = (window as any).__DKG_TOKEN__;
        if (token) {
          iframeRef.current.contentWindow!.postMessage(
            { type: 'dkg-token', token, apiOrigin: window.location.origin },
            '*',
          );
        }
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  return (
    <iframe
      ref={iframeRef}
      src={src}
      onLoad={sendNonce}
      onError={handleIframeError}
      sandbox="allow-scripts allow-forms allow-popups"
      allow="clipboard-write"
      style={{
        width: '100%',
        height: '100%',
        border: 'none',
        borderRadius: 8,
        background: '#111',
      }}
      title="OriginTrail Game"
    />
  );
}
