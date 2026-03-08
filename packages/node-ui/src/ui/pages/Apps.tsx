import React, { useEffect, useRef, useCallback } from 'react';

/**
 * Renders the OriginTrail Game inside the Node Dashboard by embedding
 * its standalone UI in an iframe. This avoids duplicating game code
 * and ensures the dashboard always shows the latest game UI.
 */
export function AppsPage() {
  const iframeRef = useRef<HTMLIFrameElement>(null);

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

  return (
    <iframe
      ref={iframeRef}
      src="/apps/origin-trail-game/"
      onLoad={sendToken}
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
