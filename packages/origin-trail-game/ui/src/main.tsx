import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';

let rendered = false;
const root = createRoot(document.getElementById('root')!);

function renderApp() {
  if (rendered) return;
  rendered = true;
  root.render(<App />);
}

window.addEventListener('message', (e) => {
  if (e.data?.type === 'dkg-nonce' && typeof e.data.nonce === 'string') {
    window.parent.postMessage({ type: 'dkg-token-request', nonce: e.data.nonce }, '*');
  } else if (e.data?.type === 'dkg-token' && typeof e.data.token === 'string') {
    (window as any).__DKG_TOKEN__ = e.data.token;
    if (typeof e.data.apiOrigin === 'string') {
      (window as any).__DKG_API_ORIGIN__ = e.data.apiOrigin;
    }
    renderApp();
  }
});

// If token is already injected via script tag (same-origin serving), render immediately
if ((window as any).__DKG_TOKEN__) {
  renderApp();
} else {
  // Fallback: render after timeout in case handshake doesn't happen (e.g. direct access)
  setTimeout(renderApp, 2000);
}
