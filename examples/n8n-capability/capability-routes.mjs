export const capabilityPrefix = (accountId = 'account-a') => '/spike/ka/accounts/' + accountId + '/capabilities';

/** HTTP policy shared by the bridge and preview. Handlers stay with their owning service. */
export const capabilityRoutes = Object.freeze([
  { id: 'studioComponentSave', path: '/studio/components', methods: ['POST'], role: 'owner', preview: true, exportHeader: false, bodyLimit: 16384, studio: true },
  { id: 'list', path: '', methods: ['GET'], role: 'member', preview: true, exportHeader: false, bodyLimit: 0 },
  { id: 'invoke', path: '/invoke', methods: ['POST'], role: 'owner', preview: true, exportHeader: true, bodyLimit: 16384 },
  { id: 'inspect', path: '/inspect', methods: ['GET'], role: 'member', preview: true, exportHeader: false, bodyLimit: 0 },
  { id: 'workflows', path: '/workflows', methods: ['GET'], role: 'member', preview: true, exportHeader: false, bodyLimit: 0 },
  { id: 'workflowSave', path: '/workflows/save', methods: ['POST'], role: 'owner', preview: true, exportHeader: true, bodyLimit: 16384 },
  { id: 'workflowRun', path: '/workflows/run', methods: ['POST'], role: 'owner', preview: true, exportHeader: true, bodyLimit: 16384 },
  { id: 'studio', path: '/studio', methods: ['GET'], role: 'member', preview: true, exportHeader: false, bodyLimit: 0, studio: true },
  { id: 'studioSave', path: '/studio/save', methods: ['POST'], role: 'owner', preview: true, exportHeader: true, bodyLimit: 16384, studio: true },
  { id: 'studioRun', path: '/studio/run', methods: ['POST'], role: 'owner', preview: true, exportHeader: true, bodyLimit: 16384, studio: true },
  { id: 'studioInvoke', path: '/studio/invoke', methods: ['POST'], role: 'owner', preview: true, exportHeader: true, bodyLimit: 16384, studio: true },
  { id: 'studioActivation', path: '/studio/activation', methods: ['POST'], role: 'owner', preview: true, exportHeader: true, bodyLimit: 16384, studio: true, legacyOnly: true },
  { id: 'studioHistory', path: '/studio/history', methods: ['GET'], role: 'member', preview: true, exportHeader: true, bodyLimit: 0, studio: true },
  { id: 'event', path: /^\/spike\/ka\/events\/(?<eventKey>[a-f0-9-]{36})$/, methods: ['POST'], role: 'delegated', preview: true, exportHeader: false, bodyLimit: 16384, studio: true, legacyOnly: true },
  { id: 'dkgComponent', path: '/spike/ka/internal/dkg-component', absolute: true, methods: ['POST'], role: 'native', preview: false, exportHeader: false, bodyLimit: 16384 },
  { id: 'demo', path: '/spike/ka/demo-data', absolute: true, methods: ['GET', 'POST'], role: 'public', preview: false, exportHeader: false, bodyLimit: 4096, optionalBody: true },
].map(route => Object.freeze({ ...route, methods: Object.freeze(route.methods) })));

export function matchCapabilityRoute(path, prefix = capabilityPrefix()) {
  for (const route of capabilityRoutes) {
    if (route.path instanceof RegExp) {
      const match = route.path.exec(path);
      if (match) return { route, params: match.groups };
    } else if (path === (route.absolute ? route.path : prefix + route.path)) return { route, params: {} };
  }
}
