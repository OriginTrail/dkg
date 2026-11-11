export type WorkerOperation =
  | 'create'
  | 'apply'
  | 'snapshot'
  | 'restore'
  | 'inspect'
  | 'drop'
  | 'compile'
  | 'admit'
  | 'start_plan'
  | 'apply_plan'
  | 'inspect_plan'
  | 'drop_plan'
  | 'v1_conformance'
  | 'phase0_test_hang'
  | 'phase0_test_trap';

export interface RuntimeWorkerRequest {
  type: 'request';
  requestId: bigint;
  op: WorkerOperation;
  handle?: number;
  body: Uint8Array;
  deadlineMonotonicMs: number;
}

export interface RuntimeWorkerReady {
  type: 'ready';
  abi: number;
  moduleHash: string;
  wasmBytes: number;
}

export interface RuntimeWorkerSuccess {
  type: 'response';
  requestId: bigint;
  ok: true;
  body: Uint8Array;
  wasmBytes: number;
}

export interface RuntimeWorkerFailure {
  type: 'response';
  requestId: bigint;
  ok: false;
  code: string;
  category: string;
}

export interface RuntimeWorkerFatal {
  type: 'fatal';
  requestId?: bigint;
  message: string;
}

export type RuntimeWorkerMessage =
  | RuntimeWorkerReady
  | RuntimeWorkerSuccess
  | RuntimeWorkerFailure
  | RuntimeWorkerFatal;

export interface RuntimeWorkerBootstrap {
  artifactRoot: string;
  expectedModuleHash: string;
  expectedAbi: number;
  allowTestOperations: boolean;
}
