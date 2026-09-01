export const PREDICATE = 'https://schema.org/name';

export const TOKEN_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'event Approval(address indexed owner, address indexed spender, uint256 value)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
];

export const PCA_ABI = [
  'function createAccount(uint96 committedTRAC, uint72 primaryNode) returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
  'function ownerOf(uint256 accountId) view returns (address)',
  'function transferFrom(address from, address to, uint256 accountId)',
  'function registerAgent(uint256 accountId, address agent)',
  'function deregisterAgent(uint256 accountId, address agent)',
  'function agentToAccountId(address agent) view returns (uint256)',
  'function accounts(uint256 accountId) view returns (uint96 committedTRAC, uint40 createdAtEpoch, uint40 expiresAtEpoch, uint40 createdAtTimestamp, uint40 expiresAtTimestamp, uint72 primaryNode, uint96 cumulativeSpent, uint40 lastSettledWindow, bool fullySwept)',
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
];

export const PARAMETERS_ABI = [
  'function contextGraphRegistrationDeposit() view returns (uint96)',
  'function minPcaCommitmentForCgWaiver() view returns (uint96)',
  'function setContextGraphRegistrationDeposit(uint96 amount)',
];

export const CONTEXT_GRAPHS_ABI = [
  'function contextGraphStorage() view returns (address)',
  'function createContextGraph(address[] participantAgents, uint256 metadataBatchId, uint8 accessPolicy, uint8 publishPolicy, address publishAuthority, uint256 publishAuthorityAccountId, bytes32 nameHash) returns (uint256)',
  'event ContextGraphRegistrationDepositWaived(uint256 indexed contextGraphId, uint256 indexed accountId, address indexed creator)',
  'event ContextGraphRegistrationDeposited(uint256 indexed contextGraphId, address indexed payer, uint96 amount)',
];

export const CONTEXT_GRAPH_STORAGE_ABI = [
  'function getContextGraphOwner(uint256 contextGraphId) view returns (address)',
  'function getPublishPolicy(uint256 contextGraphId) view returns (uint8 publishPolicy, address publishAuthority)',
  'function getPublishAuthorityAccountId(uint256 contextGraphId) view returns (uint256)',
  'function getRegistrationEscrow(uint256 contextGraphId) view returns (uint96)',
  'event ContextGraphCreated(uint256 indexed contextGraphId, address indexed owner, bytes32 indexed nameHash, address[] participantAgents, uint256 metadataBatchId, uint8 accessPolicy, uint8 publishPolicy, address publishAuthority, uint256 publishAuthorityAccountId)',
];

export const WAIVER_ABI = [
  'function waivedCgCount(uint256 accountId) view returns (uint256)',
  'event RegistrationDepositWaived(uint256 indexed accountId, address indexed creator, uint256 newWaivedCount, uint256 quota)',
];
