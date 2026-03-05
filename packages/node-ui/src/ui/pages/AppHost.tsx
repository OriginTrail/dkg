import React, { useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';

export function AppHostPage() {
  const { appId } = useParams<{ appId: string }>();
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const token = (window as any).__DKG_TOKEN__;
    if (!token || !iframeRef.current) return;

    const iframe = iframeRef.current;
    const onLoad = () => {
      iframe.contentWindow?.postMessage(
        { type: 'dkg-token', token },
        window.location.origin,
      );
    };
    iframe.addEventListener('load', onLoad);
    return () => iframe.removeEventListener('load', onLoad);
  }, [appId]);

  return (
    <iframe
      ref={iframeRef}
      src={`/apps/${appId}/`}
      style={{ width: '100%', height: '100%', border: 'none', borderRadius: 8, background: '#111' }}
      title={appId}
    />
  );
}
