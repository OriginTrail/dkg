import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';

import { requireServiceSpendingBuilds } from '../../utils/conviction-service-deploy';

/**
 * V10 — refuses a run that would keep a `PublishingConviction` or a `StakingV10`
 * that service spending and the query/inference pool (OT-RFC-27) cannot run on.
 * It only reads.
 *
 * `Helpers.deploy` records a new deployment at once, `deployed: true`, and holds
 * its Hub registration in memory until step 998. A step that refuses a run after
 * another step has deployed therefore strands that deployment: the retry reuses
 * it and never registers it, so the Hub keeps what it had, and the initializers
 * of step 998 revert on a name it does not hold. So this check runs ahead of
 * every deployment:
 *   - in a run of every step, as the first file;
 *   - in a run by any single tag: by the `v10` tag as the first file, and by a
 *     tag that reaches 052d or 052e, the steps that need these builds, as the
 *     first dependency of each step that reaches them: 024, 052d, 052e, 052f
 *     and 998b. A tag that reaches neither needs no check.
 * In a run by a comma-separated list of tags it need not: a step of an earlier
 * tag that reaches neither can deploy ahead of it, and a refusal then strands
 * that deployment.
 *
 * What each build would do is in `requireServiceSpendingBuilds`. On a mainnet
 * network the check is skipped, as 052c to 052f are, and on a development
 * network too, where a run reuses nothing.
 */
const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  await requireServiceSpendingBuilds(hre);
};

export default func;
func.tags = ['ServiceSpendingBuilds', 'v10'];
