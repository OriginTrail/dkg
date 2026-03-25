import React, { createContext, useContext, useState, useEffect, type ReactNode } from 'react';

interface TokenContextValue {
  token: string | null;
  apiOrigin: string;
  ready: boolean;
}

const TokenContext = createContext<TokenContextValue>({ token: null, apiOrigin: '', ready: false });

export function useToken() {
  return useContext(TokenContext);
}

export function TokenProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>((window as any).__DKG_TOKEN__ ?? null);
  const [apiOrigin, setApiOrigin] = useState<string>((window as any).__DKG_API_ORIGIN__ ?? '');
  const [ready, setReady] = useState(!!token);

  useEffect(() => {
    if (token) { setReady(true); return; }

    const timer = setTimeout(() => setReady(true), 2000);

    const handler = (e: MessageEvent) => {
      if (e.data?.type === 'dkg-token' && typeof e.data.token === 'string') {
        setToken(e.data.token);
        if (typeof e.data.apiOrigin === 'string') setApiOrigin(e.data.apiOrigin);
        setReady(true);
        clearTimeout(timer);
      }
    };

    window.addEventListener('message', handler);
    return () => { window.removeEventListener('message', handler); clearTimeout(timer); };
  }, [token]);

  return (
    <TokenContext.Provider value={{ token, apiOrigin, ready }}>
      {children}
    </TokenContext.Provider>
  );
}
