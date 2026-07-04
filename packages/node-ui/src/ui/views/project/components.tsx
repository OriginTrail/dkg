// This file was split into focused, feature-grouped modules under ./components/.
// It now serves purely as a barrel that re-exports the same public API, so that
// existing imports of '.../project/components.js' keep working unchanged.
// The real implementations live in ./components/*.

export { RdfGraph, LayerGraphPanel, SwmAttributionLegend, VerifiedGraphLegend } from './components/graph.js';
export {
  LayerSwitcher, ProjectHeaderStrip, curatorStatusForOverview,
  ProjectOverviewCard, PendingJoinRequestsSection, OverviewPrimerEntry,
} from './components/overview.js';
export type { CuratorStatus } from './components/overview.js';
export {
  GenWidget, TypeBreakdownWidget, LayerStatsWidget,
  PromoteWidget, PublishVmWidget, LayerWidgetStrip,
} from './components/layer-widgets.js';
export {
  EntityList, LayerContent, VerifiableMemoryHeroBanner,
  AssertionsList, LayerDetailView, DocumentsList,
} from './components/entities.js';
export { ContextGraphQueryView } from './components/query.js';
export {
  SubGraphBadge, VerifyOnDkgButton, KADetailView, ProvenanceTrail, TrailEvent,
} from './components/ka.js';
export {
  SubGraphExplorerHeader, SubGraphOverviewGrid, SubGraphMiniCard,
  MiniLayerBar, SubGraphTimeline, SubGraphDetailView,
} from './components/subgraph.js';
