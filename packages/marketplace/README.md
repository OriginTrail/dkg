# @origintrail-official/dkg-marketplace

Pure domain logic for the OT-RFC-27 NeuroSymbolic Marketplace prototype:
shared authorization/receipt digests (byte-for-byte mirrors of the
`Marketplace.sol` preimages), session-key lifecycle, the buyer-side
marketplace router, buyer metering (bigint bucket accounting with the RFC's
soft ceiling), the seller-side receipt batcher, and receipt build/verify
helpers.

No daemon or workspace imports — only `ethers` and the Node standard
library — so both the agent runtime and tests (including the Solidity test
suite, via the fixed digest vectors) can depend on it without pulling in
runtime infrastructure.

All TRAC values are wei (`bigint`); units (tokens / query units) are
`bigint` capped to `uint64`. No floating point is used for value math.
