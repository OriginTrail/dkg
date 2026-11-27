export const isHash = value => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);

export function requireReceiptBlockIdentity(receipt) {
  if (!isHash(receipt.hash) || !isHash(receipt.blockHash) || receipt.status !== 1
    || !Number.isSafeInteger(receipt.blockNumber) || receipt.blockNumber < 0 || !Array.isArray(receipt.logs)) {
    throw Error('Missing or malformed successful receipt block identity');
  }
  for (const log of receipt.logs) {
    if (!isHash(log.blockHash) || log.blockHash.toLowerCase() !== receipt.blockHash.toLowerCase()
      || log.blockNumber !== receipt.blockNumber || !isHash(log.transactionHash)
      || log.transactionHash.toLowerCase() !== receipt.hash.toLowerCase() || log.removed === true) {
      throw Error('Receipt log block/transaction identity mismatch');
    }
  }
  return { blockNumber: receipt.blockNumber, blockHash: receipt.blockHash };
}
