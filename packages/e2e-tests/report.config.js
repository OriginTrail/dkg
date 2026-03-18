import { publish, defineConfig } from 'test-results-reporter';
import dotenv from 'dotenv';
dotenv.config();

const teamsHook = process.env.V9_TEAMS_HOOK;

if (!teamsHook) {
  console.error('V9_TEAMS_HOOK not set — skipping report');
  process.exit(0);
}

const config = defineConfig({
  reports: [
    {
      targets: [
        {
          name: 'teams',
          condition: 'fail',
          inputs: {
            url: teamsHook,
            only_failures: true,
            publish: 'test-summary-slim',
            title: 'DKG v9 — E2E Test Report',
            width: 'Full',
          },
          extensions: [
            {
              name: 'quick-chart-test-summary',
            },
          ],
        },
      ],
      results: [
        {
          type: 'junit',
          files: ['./results/e2e-results.xml'],
        },
      ],
    },
  ],
});

publish({ config });
