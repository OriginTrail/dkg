import { publish, defineConfig } from 'test-results-reporter';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// `.env` lives at the repo root; this script runs from packages/node-ui.
const here = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(here, '..', '..', '.env') });

const teamsHookBaseURL = process.env.v10_TEAMS_HOOK;
const jenkinsUrl = process.env.JENKINS_URL;

if (!teamsHookBaseURL) {
  console.error(
    'v10_TEAMS_HOOK is not set. Add it to .env at the repo root, or export it ' +
      'in the Jenkins controller environment.',
  );
  process.exit(1);
}

const config = defineConfig({
  reports: [
    {
      targets: [
        {
          name: 'teams',
          condition: "fail",
          inputs: {
            url: teamsHookBaseURL,
            only_failures: false,
            publish: 'test-summary-slim',
            title: 'DKG Node UI E2E Tests Report',
            width: 'Full',
          },
          extensions: [
            {
              name: 'quick-chart-test-summary',
            },
            {
              name: 'hyperlinks',
              inputs: {
                links: [
                  {
                    text: 'Node UI E2E HTML Report',
                    url: `${jenkinsUrl}/view/Tests/job/dkg_node_ui_test/Node_20UI_20E2E_20Report/*zip*/Node_20UI_20E2E_20Report.zip`,
                  },
                ],
              },
            },
          ],
        },
      ],
      results: [
        {
          type: 'junit',
          files: ['./results.xml'],
        },
      ],
    },
  ],
});

publish({ config });
