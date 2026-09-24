// SPDX-License-Identifier: Apache-2.0

import type { KnowledgeAssetReadModel } from './knowledge-asset-read-model.js';

/** Internal readers always have a scalar ordinal port, including legacy SDK inputs. */
export type ScalarKnowledgeAssetReadModel = KnowledgeAssetReadModel & Required<
  Pick<KnowledgeAssetReadModel, 'readContextGraphKaAt'>
>;

export function isScalarKnowledgeAssetReadModel(
  model: KnowledgeAssetReadModel,
): model is ScalarKnowledgeAssetReadModel {
  return typeof model.readContextGraphKaAt === 'function';
}

/** Adapt compatibility once at binding creation, never after a scalar refusal. */
export function normalizeKnowledgeAssetReadModel(
  model: KnowledgeAssetReadModel,
): ScalarKnowledgeAssetReadModel {
  if (isScalarKnowledgeAssetReadModel(model)) return model;
  const readList = model.readContextGraphKaList.bind(model);
  return Object.freeze({
    readContextGraphForKa: model.readContextGraphForKa.bind(model),
    readContextGraphKaList: readList,
    readContextGraphKaAt: async (contextGraphId, index, options) => {
      if (index < 0n) return undefined;
      const list = await readList(contextGraphId, options);
      if (list === undefined || index >= BigInt(list.kaIds.length)) return undefined;
      return { kaId: list.kaIds[Number(index)]!, asOfBlockNumber: list.throughBlockNumber };
    },
  } satisfies ScalarKnowledgeAssetReadModel);
}
