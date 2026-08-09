import {
  stripSparqlLiteralsAndComments as stripLiteralsAndComments,
} from '@origintrail-official/dkg-core';

export {
  findMatchingSparqlCloseBrace,
  iterateSparqlCodeTokens,
  readNextSparqlCodeToken,
  readSparqlPrefixName,
  readSparqlVariable,
  readStandaloneSparqlWord,
  skipSparqlIriRef,
  skipSparqlSpaceAndLineComments,
  skipSparqlStringLiteral,
  type SparqlCodeToken,
  type SparqlPrefixName,
} from '@origintrail-official/dkg-core';

export { stripLiteralsAndComments };
