import React, { useCallback, useEffect, useRef, useState } from 'react';
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
 * The iframe is sandboxed with `allow-scripts allow-forms allow-popups`.
 * `allow-same-origin` is intentionally omitted: all apps currently share
 * one static-server origin, so enabling it would let apps interfere with
 * each other's storage and service workers. Apps that need persistent
 * state should use the DKG API rather than localStorage.
 *
 * When `staticUrl` is present, the iframe loads from a separate-origin
 * server (different port) for real cross-origin isolation. Otherwise it
 * falls back to serving from the main server path.
 *
 * Token + apiOrigin are passed via postMessage handshake.
 */
export function AppHostPage({ apps }: { apps: InstalledApp[] }) {
  const { appId } = useParams<{ appId: string }>();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [src, setSrc] = useState<string | null>(null);
  const triedStatic = useRef(false);

  const app = apps.find(a => a.id === appId);

  useEffect(() => {
    if (!app) return;
    let cancelled = false;
    triedStatic.current = false;
    setSrc(null);

    if (app.staticUrl) {
      fetch(app.staticUrl, { method: 'HEAD' })
        .then(r => {
          if (!cancelled) setSrc(r.ok ? app.staticUrl! : `${app.path}/`);
        })
        .catch(() => { if (!cancelled) setSrc(`${app.path}/`); });
    } else {
      setSrc(`${app.path}/`);
    }
    return () => { cancelled = true; };
  }, [app?.id, app?.staticUrl, app?.path]);

  const sendToken = useCallback(() => {
    const token = (window as any).__DKG_TOKEN__;
    if (token && iframeRef.current?.contentWindow) {
      iframeRef.current.contentWindow.postMessage(
        { type: 'dkg-token', token, apiOrigin: window.location.origin },
        '*',
      );
    }
  }, []);

  const handleError = useCallback(() => {
    if (!app) return;
    if (app.staticUrl && !triedStatic.current) {
      triedStatic.current = true;
      setSrc(`${app.path}/`);
    }
  }, [app]);

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
      <div style={{ padding: 32, color: 'var(--text-muted)' }}>
        App <strong>{appId}</strong> is not installed.
      </div>
    );
  }

  if (!src) return null;

  return (
    <iframe
      ref={iframeRef}
      src={src}
      onLoad={sendToken}
      onError={handleError}
      sandbox="allow-scripts allow-forms allow-popups"
      style={{ width: '100%', height: '100%', border: 'none', borderRadius: 8, background: 'var(--surface)' }}
      title={app.label}
    />
  );
}
