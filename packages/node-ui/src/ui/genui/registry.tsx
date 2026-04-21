/**
 * OpenUI component registry for the DKG Node UI.
 *
 * The LLM only sees this registry's generated prompt via `library.prompt()`,
 * so when we add a new component here it becomes composable *immediately* —
 * no prompt-engineering required, no daemon code changes.
 *
 * Components focus on displaying entities from DKG context graphs: memory,
 * code, github, decisions, tasks, verified provenance. The PoC set is
 * intentionally small; add more as new domains come online.
 */
import { defineComponent, createLibrary } from '@openuidev/react-lang';
import { z } from 'zod/v4';
import {
  EntityCardImpl,
  EntityStatsGridImpl,
  TripleTableImpl,
  EntityTypeListImpl,
  CrossRefListImpl,
  PackageCardImpl,
  FileCardImpl,
  DecisionCardImpl,
  PRCardImpl,
  TaskCardImpl,
  VerifiedProvenancePanelImpl,
  EntityDetailImpl,
} from './components.js';

const EntityDetail = defineComponent({
  name: 'EntityDetail',
  description:
    'Root container for a single-entity detail view. Accepts any number of child blocks (EntityCard, PackageCard, VerifiedProvenancePanel, etc.). Always use this as the outermost element.',
  props: z.object({
    title: z.string().optional().describe('Optional top-of-panel title override (defaults to the entity rdfs:label)'),
  }),
  component: EntityDetailImpl,
});

const EntityCard = defineComponent({
  name: 'EntityCard',
  description:
    'Compact header card for any entity: name, rdf:type label, optional subtitle, and up to 6 small stat chips.',
  props: z.object({
    name: z.string().describe('Display name / label of the entity'),
    typeLabel: z.string().optional().describe('Human-readable rdf:type label (e.g. "Package", "Pull Request")'),
    subtitle: z.string().optional().describe('Short supporting text (e.g. path, author, date)'),
    chips: z
      .array(
        z.object({
          label: z.string(),
          value: z.string(),
          tone: z.enum(['default', 'success', 'warn', 'danger', 'info']).optional(),
        }),
      )
      .max(6)
      .optional(),
  }),
  component: EntityCardImpl,
});

const EntityStatsGrid = defineComponent({
  name: 'EntityStatsGrid',
  description: 'Grid of numeric stats with labels. Use for summarising counts (files, classes, additions, deletions).',
  props: z.object({
    stats: z
      .array(
        z.object({
          label: z.string(),
          value: z.union([z.string(), z.number()]),
          hint: z.string().optional(),
        }),
      )
      .min(1)
      .max(8),
  }),
  component: EntityStatsGridImpl,
});

const TripleTable = defineComponent({
  name: 'TripleTable',
  description:
    'Fallback raw-triples table. Use sparingly — only when the entity has no better structured components in this library.',
  props: z.object({
    heading: z.string().optional(),
    rows: z
      .array(z.object({ predicate: z.string(), object: z.string() }))
      .max(60),
  }),
  component: TripleTableImpl,
});

const EntityTypeList = defineComponent({
  name: 'EntityTypeList',
  description:
    "Grouped list of child entities by rdf:type. Great for showing a File's contained classes/functions/interfaces as separate sections.",
  props: z.object({
    heading: z.string().optional(),
    groups: z
      .array(
        z.object({
          typeLabel: z.string(),
          icon: z.string().optional(),
          items: z
            .array(
              z.object({
                label: z.string(),
                uri: z.string().optional(),
                sub: z.string().optional(),
              }),
            )
            .max(30),
        }),
      )
      .max(8),
  }),
  component: EntityTypeListImpl,
});

const CrossRefList = defineComponent({
  name: 'CrossRefList',
  description:
    'List of cross-references following a single predicate (e.g. code:imports, github:affects, decisions:affects). Each item can show a short subtitle.',
  props: z.object({
    heading: z.string().describe('Human-readable heading (e.g. "Imports", "Affected files")'),
    predicate: z.string().optional(),
    items: z
      .array(
        z.object({
          label: z.string(),
          uri: z.string().optional(),
          sub: z.string().optional(),
        }),
      )
      .max(40),
  }),
  component: CrossRefListImpl,
});

const PackageCard = defineComponent({
  name: 'PackageCard',
  description: 'Specialised card for a code:Package entity: name, folder, description, and a mini-stats strip.',
  props: z.object({
    name: z.string(),
    folder: z.string().optional(),
    description: z.string().optional(),
    fileCount: z.number().optional(),
    classCount: z.number().optional(),
    functionCount: z.number().optional(),
    interfaceCount: z.number().optional(),
  }),
  component: PackageCardImpl,
});

const FileCard = defineComponent({
  name: 'FileCard',
  description: 'Specialised card for a code:File entity: path, language, line count, owning package.',
  props: z.object({
    path: z.string(),
    language: z.string().optional(),
    lineCount: z.number().optional(),
    packageName: z.string().optional(),
  }),
  component: FileCardImpl,
});

const DecisionCard = defineComponent({
  name: 'DecisionCard',
  description: 'Specialised card for a decisions:Decision entity: title, status badge, date, context/outcome quoted sections.',
  props: z.object({
    title: z.string(),
    status: z.enum(['proposed', 'accepted', 'rejected', 'superseded']).optional(),
    date: z.string().optional(),
    context: z.string().optional(),
    outcome: z.string().optional(),
    consequences: z.string().optional(),
    alternatives: z.string().optional(),
  }),
  component: DecisionCardImpl,
});

const PRCard = defineComponent({
  name: 'PRCard',
  description: 'Specialised card for a github:PullRequest entity: title + #number, state, author, merged badge, body preview.',
  props: z.object({
    title: z.string(),
    number: z.number().optional(),
    state: z.enum(['open', 'closed', 'merged']).optional(),
    author: z.string().optional(),
    mergedAt: z.string().optional(),
    body: z.string().optional(),
    url: z.string().optional(),
  }),
  component: PRCardImpl,
});

const TaskCard = defineComponent({
  name: 'TaskCard',
  description: 'Specialised card for a tasks:Task entity: title, status chip, priority, assignee, estimate.',
  props: z.object({
    title: z.string(),
    status: z.enum(['todo', 'in_progress', 'blocked', 'done', 'cancelled']).optional(),
    priority: z.enum(['p0', 'p1', 'p2', 'p3']).optional(),
    assignee: z.string().optional(),
    estimate: z.number().optional(),
  }),
  component: TaskCardImpl,
});

const VerifiedProvenancePanel = defineComponent({
  name: 'VerifiedProvenancePanel',
  description:
    'The Verified Memory hero block. Use at the top of any entity in the VM layer. Surfaces on-chain anchor (tx hash, block), consensus (signing agents with reputation), knowledge-asset identity (UAL, content hash, TRAC locked, NFT token id), and finalisation timeline.',
  props: z.object({
    onChain: z
      .object({
        txHash: z.string().optional(),
        blockNumber: z.union([z.string(), z.number()]).optional(),
        chain: z.string().optional(),
      })
      .optional(),
    consensus: z
      .object({
        signers: z
          .array(
            z.object({
              did: z.string(),
              label: z.string().optional(),
              reputation: z.number().optional(),
              signature: z.string().optional(),
            }),
          )
          .max(10)
          .optional(),
        quorum: z.string().optional().describe('e.g. "3 of 5"'),
      })
      .optional(),
    knowledgeAsset: z
      .object({
        ual: z.string().optional(),
        contentHash: z.string().optional(),
        tracLocked: z.string().optional(),
        tokenId: z.string().optional(),
      })
      .optional(),
    timeline: z
      .array(
        z.object({
          label: z.string(),
          at: z.string(),
        }),
      )
      .max(6)
      .optional(),
  }),
  component: VerifiedProvenancePanelImpl,
});

export const genuiLibrary = createLibrary({
  components: [
    EntityDetail,
    EntityCard,
    EntityStatsGrid,
    TripleTable,
    EntityTypeList,
    CrossRefList,
    PackageCard,
    FileCard,
    DecisionCard,
    PRCard,
    TaskCard,
    VerifiedProvenancePanel,
  ],
  root: 'EntityDetail',
  componentGroups: [
    {
      name: 'Generic',
      components: ['EntityDetail', 'EntityCard', 'EntityStatsGrid', 'EntityTypeList', 'CrossRefList', 'TripleTable'],
    },
    { name: 'Code domain', components: ['PackageCard', 'FileCard'] },
    { name: 'GitHub domain', components: ['PRCard'] },
    { name: 'Decisions & tasks', components: ['DecisionCard', 'TaskCard'] },
    { name: 'Verified memory', components: ['VerifiedProvenancePanel'] },
  ],
});

/**
 * Cached library prompt string sent with every /api/genui/render call.
 * Library definitions are static so we compute this once.
 */
let cachedPrompt: string | null = null;
export function getGenuiLibraryPrompt(): string {
  if (cachedPrompt === null) {
    cachedPrompt = genuiLibrary.prompt({
      preamble:
        'You are composing a single-entity detail panel for the DKG Node UI. ' +
        'Use only the components below to build a rich, structured view. ' +
        'Always wrap the response in the EntityDetail root element.',
      additionalRules: [
        'Prefer specialised cards (PackageCard, PRCard, DecisionCard, TaskCard, FileCard) when the rdf:type matches.',
        'Include VerifiedProvenancePanel at the very top if the entity appears in verified memory or has on-chain / signature triples.',
        'Keep the tree compact: aim for 3–8 top-level blocks.',
        'Do not invent triple data — only use values present in the provided triples.',
      ],
    });
  }
  return cachedPrompt;
}
