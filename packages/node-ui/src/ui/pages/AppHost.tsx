import React, { useCallback, useRef } from 'react';
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

  const handleLoad = useCallback(() => {
    const token = (window as any).__DKG_TOKEN__;
    if (token && iframeRef.current) {
      iframeRef.current.contentWindow?.postMessage(
        { type: 'dkg-token', token },
        window.location.origin,
      );
    }
  }, []);

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
      onLoad={handleLoad}
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
      style={{ width: '100%', height: '100%', border: 'none', borderRadius: 8, background: '#111' }}
      title={app.label}
    />
  );
}
