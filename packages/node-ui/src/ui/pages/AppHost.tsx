import React, { useCallback, useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';

interface InstalledApp {
  id: string;
  label: string;
  path: string;
}

export function AppHostPage({ apps }: { apps: InstalledApp[] }) {
  const { appId } = useParams<{ appId: string }>();
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const app = apps.find(a => a.id === appId);

  const sendToken = useCallback(() => {
    const token = (window as any).__DKG_TOKEN__;
    if (token && iframeRef.current?.contentWindow) {
      iframeRef.current.contentWindow.postMessage(
        { type: 'dkg-token', token },
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

  return (
    <iframe
      ref={iframeRef}
      src={`${app.path}/`}
      onLoad={sendToken}
      sandbox="allow-scripts allow-forms allow-popups"
      style={{ width: '100%', height: '100%', border: 'none', borderRadius: 8, background: '#111' }}
      title={app.label}
    />
  );
}
