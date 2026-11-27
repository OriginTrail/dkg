/** Publish once and read its receipt; auxiliary cleanup cannot replace either outcome. */
export async function executeReceiptConfirmedPublication<Receipt>(execution: {
  publish(): Promise<void>;
  readReceipt(): Promise<Receipt>;
  cleanup(): void | Promise<void>;
}): Promise<Receipt> {
  try {
    await execution.publish();
    return await execution.readReceipt();
  } finally {
    try { await execution.cleanup(); } catch { /* Preserve the publication outcome. */ }
  }
}
