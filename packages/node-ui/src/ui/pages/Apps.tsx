import React, { useEffect, useRef, useCallback, useState } from 'react';
import type { InstalledApp } from './AppHost.js';

const GAME_APP_ID = 'origin-trail-game';
const FALLBACK_PATH = '/apps/origin-trail-game/';

/**
 * Hosts the OriginTrail Game in an iframe, matching the isolation model
 * used by AppHostPage: when a separate-origin static server is available,
 * the iframe loads from that origin so `allow-same-origin` can be omitted
 * and real cross-origin isolation is enforced. Falls back to the main
 * server path otherwise.
 *
 * Token + apiOrigin are delivered via a nonce-based postMessage handshake.
 * A fresh nonce is issued on every iframe load; only matching nonces
 * receive the token.
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

  const isSeparateOrigin = src !== FALLBACK_PATH;

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
      sandbox={isSeparateOrigin
        ? 'allow-scripts allow-forms allow-popups'
        : 'allow-scripts allow-same-origin allow-forms allow-popups'}
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
