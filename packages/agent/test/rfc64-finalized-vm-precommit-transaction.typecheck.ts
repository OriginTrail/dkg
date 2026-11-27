import type { FinalizedVmMaterializerV1 } from '../src/rfc64/finalized-vm-runtime-v1.js';
import {
  createRfc64FinalizedVmAgentPrecommitV1,
  type Rfc64FinalizedVmAgentPrecommitOptionsV1,
} from '../src/rfc64/finalized-vm-agent-precommit-v1.js';

declare const baseOptions: Omit<Rfc64FinalizedVmAgentPrecommitOptionsV1, 'materialize'>;
declare const receiptlessMaterializer: FinalizedVmMaterializerV1;

createRfc64FinalizedVmAgentPrecommitV1({
  ...baseOptions,
  // @ts-expect-error The coordinator-facing finalized VM path must own commit and rollback.
  materialize: receiptlessMaterializer,
});
