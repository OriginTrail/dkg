export {
  generateEd25519Keypair,
  ed25519GetPublicKey,
  ed25519Sign,
  ed25519Verify,
  type Ed25519Keypair,
} from './ed25519.js';

export { sha256 } from './hashing.js';

export { keccak256, keccak256Hex } from './keccak.js';

export { MerkleTree, compareBytes } from './merkle.js';

export { V10MerkleTree } from './v10-merkle.js';

export {
  buildV10ProofMaterial,
  verifyV10ProofMaterial,
  V10ProofRootMismatchError,
  V10ProofLeafCountMismatchError,
  V10ProofChunkOutOfRangeError,
  type V10ProofMaterial,
  type V10MerkleCommitment,
} from './proof-material.js';

export { canonicalize, hashTriple, hashTripleV10 } from './canonicalize.js';

export { hexToBytes } from './oracle-verify.js';

export {
  computeACKDigest,
  computePublishACKDigest,
  computeUpdateACKDigest,
  computePublishPublisherDigest,
  buildAuthorAttestationTypedData,
  AUTHOR_ATTESTATION_DOMAIN_NAME,
  AUTHOR_ATTESTATION_DOMAIN_VERSION,
  AUTHOR_ATTESTATION_PRIMARY_TYPE,
  AUTHOR_SCHEME_VERSION_V1,
  type AuthorAttestationTypedData,
  eip191Hash,
  uint256ToBytes,
} from './ack.js';

export { resolveRootEntities, type Quad as RootEntityQuad } from './root-entity.js';
