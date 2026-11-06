/**
 * ContextGraphChip — a context graph you can open: its monogram tile plus
 * its name, in a pill. The leading mark is what says "this opens"; the same
 * pattern as AgentChip (circle avatar) for agents. See DESIGN.md.
 */
import React from 'react';
import { ContextGraphMark } from '../../context-graph-colors.js';

export interface ContextGraphChipProps {
  id: string;
  name?: string | null;
  /** When given, the chip is a button that opens the graph. */
  onOpen?: (id: string) => void;
  title?: string;
  className?: string;
}

export const ContextGraphChip: React.FC<ContextGraphChipProps> = ({ id, name, onOpen, title, className = '' }) => {
  const label = name?.trim() || id;
  const body = (
    <>
      <ContextGraphMark id={id} name={name} />
      <span className="ds-entity-chip-name">{label}</span>
    </>
  );
  return onOpen ? (
    <button type="button" className={`ds-entity-chip interactive ${className}`} onClick={() => onOpen(id)} title={title ?? `Open ${label}`}>
      {body}
    </button>
  ) : (
    <span className={`ds-entity-chip ${className}`} title={title ?? label}>{body}</span>
  );
};
