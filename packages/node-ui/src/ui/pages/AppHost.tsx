import React, { useCallback, useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';

export interface InstalledApp {
  id: string;
  label: string;
  path: string;
  staticUrl?: string;
}

/**
 * Hosts a DKG app in an iframe.
 *
 * When `staticUrl` is available, the iframe loads from a separate-origin
 * server (different port). This provides real browser isolation (same-origin
 * policy) without needing the `sandbox` attribute — so localStorage,
 * sessionStorage, and normal asset loading all work.
 *
 * Token is passed via postMessage handshake (app requests it, we respond).
 */
export function AppHostPage({ apps }: { apps: InstalledApp[] }) {
  const { appId } = useParams<{ appId: string }>();
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const app = apps.find(a => a.id === appId);

  const sendToken = useCallback(() => {
    const token = (window as any).__DKG_TOKEN__;
    if (token && iframeRef.current?.contentWindow) {
      iframeRef.current.contentWindow.postMessage(
        { type: 'dkg-token', token, apiOrigin: window.location.origin },
        '*',
      );
    }
  }, []);

  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (e.data?.type === 'dkg-token-request' && iframeRef.current?.contentWindow === e.source) {
        sendToken();
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [sendToken]);

  if (!app) {
    return (
      <div style={{ padding: 32, color: '#aaa' }}>
        App <strong>{appId}</strong> is not installed.
      </div>
    );
  }

  const iframeSrc = app.staticUrl || `${app.path}/`;

  return (
    <iframe
      ref={iframeRef}
      src={iframeSrc}
      onLoad={sendToken}
      style={{ width: '100%', height: '100%', border: 'none', borderRadius: 8, background: '#111' }}
      title={app.label}
    />
  );
}
