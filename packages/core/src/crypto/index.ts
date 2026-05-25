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

export {
  WORKSPACE_RECIPIENT_ENCRYPTION_KEY_PURPOSE,
  WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
  WORKSPACE_AGENT_ENCRYPTION_KEY_PROOF_DOMAIN,
  WORKSPACE_AGENT_ENCRYPTION_KEY_REVOCATION_DOMAIN,
  WORKSPACE_ENCRYPTION_KEY_BYTES,
  WORKSPACE_X25519_KEY_BYTES,
  WORKSPACE_ENCRYPTION_NONCE_BYTES,
  generateWorkspaceRecipientEncryptionKey,
  encryptWorkspacePayload,
  decryptWorkspacePayload,
  assertSupportedEncryptedWorkspaceEnvelope,
  computeWorkspaceAgentEncryptionKeyProofPayload,
  computeWorkspaceAgentEncryptionKeyRevocationPayload,
  workspaceAgentEncryptionKeyId,
  encodeWorkspaceEncryptionKey,
  decodeWorkspaceEncryptionKey,
  type WorkspaceRecipientEncryptionKey,
  type EncryptWorkspacePayloadInput,
  type DecryptedWorkspacePayload,
  type WorkspaceAgentEncryptionKeyProofFields,
  type WorkspaceAgentEncryptionKeyRevocationFields,
} from './workspace-encryption.js';

export {
  SWM_SENDER_KEY_CHAIN_KEY_BYTES,
  SWM_SENDER_KEY_SKIPPED_MESSAGE_CACHE_LIMIT,
  generateSwmSenderChainKey,
  generateSwmSenderEpochId,
  computeSwmSenderKeyMembershipHash,
  encryptSwmSenderKeyPackage,
  decryptSwmSenderKeyPackage,
  encryptSwmSenderKeyMessage,
  decryptSwmSenderKeyMessage,
  ratchetSwmSenderChainKey,
  assertSupportedSwmSenderKeyPackage,
  assertSupportedSwmSenderKeyMessage,
  type SwmSenderKeyMembershipMember,
  type ComputeSwmSenderKeyMembershipHashInput,
  type EncryptSwmSenderKeyPackageInput,
  type DecryptSwmSenderKeyPackageInput,
  type EncryptSwmSenderKeyMessageInput,
  type DecryptSwmSenderKeyMessageInput,
  type SwmSenderKeyMessageCryptResult,
} from './swm-sender-key.js';

export {
  encryptV10PublishPayload,
  decryptV10PublishPayload,
  isEncryptedV10PublishPayload,
  V10_PUBLISH_PAYLOAD_MAGIC,
  type EncryptV10PublishPayloadInput,
  type DecryptV10PublishPayloadInput,
} from './v10-publish-payload.js';

export { resolveRootEntities, type Quad as RootEntityQuad } from './root-entity.js';
