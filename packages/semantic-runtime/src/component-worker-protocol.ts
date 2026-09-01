import type { ResourceLimits } from 'node:worker_threads';

import type {
  ComponentOperationResult,
  ComponentToolCall,
  ComponentToolResult,
  ExecutionCapabilityDescriptor,
} from './component-types.js';

export type ComponentWorkerOperation =
  | 'compile'
  | 'admit'
  | 'start'
  | 'advance'
  | 'inspect'
  | 'drop'
  | 'test_hang'
  | 'test_trap';

export interface ComponentWorkerBootstrap {
  artifactRoot: string;
  componentHash: string;
  witHash: string;
  expectedAbi: number;
  allowTestOperations: boolean;
  maxOperations: number;
  resourceLimits: ResourceLimits;
}

export interface ComponentWorkerRequest {
  type: 'request';
  requestId: bigint;
  op: ComponentWorkerOperation;
  source?: string;
  plan?: Uint8Array;
  logicalTime?: bigint;
  capability?: ExecutionCapabilityDescriptor;
}

export interface ComponentWorkerToolCall {
  type: 'tool-call';
  requestId: bigint;
  toolCallId: bigint;
  call: ComponentToolCall;
}

export interface ComponentWorkerToolSuccess {
  type: 'tool-result';
  toolCallId: bigint;
  ok: true;
  result: ComponentToolResult;
}

export interface ComponentWorkerToolFailure {
  type: 'tool-result';
  toolCallId: bigint;
  ok: false;
  code: string;
  message: string;
  retryable: boolean;
}

export type ComponentWorkerInbound =
  | ComponentWorkerRequest
  | ComponentWorkerToolSuccess
  | ComponentWorkerToolFailure;

export interface ComponentWorkerReady {
  type: 'ready';
  abi: number;
  componentHash: string;
  witHash: string;
  instanceId: string;
}

export interface ComponentWorkerSuccess {
  type: 'response';
  requestId: bigint;
  ok: true;
  result: ComponentOperationResult;
}

export interface ComponentWorkerFailure {
  type: 'response';
  requestId: bigint;
  ok: false;
  code: string;
  category: string;
  message: string;
  retryable: boolean;
}

export interface ComponentWorkerFatal {
  type: 'fatal';
  requestId?: bigint;
  message: string;
}

export type ComponentWorkerMessage =
  | ComponentWorkerReady
  | ComponentWorkerToolCall
  | ComponentWorkerSuccess
  | ComponentWorkerFailure
  | ComponentWorkerFatal;
