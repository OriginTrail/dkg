/**
 * Structural host interface consumed by the `build*Tools` builders.
 *
 * The tool definitions returned by `DkgNodePlugin.tools()` are pure metadata
 * whose `execute` callbacks delegate to the plugin's `handle*` methods. To
 * keep those definitions in cohesive sibling modules without coupling them to
 * the full `DkgNodePlugin` class, each builder receives a `DkgToolHost` — the
 * structural subset of `DkgNodePlugin` it actually calls. The `handle*` methods
 * stay `private` on `DkgNodePlugin` (so they are not part of its public/exported
 * type surface); `DkgNodePlugin.toolHost()` builds a bound object implementing
 * this interface and passes it to the builders. No behavior change: builders
 * simply forward to the same handler methods the inline definitions used to call.
 */
import type { OpenClawToolResult } from '../types.js';

type ToolArgs = Record<string, unknown>;

export interface DkgToolHost {
  handleStatus(): Promise<OpenClawToolResult>;
  handleWalletBalances(): Promise<OpenClawToolResult>;
  handleListContextGraphs(args: ToolArgs): Promise<OpenClawToolResult>;
  handleContextGraphCreate(args: ToolArgs): Promise<OpenClawToolResult>;
  handleContextGraphInvite(args: ToolArgs): Promise<OpenClawToolResult>;
  handleParticipantAdd(args: ToolArgs): Promise<OpenClawToolResult>;
  handleParticipantRemove(args: ToolArgs): Promise<OpenClawToolResult>;
  handleParticipantList(args: ToolArgs): Promise<OpenClawToolResult>;
  handleJoinRequestList(args: ToolArgs): Promise<OpenClawToolResult>;
  handleJoinRequestApprove(args: ToolArgs): Promise<OpenClawToolResult>;
  handleJoinRequestReject(args: ToolArgs): Promise<OpenClawToolResult>;
  handleSubscribe(args: ToolArgs): Promise<OpenClawToolResult>;
  handlePublish(args: ToolArgs): Promise<OpenClawToolResult>;
  handleQuery(args: ToolArgs): Promise<OpenClawToolResult>;
  handleQueryCatalogList(args: ToolArgs): Promise<OpenClawToolResult>;
  handleQueryCatalogRun(args: ToolArgs): Promise<OpenClawToolResult>;
  handleQueryCatalogSave(args: ToolArgs): Promise<OpenClawToolResult>;
  handleFindAgents(args: ToolArgs): Promise<OpenClawToolResult>;
  handleSendMessage(args: ToolArgs): Promise<OpenClawToolResult>;
  handleReadMessages(args: ToolArgs): Promise<OpenClawToolResult>;
  handleInvokeSkill(args: ToolArgs): Promise<OpenClawToolResult>;
  handleAssertionCreate(args: ToolArgs): Promise<OpenClawToolResult>;
  handleAssertionWrite(args: ToolArgs): Promise<OpenClawToolResult>;
  handleAssertionFinalize(args: ToolArgs): Promise<OpenClawToolResult>;
  handleAssertionPromote(args: ToolArgs): Promise<OpenClawToolResult>;
  handleAssertionPublish(args: ToolArgs): Promise<OpenClawToolResult>;
  handleAssertionPullFrom(args: ToolArgs): Promise<OpenClawToolResult>;
  handleAssertionDiscard(args: ToolArgs): Promise<OpenClawToolResult>;
  handleAssertionImportFile(args: ToolArgs): Promise<OpenClawToolResult>;
  handleAssertionQuery(args: ToolArgs): Promise<OpenClawToolResult>;
  handleImportArtifactResolve(args: ToolArgs): Promise<OpenClawToolResult>;
  handleImportArtifactReadMarkdown(args: ToolArgs): Promise<OpenClawToolResult>;
  handleSemanticEnrichmentWrite(args: ToolArgs): Promise<OpenClawToolResult>;
  handleAssertionHistory(args: ToolArgs): Promise<OpenClawToolResult>;
  handleSubGraphCreate(args: ToolArgs): Promise<OpenClawToolResult>;
  handleSubGraphList(args: ToolArgs): Promise<OpenClawToolResult>;
  handleSharedMemoryPublish(args: ToolArgs): Promise<OpenClawToolResult>;
  handleShare(args: ToolArgs): Promise<OpenClawToolResult>;
  handleMemorySearch(args: ToolArgs): Promise<OpenClawToolResult>;
}
