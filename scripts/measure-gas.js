/**
 * Reproduces the paper's headline on-chain gas figures deterministically.
 * Expected output (Solidity 0.8.19, optimiser 200 runs):
 *   createDID          346,878 gas
 *   revokeCredential   171,188 gas
 *
 * Run:  npx hardhat run scripts/measure-gas.js
 *       (add --network sepolia to measure on the public testnet; the same
 *        opcode pricing yields the identical figures.)
 */
const { ethers } = require("hardhat");

const dh = (s) => ethers.utils.keccak256(ethers.utils.toUtf8Bytes(s));

async function main() {
  const Factory = await ethers.getContractFactory("DIDRegistry");
  const reg = await Factory.deploy();
  await reg.deployed();

  // --- createDID: first DID for this controller (headline figure) ---
  const c = await (
    await reg.createDID("did:example:gas-test", ["key1"], ["service1"], dh("gas-test"))
  ).wait();

  // --- revokeCredential: issuer DID + a 45-char urn:uuid credential id ---
  await (
    await reg.createDID("did:journal2:issuer", ["key1"], ["service1"], dh("issuer"))
  ).wait();
  const r = await (
    await reg.revokeCredential(
      "did:journal2:issuer",
      "urn:uuid:12345678-1234-1234-1234-123456789abc",
      "Credential withdrawn by issuer"
    )
  ).wait();

  console.log("createDID gas        :", c.gasUsed.toString(), "(paper: 346,878)");
  console.log("revokeCredential gas :", r.gasUsed.toString(), "(paper: 171,188)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
