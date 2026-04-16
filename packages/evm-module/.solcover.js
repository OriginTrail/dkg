module.exports = {
  mocha: {
    timeout: 600_000,
  },
  providerOptions: {
    allowUnlimitedContractSize: true,
  },
  configureYulOptimizer: true,
};
