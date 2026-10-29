// SPDX-License-Identifier: Apache-2.0
/** Only local fixed properties are accepted; no peer-supplied JVM/store settings. */
export function nativeCheckpointProperties(journal: string): string {
  // Properties are generated locally; peer-controlled properties/class names are never accepted.
  if (/[\r\n\0]/.test(journal)) throw new Error('Invalid native checkpoint path');
  // Java Properties.load reads ISO-8859-1, not UTF-8. Escape each UTF-16 code
  // unit, including surrogate pairs, so non-ASCII data directories stay exact.
  const escapedJournal = journal.replace(/\\/g, '\\\\').replace(/[^\x20-\x7e]/g,
    c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  const properties = [
    `com.bigdata.journal.AbstractJournal.file=${escapedJournal}`,
    'com.bigdata.journal.AbstractJournal.bufferMode=DiskRW', 'com.bigdata.journal.Journal.groupCommit=false',
    'com.bigdata.service.AbstractTransactionService.minReleaseAge=1',
    'com.bigdata.btree.writeRetentionQueue.capacity=4000', 'com.bigdata.btree.BTree.branchingFactor=128',
    'com.bigdata.rdf.sail.truthMaintenance=false', 'com.bigdata.rdf.store.AbstractTripleStore.quads=true',
    'com.bigdata.rdf.store.AbstractTripleStore.statementIdentifiers=false', 'com.bigdata.rdf.store.AbstractTripleStore.textIndex=false',
    'com.bigdata.rdf.store.AbstractTripleStore.axiomsClass=com.bigdata.rdf.axioms.NoAxioms',
    'com.bigdata.namespace.kb.lex.com.bigdata.btree.BTree.branchingFactor=400',
    'com.bigdata.namespace.kb.spo.com.bigdata.btree.BTree.branchingFactor=1024',
    'com.bigdata.rdf.store.DataLoader.commit=Batch', 'com.bigdata.rdf.store.DataLoader.bufferCapacity=100000',
    'com.bigdata.rdf.store.DataLoader.queueCapacity=1', 'com.bigdata.rdf.store.DataLoader.ignoreInvalidFiles=false',
    'com.bigdata.rdf.store.DataLoader.durableQueues=false', 'com.bigdata.rdf.rio.RDFParserOptions.verifyData=true',
    'com.bigdata.rdf.rio.RDFParserOptions.stopAtFirstError=true', 'com.bigdata.rdf.rio.RDFParserOptions.datatypeHandling=VERIFY',
  ].join('\n') + '\n';
  return properties;
}
