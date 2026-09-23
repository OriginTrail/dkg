// Side-effect module imported first by `main.tsx`, so a token entered earlier in
// this tab is in place before any other module can issue an API call.
import { restoreEnteredApiToken } from './apiToken.js';

restoreEnteredApiToken();
