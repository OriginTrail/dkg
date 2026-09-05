// Compatibility entry point. The canonical reason/disposition model lives in
// context-graph-agent-gate-authority.ts alongside gate precedence and error
// conversion so adding an authority reason requires one policy edit.
export {
  CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE_CODE,
  CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE_ERROR_NAME,
  CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE_REASONS,
  ContextGraphAuthorityUnavailableError,
  isContextGraphAuthorityUnavailableMarker,
  type ContextGraphAuthorityUnavailableMarker,
  type ContextGraphAuthorityUnavailableReason,
} from './context-graph-agent-gate-authority.js';
