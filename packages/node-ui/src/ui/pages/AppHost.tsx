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
  const src = app ? `${app.path}/` : `/apps/${appId}/`;

  const handleLoad = useCallback(() => {
    const token = (window as any).__DKG_TOKEN__;
    if (token && iframeRef.current) {
      iframeRef.current.contentWindow?.postMessage(
        { type: 'dkg-token', token },
        window.location.origin,
      );
    }
  }, []);

  return (
    <iframe
      ref={iframeRef}
      src={src}
      onLoad={handleLoad}
      style={{ width: '100%', height: '100%', border: 'none', borderRadius: 8, background: '#111' }}
      title={app?.label ?? appId}
    />
  );
}
