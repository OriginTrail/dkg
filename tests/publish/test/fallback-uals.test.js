import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BASE_TESTNET_FALLBACK_UAL,
  getBaseTestnetPublishConfig,
} from '../src/Base_Testnet.config.js';

test('Base testnet uses the known-good Base Sepolia UAL by default', () => {
  const config = getBaseTestnetPublishConfig({});
  assert.equal(
    BASE_TESTNET_FALLBACK_UAL,
    'did:dkg:base:84532/0x4c92aee34bad19c3c51b632a0d48872dbdb02495/177',
  );
  assert.equal(config.blockchainName, 'v10:base:84532');
  assert.equal(config.fallbackUal, BASE_TESTNET_FALLBACK_UAL);
  assert.match(config.fallbackUal, /^did:dkg:base:84532\//);
});

test('DKG_FALLBACK_UAL still overrides the Base testnet default', () => {
  const override = 'did:dkg:base:84532/0xoverride/999';
  assert.equal(
    getBaseTestnetPublishConfig({ DKG_FALLBACK_UAL: override }).fallbackUal,
    override,
  );
});
