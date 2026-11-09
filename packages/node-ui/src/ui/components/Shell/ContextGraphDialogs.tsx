import React from 'react';
import { CreateProjectModal } from '../Modals/CreateProjectModal.js';
import { JoinProjectModal } from '../Modals/JoinProjectModal.js';
import { useContextGraphDialogs } from '../../stores/contextGraphDialogs.js';

/**
 * Always mounted by the shell, so the dialogs outlive the panel that opened
 * them. Each dialog mounts only while open, so a closed one runs no requests.
 */
export function ContextGraphDialogs() {
  const { createOpen, joinOpen, joinContextGraphId, closeCreate, closeJoin } = useContextGraphDialogs();
  return (
    <>
      {createOpen && <CreateProjectModal open onClose={closeCreate} />}
      {joinOpen && <JoinProjectModal open onClose={closeJoin} initialContextGraphId={joinContextGraphId} />}
    </>
  );
}
