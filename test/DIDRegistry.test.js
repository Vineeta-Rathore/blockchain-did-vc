const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("DIDRegistry", function () {
  let didRegistry;
  let owner, user1, user2, verifier;

  beforeEach(async function () {
    [owner, user1, user2, verifier] = await ethers.getSigners();
    
    const DIDRegistry = await ethers.getContractFactory("DIDRegistry");
    didRegistry = await DIDRegistry.deploy();
    await didRegistry.deployed();
  });

  describe("Deployment", function () {
    it("Should set the deployer as admin", async function () {
      expect(await didRegistry.isAdmin(owner.address)).to.be.true;
    });

    it("Should have correct initial state", async function () {
      expect(await didRegistry.isAdmin(user1.address)).to.be.false;
    });
  });

  describe("DID Creation", function () {
    it("Should create a new DID successfully", async function () {
      const didId = "did:example:123456789";
      const verificationMethods = ["key1", "key2"];
      const services = ["service1"];
      const dataHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("test data"));

      await expect(
        didRegistry.connect(user1).createDID(didId, verificationMethods, services, dataHash)
      ).to.emit(didRegistry, "DIDCreated")
       .withArgs(didId, user1.address);

      const didDoc = await didRegistry.getDIDDocument(didId);
      expect(didDoc.id).to.equal(didId);
      expect(didDoc.controller).to.equal(user1.address);
      expect(didDoc.active).to.be.true;
      expect(didDoc.verificationMethods[0]).to.equal("key1");
    });

    it("Should prevent duplicate DID creation", async function () {
      const didId = "did:example:duplicate";
      const verificationMethods = ["key1"];
      const services = ["service1"];
      const dataHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("test"));

      await didRegistry.connect(user1).createDID(didId, verificationMethods, services, dataHash);
      
      await expect(
        didRegistry.connect(user2).createDID(didId, verificationMethods, services, dataHash)
      ).to.be.revertedWith("DID already exists");
    });

    it("Should handle multiple DIDs from same user", async function () {
      const didId1 = "did:example:user1-first";
      const didId2 = "did:example:user1-second";
      const verificationMethods = ["key1"];
      const services = ["service1"];
      const dataHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("test"));

      await didRegistry.connect(user1).createDID(didId1, verificationMethods, services, dataHash);
      await didRegistry.connect(user1).createDID(didId2, verificationMethods, services, dataHash);

      expect(await didRegistry.verifyDID(didId1)).to.be.true;
      expect(await didRegistry.verifyDID(didId2)).to.be.true;
    });
  });

  describe("DID Updates", function () {
    beforeEach(async function () {
      const didId = "did:example:update-test";
      const verificationMethods = ["key1"];
      const services = ["service1"];
      const dataHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("initial"));

      await didRegistry.connect(user1).createDID(didId, verificationMethods, services, dataHash);
    });

    it("Should allow controller to update DID", async function () {
      const didId = "did:example:update-test";
      const newVerificationMethods = ["key1", "key2"];
      const newServices = ["service1", "service2"];
      const newDataHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("updated"));

      await expect(
        didRegistry.connect(user1).updateDID(didId, newVerificationMethods, newServices, newDataHash)
      ).to.emit(didRegistry, "DIDUpdated")
       .withArgs(didId, newDataHash);

      const didDoc = await didRegistry.getDIDDocument(didId);
      expect(didDoc.verificationMethods.length).to.equal(2);
      expect(didDoc.services.length).to.equal(2);
    });

    it("Should prevent unauthorized updates", async function () {
      const didId = "did:example:update-test";
      const newVerificationMethods = ["malicious-key"];
      const newServices = ["malicious-service"];
      const newDataHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("malicious"));

      await expect(
        didRegistry.connect(user2).updateDID(didId, newVerificationMethods, newServices, newDataHash)
      ).to.be.revertedWith("Not authorized");
    });
  });

  describe("DID Verification", function () {
    it("Should return false for non-existent DID", async function () {
      const nonExistentDID = "did:example:nonexistent";
      expect(await didRegistry.verifyDID(nonExistentDID)).to.be.false;
    });

    it("Should return true for active DID", async function () {
      const didId = "did:example:active";
      const verificationMethods = ["key1"];
      const services = ["service1"];
      const dataHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("active"));

      await didRegistry.connect(user1).createDID(didId, verificationMethods, services, dataHash);
      expect(await didRegistry.verifyDID(didId)).to.be.true;
    });

    it("Should return false for deactivated DID", async function () {
      const didId = "did:example:deactivated";
      const verificationMethods = ["key1"];
      const services = ["service1"];
      const dataHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("deactivated"));

      await didRegistry.connect(user1).createDID(didId, verificationMethods, services, dataHash);
      await didRegistry.connect(user1).deactivateDID(didId);
      
      expect(await didRegistry.verifyDID(didId)).to.be.false;
    });
  });

  describe("Admin Functions", function () {
    it("Should allow admin to add new admin", async function () {
      await didRegistry.connect(owner).addAdmin(user1.address);
      expect(await didRegistry.isAdmin(user1.address)).to.be.true;
    });

    it("Should prevent non-admin from adding admin", async function () {
      await expect(
        didRegistry.connect(user1).addAdmin(user2.address)
      ).to.be.revertedWith("Admin access required");
    });
  });

  describe("Gas Optimization", function () {
    it("Should use reasonable gas for DID creation", async function () {
      const didId = "did:example:gas-test";
      const verificationMethods = ["key1"];
      const services = ["service1"];
      const dataHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("gas-test"));

      const tx = await didRegistry.connect(user1).createDID(
        didId, verificationMethods, services, dataHash
      );
      const receipt = await tx.wait();

      console.log(`Gas used for DID creation: ${receipt.gasUsed.toString()}`);
      expect(receipt.gasUsed.toNumber()).to.be.lessThan(300000);
    });
  });

  describe("Edge Cases", function () {
    it("Should handle empty verification methods", async function () {
      const didId = "did:example:empty-methods";
      const verificationMethods = [];
      const services = ["service1"];
      const dataHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("empty"));

      await didRegistry.connect(user1).createDID(didId, verificationMethods, services, dataHash);
      
      const didDoc = await didRegistry.getDIDDocument(didId);
      expect(didDoc.verificationMethods.length).to.equal(0);
      expect(didDoc.active).to.be.true;
    });

    it("Should handle long DID strings", async function () {
      const didId = "did:example:" + "a".repeat(100);
      const verificationMethods = ["key1"];
      const services = ["service1"];
      const dataHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("long"));

      await didRegistry.connect(user1).createDID(didId, verificationMethods, services, dataHash);
      expect(await didRegistry.verifyDID(didId)).to.be.true;
    });
  });
});