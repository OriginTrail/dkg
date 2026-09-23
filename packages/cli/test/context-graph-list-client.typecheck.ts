import { ApiClient } from '../src/api-client.js';
import type {
  ContextGraphListFullRow,
  ContextGraphListSummaryRow,
} from '@origintrail-official/dkg-core';

declare const client: ApiClient;

const legacy = await client.listContextGraphs();
const defaultPage = await client.listContextGraphs({});
const fullPage = await client.listContextGraphs({ projection: 'full' });
const summaryPage = await client.listContextGraphs({ projection: 'summary' });

const legacyRow: ContextGraphListFullRow | undefined = legacy.contextGraphs[0];
const defaultRow: ContextGraphListFullRow | undefined = defaultPage.contextGraphs[0];
const fullRow: ContextGraphListFullRow | undefined = fullPage.contextGraphs[0];
const summaryRow: ContextGraphListSummaryRow | undefined = summaryPage.contextGraphs[0];

void legacyRow;
void defaultRow;
void fullRow;
void summaryRow;

// @ts-expect-error Summary rows intentionally omit full-only URI metadata.
void summaryPage.contextGraphs[0]?.uri;
