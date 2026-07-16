/**
 * Data-loading wrapper around <AgentProfileView>. Lives in /components
 * rather than /pages because it's a shared "project-sub-view" that uses
 * the same hooks ProjectView uses (useMemoryEntities, useProjectProfile,
 * useAgents) and wraps its children in the same contexts.
 *
 * Tab encoding: `agent:<projectId>|<agentSlug>` — see PanelCenter.
 */
import React from 'react';
import { useMemoryEntities } from '../hooks/useMemoryEntities.js';
import { useProjectProfile, ProjectProfileContext } from '../hooks/useProjectProfile.js';
import { useAgents, AgentsContext } from '../hooks/useAgents.js';
import { useTabsStore } from '../stores/tabs.js';
import { useProjectsStore } from '../stores/projects.js';
import { AgentProfileView } from './AgentProfileView.js';

export interface AgentProfilePageProps {
  contextGraphId: string;
  agentUri: string;
}

export const AgentProfilePage: React.FC<AgentProfilePageProps> = ({
  contextGraphId,
  agentUri,
}) => {
  const profile = useProjectProfile(contextGraphId);
  const agentsData = useAgents(contextGraphId);
  const memory = useMemoryEntities(contextGraphId);
  const { openTab, closeTab, activeTabId } = useTabsStore();
  const { setActiveProject } = useProjectsStore();

  const selectEntity = React.useCallback((uri: string) => {
    // Entities open in the project tab, which is the natural parent;
    // select it + set the URL-style marker the project view picks up.
    setActiveProject(contextGraphId);
    openTab({
      id: `project:${contextGraphId}`,
      label: profile.displayName || contextGraphId.slice(0, 16),
      closable: true,
    });
    // The selection is owned by ProjectView's local state; we hand off
    // via a window event so we don't have to reach into its store
    // internals. ProjectView listens for this and sets selectedUri.
    window.dispatchEvent(new CustomEvent('v10:open-entity', {
      detail: { contextGraphId, entityUri: uri },
    }));
  }, [contextGraphId, openTab, profile.displayName, setActiveProject]);

  const openAgent = React.useCallback((uri: string) => {
    const slug = uri.startsWith('urn:dkg:agent:')
      ? uri.slice('urn:dkg:agent:'.length)
      : uri;
    const shortName = agentsData.get(uri)?.name ?? slug;
    openTab({
      id: `agent:${contextGraphId}|${slug}`,
      label: `@ ${shortName}`,
      closable: true,
    });
  }, [contextGraphId, agentsData, openTab]);

  const goBack = React.useCallback(() => {
    if (activeTabId) closeTab(activeTabId);
  }, [activeTabId, closeTab]);

  const agentsContextValue = React.useMemo(
    () => ({ ...agentsData, openAgent }),
    [agentsData, openAgent],
  );

  return (
    <ProjectProfileContext.Provider value={profile}>
      <AgentsContext.Provider value={agentsContextValue}>
        <AgentProfileView
          agentUri={agentUri}
          entityList={memory.entityList}
          onSelectEntity={selectEntity}
          onOpenAgent={openAgent}
          onBack={goBack}
        />
      </AgentsContext.Provider>
    </ProjectProfileContext.Provider>
  );
};
