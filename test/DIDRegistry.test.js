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

    it("Should set deployer as owner", async function () {
      expect(await didRegistry.owner()).to.equal(owner.address);
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
      ).to.emit(didRegistry, "DIDCreated");

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
      ).to.be.revertedWith("DIDRegistry: DID already exists");
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
      ).to.emit(didRegistry, "DIDUpdated");

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
      ).to.be.revertedWith("DIDRegistry: Not authorized");
    });

    it("Should prevent non-controller from deactivating DID", async function () {
      const didId = "did:example:update-test";

      await expect(
        didRegistry.connect(user2).deactivateDID(didId)
      ).to.be.revertedWith("DIDRegistry: Not authorized");
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

  describe("Controller Management", function () {
    it("Should transfer DID control in two steps: proposal, then acceptance by the new address", async function () {
      const didId = "did:example:transfer-test";
      const verificationMethods = ["key1"];
      const services = ["service1"];
      const dataHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("transfer"));

      await didRegistry.connect(user1).createDID(didId, verificationMethods, services, dataHash);

      await expect(
        didRegistry.connect(user1).changeController(didId, user2.address)
      ).to.emit(didRegistry, "ControllerChangeProposed");
      expect(await didRegistry.getController(didId)).to.equal(user1.address);
      expect(await didRegistry.getPendingController(didId)).to.equal(user2.address);

      await expect(didRegistry.connect(user2).acceptController(didId)).to.emit(didRegistry, "ControllerChanged");
      expect(await didRegistry.getController(didId)).to.equal(user2.address);
      expect(await didRegistry.getPendingController(didId)).to.equal(ethers.constants.AddressZero);
    });

    it("Should get DIDs by controller", async function () {
      const didId1 = "did:example:lookup-1";
      const didId2 = "did:example:lookup-2";
      const verificationMethods = ["key1"];
      const services = ["service1"];
      const dataHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("lookup"));

      await didRegistry.connect(user1).createDID(didId1, verificationMethods, services, dataHash);
      await didRegistry.connect(user1).createDID(didId2, verificationMethods, services, dataHash);

      const dids = await didRegistry.getDIDsByController(user1.address);
      expect(dids.length).to.equal(2);
      expect(dids).to.include(didId1);
      expect(dids).to.include(didId2);
    });

    it("Should prevent non-controller from transferring DID control", async function () {
      const didId = "did:example:transfer-unauth";
      const verificationMethods = ["key1"];
      const services = ["service1"];
      const dataHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("transfer-unauth"));

      await didRegistry.connect(user1).createDID(didId, verificationMethods, services, dataHash);

      await expect(
        didRegistry.connect(user2).changeController(didId, user2.address)
      ).to.be.revertedWith("DIDRegistry: Not authorized");
    });
  });

  describe("Two-step controller handover", function () {
    const didId = "did:example:handover";
    const dataHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("handover"));
    const topic = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(didId));
    // ethers v5 decodes these events with positional keys only (didId, controller, proposed or new address, timestamp)
    const eventOf = (receipt, name) => receipt.events.find((e) => e.event === name);
    const notProposed = "DIDRegistry: Not the proposed controller";

    beforeEach(async function () {
      await didRegistry.connect(user1).createDID(didId, ["key1"], [], dataHash);
    });

    it("emits the proposal with the DID, the controller and the proposed address", async function () {
      const receipt = await (await didRegistry.connect(user1).changeController(didId, user2.address)).wait();
      const e = eventOf(receipt, "ControllerChangeProposed");
      expect(e.args[0].hash).to.equal(topic);
      expect(e.args[1]).to.equal(user1.address);
      expect(e.args[2]).to.equal(user2.address);
      expect(e.args[3].toNumber()).to.equal((await ethers.provider.getBlock(receipt.blockNumber)).timestamp);
    });

    it("moves control, the reverse lookup and the nonce only on acceptance, and emits ControllerChanged", async function () {
      await didRegistry.connect(user1).changeController(didId, user2.address);
      expect(await didRegistry.getDIDsByController(user1.address)).to.deep.equal([didId]);
      expect(await didRegistry.getDIDsByController(user2.address)).to.deep.equal([]);
      const nonceBefore = (await didRegistry.getDIDDocument(didId)).nonce;

      const receipt = await (await didRegistry.connect(user2).acceptController(didId)).wait();
      const e = eventOf(receipt, "ControllerChanged");
      expect(e.args[0].hash).to.equal(topic);
      expect(e.args[1]).to.equal(user1.address);
      expect(e.args[2]).to.equal(user2.address);
      expect(await didRegistry.getDIDsByController(user1.address)).to.deep.equal([]);
      expect(await didRegistry.getDIDsByController(user2.address)).to.deep.equal([didId]);
      expect((await didRegistry.getDIDDocument(didId)).nonce).to.equal(nonceBefore.add(1));
    });

    it("lets the old controller act until acceptance, and only the new one after it", async function () {
      await didRegistry.connect(user1).changeController(didId, user2.address);
      await expect(didRegistry.connect(user1).rotateKey(didId, 0, "key2")).to.emit(didRegistry, "KeyRotated");
      await expect(didRegistry.connect(user2).rotateKey(didId, 0, "key3")).to.be.revertedWith("DIDRegistry: Not authorized");
      await didRegistry.connect(user2).acceptController(didId);
      await expect(didRegistry.connect(user1).rotateKey(didId, 0, "key4")).to.be.revertedWith("DIDRegistry: Not authorized");
      await expect(didRegistry.connect(user2).rotateKey(didId, 0, "key5")).to.emit(didRegistry, "KeyRotated");
    });

    it("refuses acceptance by any other address, without a proposal, and a second time", async function () {
      await expect(didRegistry.connect(user2).acceptController(didId)).to.be.revertedWith(notProposed);
      await didRegistry.connect(user1).changeController(didId, user2.address);
      await expect(didRegistry.connect(verifier).acceptController(didId)).to.be.revertedWith(notProposed);
      await expect(didRegistry.connect(user1).acceptController(didId)).to.be.revertedWith(notProposed);
      await didRegistry.connect(user2).acceptController(didId);
      await expect(didRegistry.connect(user2).acceptController(didId)).to.be.revertedWith(notProposed);
    });

    it("refuses the zero address and the current controller as proposals", async function () {
      await expect(
        didRegistry.connect(user1).changeController(didId, ethers.constants.AddressZero)
      ).to.be.revertedWith("DIDRegistry: Invalid controller");
      await expect(
        didRegistry.connect(user1).changeController(didId, user1.address)
      ).to.be.revertedWith("DIDRegistry: Already the controller");
    });

    it("replaces an earlier proposal with a later one", async function () {
      await didRegistry.connect(user1).changeController(didId, user2.address);
      await didRegistry.connect(user1).changeController(didId, verifier.address);
      expect(await didRegistry.getPendingController(didId)).to.equal(verifier.address);
      await expect(didRegistry.connect(user2).acceptController(didId)).to.be.revertedWith(notProposed);
      await didRegistry.connect(verifier).acceptController(didId);
      expect(await didRegistry.getController(didId)).to.equal(verifier.address);
    });

    it("emits a cancellation for the address an earlier proposal named when a later proposal replaces it", async function () {
      await didRegistry.connect(user1).changeController(didId, user2.address);
      const receipt = await (await didRegistry.connect(user1).changeController(didId, verifier.address)).wait();
      const cancelled = eventOf(receipt, "ControllerChangeCancelled");
      expect(cancelled.args[1]).to.equal(user1.address);
      expect(cancelled.args[2]).to.equal(user2.address);
      expect(eventOf(receipt, "ControllerChangeProposed").args[2]).to.equal(verifier.address);
      const again = await (await didRegistry.connect(user1).changeController(didId, verifier.address)).wait();
      expect(eventOf(again, "ControllerChangeCancelled"), "same address proposed again").to.equal(undefined);
    });

    it("keeps a pending proposal through updateDID and rotateKey", async function () {
      await didRegistry.connect(user1).changeController(didId, user2.address);
      await didRegistry.connect(user1).updateDID(didId, ["key2"], [], dataHash);
      await didRegistry.connect(user1).rotateKey(didId, 0, "key3");
      expect(await didRegistry.getPendingController(didId)).to.equal(user2.address);
      await didRegistry.connect(user2).acceptController(didId);
      expect(await didRegistry.getController(didId)).to.equal(user2.address);
    });

    it("names the controller in the cancellation that deactivation emits", async function () {
      await didRegistry.connect(user1).changeController(didId, user2.address);
      const receipt = await (await didRegistry.connect(user1).deactivateDID(didId)).wait();
      const e = eventOf(receipt, "ControllerChangeCancelled");
      expect(e.args[0].hash).to.equal(topic);
      expect(e.args[1]).to.equal(user1.address);
    });

    it("keeps every DID exactly once in its controller's list over chains of handovers, also back to an earlier controller", async function () {
      const other = "did:example:handover-2";
      await didRegistry.connect(user1).createDID(other, ["k"], [], dataHash);
      const move = async (did, from, to) => {
        await didRegistry.connect(from).changeController(did, to.address);
        await didRegistry.connect(to).acceptController(did);
      };
      await move(didId, user1, user2);
      await move(didId, user2, verifier);
      await move(didId, verifier, user1);
      await move(other, user1, user2);
      await move(other, user2, user1);
      await move(didId, user1, user2);
      expect(await didRegistry.getDIDsByController(user1.address)).to.deep.equal([other]);
      expect(await didRegistry.getDIDsByController(user2.address)).to.deep.equal([didId]);
      expect(await didRegistry.getDIDsByController(verifier.address)).to.deep.equal([]);
    });

    it("lets only the controller cancel a proposal, and emits the cancellation", async function () {
      await expect(didRegistry.connect(user1).cancelControllerChange(didId)).to.be.revertedWith(
        "DIDRegistry: No pending controller"
      );
      await didRegistry.connect(user1).changeController(didId, user2.address);
      await expect(didRegistry.connect(user2).cancelControllerChange(didId)).to.be.revertedWith("DIDRegistry: Not authorized");
      const receipt = await (await didRegistry.connect(user1).cancelControllerChange(didId)).wait();
      const e = eventOf(receipt, "ControllerChangeCancelled");
      expect(e.args[0].hash).to.equal(topic);
      expect(e.args[1]).to.equal(user1.address);
      expect(e.args[2]).to.equal(user2.address);
      expect(await didRegistry.getPendingController(didId)).to.equal(ethers.constants.AddressZero);
      await expect(didRegistry.connect(user2).acceptController(didId)).to.be.revertedWith(notProposed);
    });

    it("drops a pending proposal when the DID is deactivated, so it cannot be accepted after reactivation", async function () {
      await didRegistry.connect(user1).changeController(didId, user2.address);
      const receipt = await (await didRegistry.connect(user1).deactivateDID(didId)).wait();
      expect(eventOf(receipt, "ControllerChangeCancelled").args[2]).to.equal(user2.address);
      expect(await didRegistry.getPendingController(didId)).to.equal(ethers.constants.AddressZero);
      await didRegistry.connect(user1).reactivateDID(didId);
      await expect(didRegistry.connect(user2).acceptController(didId)).to.be.revertedWith(notProposed);
    });

    it("blocks proposal and acceptance while paused, but not cancellation", async function () {
      await didRegistry.connect(user1).changeController(didId, user2.address);
      await didRegistry.connect(owner).pause();
      await expect(didRegistry.connect(user1).changeController(didId, verifier.address)).to.be.revertedWith(
        "DIDRegistry: Contract paused"
      );
      await expect(didRegistry.connect(user2).acceptController(didId)).to.be.revertedWith("DIDRegistry: Contract paused");
      await expect(didRegistry.connect(user1).cancelControllerChange(didId)).to.emit(didRegistry, "ControllerChangeCancelled");
      await didRegistry.connect(owner).unpause();
      await expect(didRegistry.connect(user2).acceptController(didId)).to.be.revertedWith(notProposed);
    });
  });

  describe("Storage without copies (ABI unchanged)", function () {
    const didId = "did:example:layout";
    const dataHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("layout"));

    it("returns the verification methods as the authentication methods after create, update and rotation", async function () {
      await didRegistry.connect(user1).createDID(didId, ["A", "B"], ["s"], dataHash);
      expect((await didRegistry.getDIDDocument(didId)).authenticationMethods).to.deep.equal(["A", "B"]);
      await didRegistry.connect(user1).updateDID(didId, ["C"], ["s"], dataHash);
      expect((await didRegistry.getDIDDocument(didId)).authenticationMethods).to.deep.equal(["C"]);
      await didRegistry.connect(user1).rotateKey(didId, 0, "D");
      const doc = await didRegistry.getDIDDocument(didId);
      expect(doc.verificationMethods).to.deep.equal(["D"]);
      expect(doc.authenticationMethods).to.deep.equal(["D"]);
    });

    it("returns an empty entry for a credential that is not revoked", async function () {
      await didRegistry.connect(user1).createDID(didId, ["A"], [], dataHash);
      const entry = await didRegistry.getRevocationEntry(didId, "cred:never-revoked");
      expect(entry.credentialId).to.equal("");
      expect(entry.revokedAt.toNumber()).to.equal(0);
      expect(entry.reasonCode).to.equal(0);
      expect(entry.isRevoked).to.be.false;
    });

    it("stores a revocation in a single new storage slot", async function () {
      const { storageWrites } = require("../scripts/lib/gas-schedule");
      const { network } = require("hardhat");
      await didRegistry.connect(user1).createDID(didId, ["A"], [], dataHash);
      const receipt = await (await didRegistry.connect(user1).revokeCredential(didId, `urn:uuid:${"0".repeat(36)}`, 9)).wait();
      const writes = await storageWrites(
        network.provider, receipt.transactionHash, didRegistry.address, ethers.utils.hexValue(receipt.blockNumber - 1)
      );
      expect(writes.setCold + writes.setWarm).to.equal(1);
    });
  });

  describe("Key Rotation", function () {
    it("Should rotate verification key", async function () {
      const didId = "did:example:key-rotate";
      const verificationMethods = ["oldKey1", "oldKey2"];
      const services = ["service1"];
      const dataHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("keys"));

      await didRegistry.connect(user1).createDID(didId, verificationMethods, services, dataHash);

      await expect(
        didRegistry.connect(user1).rotateKey(didId, 0, "newKey1")
      ).to.emit(didRegistry, "KeyRotated");

      const didDoc = await didRegistry.getDIDDocument(didId);
      expect(didDoc.verificationMethods[0]).to.equal("newKey1");
      expect(didDoc.verificationMethods[1]).to.equal("oldKey2");
    });

    it("Should prevent non-controller from rotating verification key", async function () {
      const didId = "did:example:rotate-unauth";
      const verificationMethods = ["key1"];
      const services = [];
      const dataHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("rotate-unauth"));

      await didRegistry.connect(user1).createDID(didId, verificationMethods, services, dataHash);

      await expect(
        didRegistry.connect(user2).rotateKey(didId, 0, "maliciousKey")
      ).to.be.revertedWith("DIDRegistry: Not authorized");
    });

    it("Should keep the authentication methods in step with the verification methods, also with duplicate keys", async function () {
      const didId = "did:example:rotate-duplicates";
      const dataHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("rotate-duplicates"));
      await didRegistry.connect(user1).createDID(didId, ["A", "B"], [], dataHash);

      await didRegistry.connect(user1).rotateKey(didId, 0, "B");
      await didRegistry.connect(user1).rotateKey(didId, 0, "C");

      const didDoc = await didRegistry.getDIDDocument(didId);
      expect(didDoc.verificationMethods).to.deep.equal(["C", "B"]);
      expect(didDoc.authenticationMethods).to.deep.equal(["C", "B"]);
    });

    it("Should emit KeyRotated with the DID, the old key and the new key", async function () {
      const didId = "did:example:rotate-event";
      const dataHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("rotate-event"));
      await didRegistry.connect(user1).createDID(didId, ["k0", "k1"], [], dataHash);
      const receipt = await (await didRegistry.connect(user1).rotateKey(didId, 1, "k2")).wait();
      const event = receipt.events.find((e) => e.event === "KeyRotated");
      expect(event.args[0].hash).to.equal(ethers.utils.keccak256(ethers.utils.toUtf8Bytes(didId)));
      expect(event.args[1]).to.equal("k1");
      expect(event.args[2]).to.equal("k2");
    });

    it("Should reject a key index outside the list", async function () {
      const didId = "did:example:rotate-index";
      const dataHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("rotate-index"));
      await didRegistry.connect(user1).createDID(didId, ["k0"], [], dataHash);
      await expect(didRegistry.connect(user1).rotateKey(didId, 1, "k1")).to.be.revertedWith("DIDRegistry: Invalid key index");
    });
  });

  describe("Revocation Registry", function () {
    it("Should revoke a credential", async function () {
      const didId = "did:example:issuer";
      const credentialId = "cred:123456";
      const verificationMethods = ["key1"];
      const services = ["service1"];
      const dataHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("issuer"));

      await didRegistry.connect(user1).createDID(didId, verificationMethods, services, dataHash);

      await expect(
        didRegistry.connect(user1).revokeCredential(didId, credentialId, 1)
      ).to.emit(didRegistry, "CredentialRevoked");

      expect(await didRegistry.isCredentialRevoked(didId, credentialId)).to.be.true;
    });

    it("Should not revoke same credential twice", async function () {
      const didId = "did:example:issuer2";
      const credentialId = "cred:789";
      const verificationMethods = ["key1"];
      const services = [];
      const dataHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("issuer2"));

      await didRegistry.connect(user1).createDID(didId, verificationMethods, services, dataHash);
      await didRegistry.connect(user1).revokeCredential(didId, credentialId, 0);

      await expect(
        didRegistry.connect(user1).revokeCredential(didId, credentialId, 0)
      ).to.be.revertedWith("DIDRegistry: Already revoked");
    });

    it("Should allow credential revocation after issuer DID is deactivated", async function () {
      const didId = "did:example:post-deactivation-revoke";
      const credentialId = "cred:post-deactivation";
      const verificationMethods = ["key1"];
      const services = [];
      const dataHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("post-deactivation"));

      await didRegistry.connect(user1).createDID(didId, verificationMethods, services, dataHash);
      await didRegistry.connect(user1).deactivateDID(didId);
      expect(await didRegistry.verifyDID(didId)).to.be.false;

      // revokeCredential has no didActive modifier: the controller keeps revocation rights
      await expect(
        didRegistry.connect(user1).revokeCredential(didId, credentialId, 5)
      ).to.emit(didRegistry, "CredentialRevoked");
      expect(await didRegistry.isCredentialRevoked(didId, credentialId)).to.be.true;
    });

    it("Should revert when revoking credential on non-existent DID", async function () {
      await expect(
        didRegistry.connect(user1).revokeCredential(
          "did:example:does-not-exist", "cred:123", 0
        )
      ).to.be.revertedWith("DIDRegistry: DID does not exist");
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
      ).to.be.revertedWith("DIDRegistry: Admin access required");
    });

    it("Should allow admin to pause contract", async function () {
      await didRegistry.connect(owner).pause();
      expect(await didRegistry.paused()).to.be.true;
    });

    it("Should prevent non-admin from pausing contract", async function () {
      await expect(
        didRegistry.connect(user1).pause()
      ).to.be.revertedWith("DIDRegistry: Admin access required");
    });

    it("Should revert DID creation when contract is paused", async function () {
      await didRegistry.connect(owner).pause();

      await expect(
        didRegistry.connect(user1).createDID(
          "did:example:paused-test",
          ["key1"],
          [],
          ethers.utils.keccak256(ethers.utils.toUtf8Bytes("paused"))
        )
      ).to.be.revertedWith("DIDRegistry: Contract paused");
    });
  });

  describe("Pause scope", function () {
    const didId = "did:example:pause-scope";
    const dataHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("pause-scope"));

    beforeEach(async function () {
      await didRegistry.connect(user1).createDID(didId, ["key1", "key2"], ["service1"], dataHash);
      await didRegistry.connect(owner).pause();
    });

    it("lets the controller revoke a credential while paused", async function () {
      await expect(
        didRegistry.connect(user1).revokeCredential(didId, "cred:while-paused", 1)
      ).to.emit(didRegistry, "CredentialRevoked");
      expect(await didRegistry.isCredentialRevoked(didId, "cred:while-paused")).to.be.true;
    });

    it("lets the controller deactivate a DID while paused", async function () {
      await expect(didRegistry.connect(user1).deactivateDID(didId)).to.emit(didRegistry, "DIDDeactivated");
      expect(await didRegistry.verifyDID(didId)).to.be.false;
    });

    it("blocks every other write while paused", async function () {
      const paused = "DIDRegistry: Contract paused";
      const sigAuth = ethers.utils.formatBytes32String("sigAuth");
      await expect(
        didRegistry.connect(user2).createDID("did:example:new", ["key1"], [], dataHash)
      ).to.be.revertedWith(paused);
      await expect(
        didRegistry.connect(user1).updateDID(didId, ["key3"], [], dataHash)
      ).to.be.revertedWith(paused);
      await expect(didRegistry.connect(user1).rotateKey(didId, 0, "key9")).to.be.revertedWith(paused);
      await expect(
        didRegistry.connect(user1).changeController(didId, user2.address)
      ).to.be.revertedWith(paused);
      await expect(
        didRegistry.connect(user1).addDelegate(didId, user2.address, sigAuth, 3600)
      ).to.be.revertedWith(paused);
      await expect(
        didRegistry.connect(user1).removeDelegate(didId, user2.address, sigAuth)
      ).to.be.revertedWith(paused);
      await expect(
        didRegistry.connect(user1).setAttribute(didId, sigAuth, "0x01")
      ).to.be.revertedWith(paused);
      await didRegistry.connect(user1).deactivateDID(didId);
      await expect(didRegistry.connect(user1).reactivateDID(didId)).to.be.revertedWith(paused);
    });

    it("does not let the owner or another account revoke or deactivate someone else's DID", async function () {
      await expect(
        didRegistry.connect(owner).revokeCredential(didId, "cred:owner-attempt", 0)
      ).to.be.revertedWith("DIDRegistry: Not authorized");
      await expect(didRegistry.connect(user2).deactivateDID(didId)).to.be.revertedWith("DIDRegistry: Not authorized");
      await didRegistry.connect(owner).unpause();
      await expect(
        didRegistry.connect(owner).revokeCredential(didId, "cred:owner-attempt", 0)
      ).to.be.revertedWith("DIDRegistry: Not authorized");
    });

    it("keeps the read functions answering while paused", async function () {
      await didRegistry.connect(user1).revokeCredential(didId, "cred:read", 4);
      expect(await didRegistry.verifyDID(didId)).to.be.true;
      expect((await didRegistry.getDIDDocument(didId)).id).to.equal(didId);
      expect(await didRegistry.isCredentialRevoked(didId, "cred:read")).to.be.true;
      expect((await didRegistry.getRevocationEntry(didId, "cred:read")).reasonCode).to.equal(4);
    });
  });

  describe("Revocation reason codes", function () {
    const didId = "did:example:reason-codes";

    beforeEach(async function () {
      await didRegistry.connect(user1).createDID(
        didId, ["key1"], [], ethers.utils.keccak256(ethers.utils.toUtf8Bytes("reasons"))
      );
    });

    it("stores, returns and emits each accepted RFC 5280 code", async function () {
      for (const code of [0, 1, 2, 3, 4, 5, 9, 10]) {
        const credentialId = `cred:code-${code}`;
        const tx = await didRegistry.connect(user1).revokeCredential(didId, credentialId, code);
        const receipt = await tx.wait();
        const event = receipt.events.find((e) => e.event === "CredentialRevoked");
        // ethers v5 decodes this event with positional keys only (didId, credentialId, reasonCode, timestamp)
        expect(event.args[2]).to.equal(code);

        const entry = await didRegistry.getRevocationEntry(didId, credentialId);
        expect(entry.isRevoked).to.be.true;
        expect(entry.reasonCode).to.equal(code);
        expect(entry.credentialId).to.equal(credentialId);
        expect(entry.revokedAt.toNumber()).to.equal((await ethers.provider.getBlock(receipt.blockNumber)).timestamp);
      }
    });

    it("rejects codes 6, 7, 8, 11 and 255", async function () {
      for (const code of [6, 7, 8, 11, 255]) {
        await expect(
          didRegistry.connect(user1).revokeCredential(didId, `cred:bad-${code}`, code)
        ).to.be.revertedWith("DIDRegistry: Invalid reason code");
      }
    });
  });

  describe("Admin events", function () {
    it("emits an event for each admin action, naming the caller", async function () {
      await expect(didRegistry.connect(owner).addAdmin(user1.address))
        .to.emit(didRegistry, "AdminAdded").withArgs(user1.address, owner.address);
      await expect(didRegistry.connect(user1).pause())
        .to.emit(didRegistry, "Paused").withArgs(user1.address);
      await expect(didRegistry.connect(owner).unpause())
        .to.emit(didRegistry, "Unpaused").withArgs(owner.address);
      await expect(didRegistry.connect(owner).removeAdmin(user1.address))
        .to.emit(didRegistry, "AdminRemoved").withArgs(user1.address, owner.address);
    });
  });

  describe("Repair while deactivated", function () {
    const didId = "did:example:repair";
    const dataHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("repair"));

    beforeEach(async function () {
      await didRegistry.connect(user1).createDID(didId, ["oldKey1", "oldKey2"], ["service1"], dataHash);
    });

    it("rotates a key on a deactivated DID, which stays deactivated", async function () {
      await didRegistry.connect(user1).deactivateDID(didId);
      await expect(didRegistry.connect(user1).rotateKey(didId, 0, "newKey1")).to.emit(didRegistry, "KeyRotated");
      const doc = await didRegistry.getDIDDocument(didId);
      expect(doc.active).to.be.false;
      expect(doc.verificationMethods[0]).to.equal("newKey1");
      expect(await didRegistry.verifyDID(didId)).to.be.false;
    });

    it("updates a deactivated DID, which stays deactivated, and syncs its authentication keys", async function () {
      await didRegistry.connect(user1).deactivateDID(didId);
      await expect(
        didRegistry.connect(user1).updateDID(didId, ["freshKey"], ["service1"], dataHash)
      ).to.emit(didRegistry, "DIDUpdated");
      const doc = await didRegistry.getDIDDocument(didId);
      expect(doc.active).to.be.false;
      expect(doc.verificationMethods).to.deep.equal(["freshKey"]);
      expect(doc.authenticationMethods).to.deep.equal(["freshKey"]);
    });

    it("removes a rotated key from both key lists", async function () {
      await didRegistry.connect(user1).rotateKey(didId, 0, "newKey1");
      const doc = await didRegistry.getDIDDocument(didId);
      expect(doc.verificationMethods).to.not.include("oldKey1");
      expect(doc.authenticationMethods).to.not.include("oldKey1");
      expect(doc.authenticationMethods).to.include("newKey1");
      expect(doc.authenticationMethods).to.include("oldKey2");
    });

    it("still refuses a controller change on a deactivated DID", async function () {
      await didRegistry.connect(user1).deactivateDID(didId);
      await expect(
        didRegistry.connect(user1).changeController(didId, user2.address)
      ).to.be.revertedWith("DIDRegistry: DID is deactivated");
    });

    it("keeps revocations made while deactivated after reactivation", async function () {
      await didRegistry.connect(user1).deactivateDID(didId);
      await didRegistry.connect(user1).revokeCredential(didId, "cred:revoked-while-deactivated", 1);
      await didRegistry.connect(user1).reactivateDID(didId);
      expect(await didRegistry.verifyDID(didId)).to.be.true;
      expect(await didRegistry.isCredentialRevoked(didId, "cred:revoked-while-deactivated")).to.be.true;
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
      expect(receipt.gasUsed.toNumber()).to.be.lessThan(500000);
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

    it("Should reactivate deactivated DID", async function () {
      const didId = "did:example:reactivate";
      const verificationMethods = ["key1"];
      const services = [];
      const dataHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("reactivate"));

      await didRegistry.connect(user1).createDID(didId, verificationMethods, services, dataHash);
      await didRegistry.connect(user1).deactivateDID(didId);
      expect(await didRegistry.verifyDID(didId)).to.be.false;

      await didRegistry.connect(user1).reactivateDID(didId);
      expect(await didRegistry.verifyDID(didId)).to.be.true;
    });
  });
});

// Helper function
async function getBlockTimestamp() {
  const block = await ethers.provider.getBlock("latest");
  return block.timestamp;
}