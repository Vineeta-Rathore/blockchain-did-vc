require("@nomiclabs/hardhat-ethers");
require("@nomiclabs/hardhat-waffle");

// Local networks only. Sepolia deployment and measurement use plain-Node scripts (scripts/deploy-sepolia.js and
// scripts/measure-sepolia.js) that read SEPOLIA_RPC_URL and nothing else from the environment; no Hardhat command
// loads a private key.
module.exports = {
  solidity: {
    version: "0.8.19",
    settings: { optimizer: { enabled: true, runs: 200 } },
  },
  networks: {
    // Hardfork pinned so that local gas figures do not drift with Hardhat's default. "osaka" is the newest fork
    // Hardhat 2.29.0 supports. Sepolia has run Glamsterdam since 6 Oct 2026, so Sepolia gas can differ from local gas
    // where Glamsterdam changed gas rules; results/README.md names each such difference.
    hardhat: { chainId: 1337, hardfork: "osaka" },
    localhost: { url: "http://127.0.0.1:8545" },
  },
};
