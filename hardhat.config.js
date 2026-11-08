require("@nomiclabs/hardhat-ethers");
require("@nomiclabs/hardhat-waffle");
require("dotenv").config();

// Sepolia is enabled only when both variables are supplied via a local .env
// file (see .env.example). Never commit real keys.
const { SEPOLIA_RPC_URL, PRIVATE_KEY } = process.env;

module.exports = {
  solidity: {
    version: "0.8.19",
    settings: { optimizer: { enabled: true, runs: 200 } },
  },
  networks: {
    // Hardfork pinned so that local gas figures do not drift with Hardhat's default. "osaka" is the newest fork
    // Hardhat 2.29.0 supports. Sepolia has run Glamsterdam since 6 Oct 2026, so Sepolia gas can differ from local gas
    // where Glamsterdam changed gas rules; the results README names each such difference.
    hardhat: { chainId: 1337, hardfork: "osaka" },
    localhost: { url: "http://127.0.0.1:8545" },
    ...(SEPOLIA_RPC_URL && PRIVATE_KEY
      ? { sepolia: { url: SEPOLIA_RPC_URL, accounts: [PRIVATE_KEY] } }
      : {}),
  },
};
