// SPDX-License-Identifier: Apache-2.0
/** The RDF vocabulary the chat-turns assertion is written and read in, shared by the chat modules. */
export const CHAT_NS = 'urn:dkg:chat:';
export const MEMORY_NS = 'urn:dkg:memory:';
export const SCHEMA = 'http://schema.org/';
export const DKG_ONT = 'http://dkg.io/ontology/';
export const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
export const XSD_DATETIME = 'http://www.w3.org/2001/XMLSchema#dateTime';
export const CHAT_ATTACHMENT_REFS_PREDICATE = `${DKG_ONT}attachmentRefs`;
/** A completion of a turn after its first report: a node of this type that points at the turn. */
export const CHAT_TURN_PERSISTENCE_TRANSITION_TYPE = `${DKG_ONT}ChatTurnPersistenceTransition`;
export const CHAT_TURN_PERSISTENCE_TRANSITION_PREDICATE = `${DKG_ONT}updatesTurn`;
