// SPDX-License-Identifier: Apache-2.0

// ─── dkg ca — Conviction Account service spending ────────────────────
//
// Conviction Account service spending (OT-RFC-27), beside `dkg pca` and in
// its pattern: check the arguments, call the daemon's /api/ca routes through
// ApiClient.ca, print the answer's fields, and exit 1 on an error. Every
// command takes --json, which prints the answer as it came instead.
//
// The owner's commands run on the node whose primary wallet owns the account:
// services, assign (with the assignee's consent), caps, revoke and
// advance-nonce. The buyer key's run on the assignee node: consent, fund, and
// assign with the owner's signature. Reads run anywhere.

import type { Command } from 'commander';
import { ApiClient } from '../api-client.js';
import type { CaClient } from '../ca-client.js';
import {
  assignmentFromFile,
  capsUpdateFromOptions,
  consentFromOptions,
  parseAccountIdArg,
  parseAddressArg,
  parseServicesState,
  parseWholeOption,
  preparePlanFile,
  writeConsentFile,
  type CaCapOptions,
  type CaPreparedPlan,
} from '../ca-command-input.js';
import {
  assignLines,
  assignOutcomeUnknownLines,
  assignmentsLines,
  caErrorLines,
  capsLines,
  consentLines,
  contractsLines,
  fundLines,
  fundOutcomeUnknownLines,
  labelsLines,
  mineLines,
  nonceLines,
  periodsLines,
  revokeLines,
  serviceSpendingPointer,
  servicesLines,
  statusLines,
} from '../ca-command-output.js';

const JSON_HELP = 'Print the raw JSON answer instead of the formatted summary';

interface JsonOption {
  json?: boolean;
}

function print(lines: readonly string[], to: 'stdout' | 'stderr' = 'stdout'): void {
  for (const line of lines) {
    if (to === 'stdout') console.log(line);
    else console.error(line);
  }
}

function printJson(answer: unknown): void {
  console.log(JSON.stringify(answer, null, 2));
}

/** The answer's lines, or its JSON with --json. */
function show<T>(opts: JsonOption, answer: T, render: (answer: T) => string[]): void {
  if (opts.json) printJson(answer);
  else print(render(answer));
}

async function connectCa(): Promise<CaClient> {
  return (await ApiClient.connect()).ca;
}

function isOutcomeUnknown(err: unknown): err is Error {
  return err instanceof Error && (err as { code?: unknown }).code === 'OUTCOME_UNKNOWN';
}

/** Run one command; an error prints on stderr (`explain` may say more than the default) and exits 1. */
async function runCa(action: () => Promise<void>, explain?: (err: unknown) => string[] | undefined): Promise<void> {
  try {
    await action();
  } catch (err) {
    print(explain?.(err) ?? caErrorLines(err), 'stderr');
    process.exit(1);
  }
}

/** The cap options of `consent` (with the node's defaults) and `caps` (left out: unchanged). */
function addCapOptions(command: Command, kind: 'consent' | 'caps'): Command {
  const otherwise = (consentDefault: string) => (kind === 'consent' ? ` (default: ${consentDefault})` : '');
  const amount = (flag: string, description: string) => (kind === 'consent' && (flag === '--max-period' || flag === '--max-total')
    ? command.requiredOption(`${flag} <TRAC>`, description)
    : command.option(`${flag} <TRAC>`, description));
  amount('--max-period', 'Cap on the cost of one period, in TRAC after the discount');
  amount('--max-inference', `Cap on the inference cost of one period${otherwise('the period cap')}`);
  amount('--max-query', `Cap on the query cost of one period${otherwise('the period cap')}`);
  amount('--max-window', `Cap on the cost per billing window, 0 for none${otherwise('0')}`);
  amount('--max-total', 'Cap on the total cost of the assignment');
  command.option('--max-period-days <n>', `Longest period, in whole days${otherwise('31')}`);
  const expires = 'When the assignment expires: an ISO-8601 time with a zone, such as 2026-11-30T00:00:00Z';
  if (kind === 'consent') command.requiredOption('--expires <ISO-8601>', expires);
  else command.option('--expires <ISO-8601>', expires);
  return command;
}

/** For `dkg pca info`: one line pointing to `dkg ca status` when the account spends on services; nothing when the node cannot tell. */
export async function caStatusPointer(client: ApiClient, accountId: string): Promise<string | null> {
  try {
    return serviceSpendingPointer(await client.ca.status(accountId));
  } catch {
    return null;
  }
}

export function registerCaCommand(program: Command): void {
  const ca = program
    .command('ca')
    .description('Conviction Account service spending: opt in, assign buyer keys, set caps, fund service periods, inspect');

  ca.command('contracts')
    .description('The service-spending contracts and the EIP-712 domain of a consent, for signing away from the node')
    .option('--json', JSON_HELP)
    .action(async (opts: JsonOption) => runCa(async () => {
      show(opts, await (await connectCa()).contracts(), contractsLines);
    }));

  ca.command('mine')
    .description('The accounts this node\'s primary wallet owns, and those its buyer key is assigned on')
    .option('--json', JSON_HELP)
    .action(async (opts: JsonOption) => runCa(async () => {
      show(opts, await (await connectCa()).mine(), mineLines);
    }));

  ca.command('status <accountId>')
    .description('Service-spending status of an account, read fresh from the chain')
    .option('--json', JSON_HELP)
    .action(async (accountId: string, opts: JsonOption) => runCa(async () => {
      const id = parseAccountIdArg(accountId);
      show(opts, await (await connectCa()).status(id), statusLines);
    }));

  ca.command('services <accountId> <state>')
    .description('On the owner node: switch service spending on (enable) or off (disable). Off keeps assignments and funded periods')
    .option('--json', JSON_HELP)
    .action(async (accountId: string, state: string, opts: JsonOption) => runCa(async () => {
      const id = parseAccountIdArg(accountId);
      const enabled = parseServicesState(state);
      show(opts, await (await connectCa()).setServices(id, enabled), servicesLines);
    }));

  addCapOptions(ca.command('consent <accountId>'), 'consent')
    .description('On the assignee node: sign the caps with the buyer key (EIP-712), and send nothing. The owner node submits the consent')
    .option('--out <file>', 'Write the consent to this file, for dkg ca assign --consent. Without it, the consent is printed as JSON')
    .option('--json', JSON_HELP)
    .action(async (accountId: string, opts: CaCapOptions & JsonOption & { out?: string }) => runCa(async () => {
      const id = parseAccountIdArg(accountId);
      const input = consentFromOptions(opts);
      const consent = await (await connectCa()).consent(id, input);
      if (opts.out !== undefined) await writeConsentFile(opts.out, consent);
      if (opts.json) return printJson(consent);
      if (opts.out !== undefined) return print(consentLines(consent, opts.out));
      // Without a file the consent is the output, to redirect into one; the summary goes to stderr.
      printJson(consent);
      print(consentLines(consent), 'stderr');
    }));

  ca.command('assign <accountId>')
    .description('Submit an assignment: on the owner node with the assignee\'s consent, or on the assignee node with the owner\'s signature')
    .requiredOption('--consent <file>', 'The consent file of dkg ca consent')
    .option('--owner-signature <hex>', 'On the assignee node: the owner\'s EIP-712 signature over the consent\'s terms')
    .option('--json', JSON_HELP)
    .action(async (accountId: string, opts: JsonOption & { consent: string; ownerSignature?: string }) => runCa(async () => {
      const id = parseAccountIdArg(accountId);
      const body = await assignmentFromFile(opts.consent, opts.ownerSignature);
      show(opts, await (await connectCa()).assign(id, body), assignLines);
    }, (err) => (isOutcomeUnknown(err) ? assignOutcomeUnknownLines(err, accountId) : undefined)));

  ca.command('assignments <accountId>')
    .description('The account\'s assignments: caps, state and usage')
    .option('--json', JSON_HELP)
    .action(async (accountId: string, opts: JsonOption) => runCa(async () => {
      const id = parseAccountIdArg(accountId);
      show(opts, await (await connectCa()).assignments(id), assignmentsLines);
    }));

  addCapOptions(ca.command('caps <accountId> <assignee>'), 'caps')
    .description('On the owner node: change an assignment\'s caps; options left out keep their values, and the usage is kept')
    .option('--json', JSON_HELP)
    .action(async (accountId: string, assignee: string, opts: CaCapOptions & JsonOption) => runCa(async () => {
      const id = parseAccountIdArg(accountId);
      const who = parseAddressArg(assignee, 'assignee');
      const caps = capsUpdateFromOptions(opts);
      show(opts, await (await connectCa()).updateCaps(id, who, caps), capsLines);
    }));

  ca.command('revoke <accountId> <assignee>')
    .description('On the owner node: revoke an assignment. Funded periods run to their end; the nonce advances')
    .option('--json', JSON_HELP)
    .action(async (accountId: string, assignee: string, opts: JsonOption) => runCa(async () => {
      const id = parseAccountIdArg(accountId);
      const who = parseAddressArg(assignee, 'assignee');
      show(opts, await (await connectCa()).revoke(id, who), revokeLines);
    }));

  ca.command('advance-nonce <accountId>')
    .description('On the owner node: advance the assignment nonce, so that terms signed and not submitted no longer assign')
    .option('--json', JSON_HELP)
    .action(async (accountId: string, opts: JsonOption) => runCa(async () => {
      const id = parseAccountIdArg(accountId);
      show(opts, await (await connectCa()).advanceNonce(id), nonceLines);
    }));

  ca.command('labels <accountId>')
    .description('Service labels per epoch, at most 120 epochs; by default the first epochs of the account\'s span')
    .option('--from <epoch>', 'First epoch')
    .option('--to <epoch>', 'Last epoch')
    .option('--json', JSON_HELP)
    .action(async (accountId: string, opts: JsonOption & { from?: string; to?: string }) => runCa(async () => {
      const id = parseAccountIdArg(accountId);
      const range = {
        ...(opts.from === undefined ? {} : { from: parseWholeOption(opts.from, '--from') }),
        ...(opts.to === undefined ? {} : { to: parseWholeOption(opts.to, '--to') }),
      };
      show(opts, await (await connectCa()).labels(id, range), labelsLines);
    }));

  ca.command('periods <accountId>')
    .description('The service periods funded from the account, in funding order')
    .option('--offset <n>', 'Skip this many periods (default: 0)')
    .option('--limit <n>', 'Periods per page, 1 to 100 (default: 50)')
    .option('--json', JSON_HELP)
    .action(async (accountId: string, opts: JsonOption & { offset?: string; limit?: string }) => runCa(async () => {
      const id = parseAccountIdArg(accountId);
      const page = {
        ...(opts.offset === undefined ? {} : { offset: parseWholeOption(opts.offset, '--offset') }),
        ...(opts.limit === undefined ? {} : { limit: parseWholeOption(opts.limit, '--limit', 1) }),
      };
      show(opts, await (await connectCa()).periods(id, page), periodsLines);
    }));

  ca.command('fund <accountId>')
    .description('On the assignee node: fund one service period from the account with the buyer key')
    .requiredOption('--plan <file>', 'The period as JSON, the body of POST /api/ca/:id/periods. A plan without a periodId gets one written into it first')
    .option('--json', JSON_HELP)
    .action(async (accountId: string, opts: JsonOption & { plan: string }) => {
      let prepared: CaPreparedPlan | undefined;
      await runCa(async () => {
        const id = parseAccountIdArg(accountId);
        prepared = await preparePlanFile(opts.plan);
        // On stderr, so that --json output stays one JSON document.
        console.error(prepared.written
          ? `periodId ${prepared.periodId} is written to ${opts.plan}: running this command again repeats this period, and never funds a second one.`
          : `Funding period ${prepared.periodId}, the periodId of ${opts.plan}.`);
        const planDigest = prepared.plan.planDigest;
        show(opts, await (await connectCa()).fund(id, prepared.plan), (answer) => fundLines(answer, planDigest));
      }, (err) => (prepared !== undefined && isOutcomeUnknown(err)
        ? fundOutcomeUnknownLines(err, accountId, opts.plan, prepared.periodId)
        : undefined));
    });
}
