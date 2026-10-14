/** Publication is never replayed. Cleanup cannot replace its receipt or first error. */
export async function executeReceiptConfirmedPublication<Scope, Receipt>(execution: {
  withScope(work: (scope: Scope) => Promise<Receipt>): Promise<Receipt>;
  publish(scope: Scope): Promise<void>;
  readReceipt(scope: Scope): Promise<Receipt>;
  cleanup(scope: Scope): void | Promise<void>;
}): Promise<Receipt> {
  let confirmed: { value: Receipt } | undefined;
  try {
    return await execution.withScope(async scope => {
      try {
        await execution.publish(scope);
        const value = await execution.readReceipt(scope);
        confirmed = { value };
        return value;
      } finally {
        try { await execution.cleanup(scope); } catch { /* Auxiliary cleanup preserves the semantic outcome. */ }
      }
    });
  } catch (error) {
    // An admission may report its deadline after cleanup settled. A confirmed
    // receipt already establishes the outcome; an unconfirmed write still fails.
    if (confirmed) return confirmed.value;
    throw error;
  }
}
