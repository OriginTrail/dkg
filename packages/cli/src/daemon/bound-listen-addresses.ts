type MultiaddrLike = { toString: () => string };

function stringifyMultiaddrList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((ma) => {
      try {
        return (ma as MultiaddrLike).toString();
      } catch {
        return '';
      }
    })
    .filter((addr) => addr.length > 0);
}

function listenerMultiaddrs(listener: unknown): string[] {
  const candidate = listener as {
    getAddrs?: () => unknown;
    getMultiaddrs?: () => unknown;
    addrs?: unknown;
    multiaddrs?: unknown;
  };
  if (typeof candidate?.getAddrs === 'function') {
    const addrs = stringifyMultiaddrList(candidate.getAddrs());
    if (addrs.length > 0) return addrs;
  }
  if (typeof candidate?.getMultiaddrs === 'function') {
    const addrs = stringifyMultiaddrList(candidate.getMultiaddrs());
    if (addrs.length > 0) return addrs;
  }
  const addrs = stringifyMultiaddrList(candidate?.addrs);
  if (addrs.length > 0) return addrs;
  return stringifyMultiaddrList(candidate?.multiaddrs);
}

export function getBoundListenMultiaddrs(libp2p: unknown): string[] | null {
  const node = libp2p as {
    components?: { transportManager?: unknown };
    services?: { transportManager?: unknown };
    transportManager?: unknown;
    getMultiaddrs?: () => unknown;
  };
  const managers = [
    node.components?.transportManager,
    node.services?.transportManager,
    node.transportManager,
  ];
  for (const manager of managers) {
    const getListeners = (manager as { getListeners?: () => unknown } | undefined)?.getListeners;
    if (typeof getListeners !== 'function') continue;
    const listeners = getListeners.call(manager);
    if (!Array.isArray(listeners)) continue;
    const addrs = listeners.flatMap((listener) => listenerMultiaddrs(listener));
    if (addrs.length > 0) return Array.from(new Set(addrs));
  }

  // If this libp2p shape does not expose transport listeners, prefer an
  // indeterminate result over treating advertised self-addresses as bound
  // listener evidence.
  return null;
}
