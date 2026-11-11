import React from 'react';
import { createPortal } from 'react-dom';
import { CreateProjectModal } from '../Modals/CreateProjectModal.js';
import { JoinProjectModal } from '../Modals/JoinProjectModal.js';
import { useContextGraphDialogs } from '../../stores/contextGraphDialogs.js';

/**
 * Always mounted by the shell, so the dialogs outlive the panel that opened
 * them. Each dialog mounts only while open, so a closed one runs no requests.
 */
export function ContextGraphDialogs() {
  const { createOpen, joinOpen, joinContextGraphId, closeCreate, closeJoin } = useContextGraphDialogs();
  // On document.body, so no shell style (a transform, filter or backdrop-filter)
  // becomes the dialogs' containing block.
  return createPortal(
    <>
      {createOpen && <CreateProjectModal open onClose={closeCreate} />}
      {joinOpen && <JoinProjectModal open onClose={closeJoin} initialContextGraphId={joinContextGraphId} />}
    </>,
    document.body,
  );
}
