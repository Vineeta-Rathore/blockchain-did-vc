// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * @title DIDRegistry
 * @notice Registry of DID documents with controller-authorised updates, key rotation and
 *         deactivation, a two-step controller handover, and per-credential revocation keyed by
 *         the issuer DID.
 * @dev Administrators can pause registration and document changes, but not revocation,
 *      deactivation or the cancellation of a handover, and every administrator action emits an
 *      event. Revocation records carry an RFC 5280 (section 5.3.1) reason code instead of free
 *      text. Storage holds no copies: the authentication methods returned by getDIDDocument are
 *      the verification methods, and getRevocationEntry returns the credential ID it is asked
 *      about.
 */
contract DIDRegistry {

    // ========== STRUCTS ==========

    /**
     * @notice W3C DID Document representation, as returned by getDIDDocument
     * @dev authenticationMethods is always equal to verificationMethods and is not stored.
     */
    struct DIDDocument {
        string id;                          // DID identifier (e.g., did:eth:0x123...)
        address controller;                 // Current controller address
        string[] verificationMethods;       // Public keys for verification
        string[] authenticationMethods;     // Keys for authentication
        string[] services;                  // Service endpoints
        uint256 created;                    // Creation timestamp
        uint256 updated;                    // Last update timestamp
        bool active;                        // Active status
        bytes32 dataHash;                   // Off-chain data hash (IPFS, etc.)
        uint256 nonce;                      // For replay protection
    }

    /**
     * @notice Credential revocation entry, as returned by getRevocationEntry
     */
    struct RevocationEntry {
        string credentialId;
        uint256 revokedAt;
        uint8 reasonCode;                   // RFC 5280 section 5.3.1 code; 0 = not stated
        bool isRevoked;
    }

    /**
     * @notice A DID document as stored (DIDDocument without the authentication methods)
     */
    struct DIDRecord {
        string id;
        address controller;
        string[] verificationMethods;
        string[] services;
        uint256 created;
        uint256 updated;
        bool active;
        bytes32 dataHash;
        uint256 nonce;
    }

    /**
     * @notice A revocation as stored: one storage slot (the credential ID is the mapping key)
     */
    struct Revocation {
        uint64 revokedAt;
        uint8 reasonCode;
        bool isRevoked;
    }

    /**
     * @notice Delegate for DID operations
     */
    struct Delegate {
        address delegateAddress;
        bytes32 delegateType;    // e.g., keccak256("sigAuth"), keccak256("attestation")
        uint256 validity;        // Expiration timestamp
    }

    // ========== STATE VARIABLES ==========

    // DID Documents storage
    mapping(string => DIDRecord) private didDocuments;

    // Controller to DIDs mapping (for reverse lookup)
    mapping(address => string[]) private controllerDIDs;

    // Admin registry
    mapping(address => bool) public isAdmin;

    // Revocation registry
    mapping(string => mapping(string => Revocation)) private revocations;

    // Proposed new controller of a DID (two-step handover); zero if none
    mapping(string => address) private pendingControllers;

    // Delegates for DIDs
    mapping(string => Delegate[]) private delegates;

    // Attribute storage for flexible properties
    mapping(string => mapping(bytes32 => bytes)) private attributes;

    // Nonce for each controller (replay protection)
    mapping(address => uint256) public nonces;

    // Contract state
    bool public paused;
    address public owner;

    // ========== EVENTS ==========

    event DIDCreated(
        string indexed didId,
        address indexed controller,
        uint256 timestamp
    );

    event DIDUpdated(
        string indexed didId,
        bytes32 dataHash,
        uint256 timestamp
    );

    event DIDDeactivated(
        string indexed didId,
        address indexed controller,
        uint256 timestamp
    );

    event DIDReactivated(
        string indexed didId,
        address indexed controller,
        uint256 timestamp
    );

    event ControllerChanged(
        string indexed didId,
        address indexed previousController,
        address indexed newController,
        uint256 timestamp
    );

    event ControllerChangeProposed(
        string indexed didId,
        address indexed controller,
        address indexed proposedController,
        uint256 timestamp
    );

    event ControllerChangeCancelled(
        string indexed didId,
        address indexed controller,
        address indexed proposedController,
        uint256 timestamp
    );

    event KeyRotated(
        string indexed didId,
        string oldKey,
        string newKey,
        uint256 timestamp
    );

    event CredentialRevoked(
        string indexed didId,
        string indexed credentialId,
        uint8 reasonCode,
        uint256 timestamp
    );

    event DelegateAdded(
        string indexed didId,
        address indexed delegate,
        bytes32 delegateType,
        uint256 validity
    );

    event DelegateRemoved(
        string indexed didId,
        address indexed delegate,
        bytes32 delegateType
    );

    event AttributeChanged(
        string indexed didId,
        bytes32 indexed name,
        bytes value,
        uint256 timestamp
    );

    event AdminAdded(address indexed admin, address indexed by);

    event AdminRemoved(address indexed admin, address indexed by);

    event Paused(address indexed by);

    event Unpaused(address indexed by);

    // ========== MODIFIERS ==========

    modifier onlyController(string memory _didId) {
        require(
            didDocuments[_didId].controller == msg.sender,
            "DIDRegistry: Not authorized"
        );
        _;
    }

    modifier onlyControllerOrDelegate(string memory _didId, bytes32 _delegateType) {
        require(
            didDocuments[_didId].controller == msg.sender ||
            _isValidDelegate(_didId, msg.sender, _delegateType),
            "DIDRegistry: Not authorized"
        );
        _;
    }

    modifier onlyAdmin() {
        require(isAdmin[msg.sender], "DIDRegistry: Admin access required");
        _;
    }

    modifier whenNotPaused() {
        require(!paused, "DIDRegistry: Contract paused");
        _;
    }

    modifier didExists(string memory _didId) {
        require(
            bytes(didDocuments[_didId].id).length > 0,
            "DIDRegistry: DID does not exist"
        );
        _;
    }

    modifier didActive(string memory _didId) {
        require(
            didDocuments[_didId].active,
            "DIDRegistry: DID is deactivated"
        );
        _;
    }

    // ========== CONSTRUCTOR ==========

    constructor() {
        owner = msg.sender;
        isAdmin[msg.sender] = true;
    }

    // ========== DID MANAGEMENT ==========

    /**
     * @notice Create a new DID document
     * @param _didId Unique DID identifier
     * @param _verificationMethods Public keys for verification
     * @param _services Service endpoints
     * @param _dataHash Hash of off-chain data
     */
    function createDID(
        string memory _didId,
        string[] memory _verificationMethods,
        string[] memory _services,
        bytes32 _dataHash
    ) external whenNotPaused {
        require(
            bytes(didDocuments[_didId].id).length == 0,
            "DIDRegistry: DID already exists"
        );
        require(bytes(_didId).length > 0, "DIDRegistry: Invalid DID");

        didDocuments[_didId] = DIDRecord({
            id: _didId,
            controller: msg.sender,
            verificationMethods: _verificationMethods,
            services: _services,
            created: block.timestamp,
            updated: block.timestamp,
            active: true,
            dataHash: _dataHash,
            nonce: 0
        });

        // Add to controller's DIDs list
        controllerDIDs[msg.sender].push(_didId);

        emit DIDCreated(_didId, msg.sender, block.timestamp);
    }

    /**
     * @notice Update DID document
     * @dev Allowed while the DID is deactivated, so that a controller can replace keys before
     *      reactivating it. The authentication methods follow the new verification methods.
     * @param _didId DID to update
     * @param _verificationMethods New verification methods
     * @param _services New services
     * @param _dataHash New data hash
     */
    function updateDID(
        string memory _didId,
        string[] memory _verificationMethods,
        string[] memory _services,
        bytes32 _dataHash
    ) external
        whenNotPaused
        didExists(_didId)
        onlyController(_didId)
    {
        DIDRecord storage doc = didDocuments[_didId];

        doc.verificationMethods = _verificationMethods;
        doc.services = _services;
        doc.dataHash = _dataHash;
        doc.updated = block.timestamp;
        doc.nonce++;

        emit DIDUpdated(_didId, _dataHash, block.timestamp);
    }

    /**
     * @notice Deactivate a DID (soft delete)
     * @dev Not blocked by pause(), so that a controller can always deactivate. A pending
     *      controller handover is cancelled.
     * @param _didId DID to deactivate
     */
    function deactivateDID(string memory _didId)
        external
        didExists(_didId)
        onlyController(_didId)
    {
        _cancelPendingController(_didId);
        didDocuments[_didId].active = false;
        didDocuments[_didId].updated = block.timestamp;

        emit DIDDeactivated(_didId, msg.sender, block.timestamp);
    }

    /**
     * @notice Reactivate a deactivated DID
     * @param _didId DID to reactivate
     */
    function reactivateDID(string memory _didId)
        external
        whenNotPaused
        didExists(_didId)
        onlyController(_didId)
    {
        require(!didDocuments[_didId].active, "DIDRegistry: DID is already active");

        didDocuments[_didId].active = true;
        didDocuments[_didId].updated = block.timestamp;

        emit DIDReactivated(_didId, msg.sender, block.timestamp);
    }

    /**
     * @notice Propose a new controller for a DID (first step of the handover)
     * @dev Control moves only when the proposed address calls acceptController. A later proposal
     *      replaces an earlier one. The controller keeps full control until acceptance.
     * @param _didId DID to transfer
     * @param _newController Proposed controller address
     */
    function changeController(
        string memory _didId,
        address _newController
    ) external
        whenNotPaused
        didExists(_didId)
        didActive(_didId)
        onlyController(_didId)
    {
        require(_newController != address(0), "DIDRegistry: Invalid controller");
        require(_newController != msg.sender, "DIDRegistry: Already the controller");

        pendingControllers[_didId] = _newController;

        emit ControllerChangeProposed(_didId, msg.sender, _newController, block.timestamp);
    }

    /**
     * @notice Accept control of a DID (second step of the handover), called by the proposed address
     * @param _didId DID to take over
     */
    function acceptController(string memory _didId)
        external
        whenNotPaused
        didExists(_didId)
        didActive(_didId)
    {
        require(
            pendingControllers[_didId] == msg.sender && msg.sender != address(0),
            "DIDRegistry: Not the proposed controller"
        );
        delete pendingControllers[_didId];

        DIDRecord storage doc = didDocuments[_didId];
        address previousController = doc.controller;
        doc.controller = msg.sender;
        doc.updated = block.timestamp;
        doc.nonce++;

        _removeFromControllerList(previousController, _didId);
        controllerDIDs[msg.sender].push(_didId);

        emit ControllerChanged(_didId, previousController, msg.sender, block.timestamp);
    }

    /**
     * @notice Withdraw a pending controller proposal
     * @dev Not blocked by pause(), so that a mistaken proposal can be withdrawn before the
     *      registry is unpaused.
     * @param _didId DID whose proposal is withdrawn
     */
    function cancelControllerChange(string memory _didId)
        external
        didExists(_didId)
        onlyController(_didId)
    {
        require(pendingControllers[_didId] != address(0), "DIDRegistry: No pending controller");
        _cancelPendingController(_didId);
    }

    /**
     * @notice The proposed new controller of a DID, or the zero address if there is none
     */
    function getPendingController(string memory _didId) external view returns (address) {
        return pendingControllers[_didId];
    }

    /**
     * @notice Rotate a verification key
     * @dev Allowed while the DID is deactivated, so that a controller can replace a leaked key
     *      before reactivating it. The authentication methods are the verification methods, so
     *      the key is rotated in both.
     * @param _didId DID to update
     * @param _keyIndex Index of key to rotate
     * @param _newKey New key value
     */
    function rotateKey(
        string memory _didId,
        uint256 _keyIndex,
        string memory _newKey
    ) external
        whenNotPaused
        didExists(_didId)
        onlyController(_didId)
    {
        DIDRecord storage doc = didDocuments[_didId];
        require(_keyIndex < doc.verificationMethods.length, "DIDRegistry: Invalid key index");

        string memory oldKey = doc.verificationMethods[_keyIndex];
        doc.verificationMethods[_keyIndex] = _newKey;
        doc.updated = block.timestamp;
        doc.nonce++;

        emit KeyRotated(_didId, oldKey, _newKey, block.timestamp);
    }

    // ========== DID RESOLUTION ==========

    /**
     * @notice Verify if a DID exists and is active
     * @param _didId DID to verify
     * @return exists Whether DID exists and is active
     */
    function verifyDID(string memory _didId) external view returns (bool exists) {
        return didDocuments[_didId].active &&
               bytes(didDocuments[_didId].id).length > 0;
    }

    /**
     * @notice Get full DID document
     * @dev authenticationMethods is the list of verification methods (not stored separately).
     * @param _didId DID to retrieve
     * @return document The DID document
     */
    function getDIDDocument(string memory _didId)
        external
        view
        returns (DIDDocument memory document)
    {
        DIDRecord storage r = didDocuments[_didId];
        string[] memory methods = r.verificationMethods;
        document.id = r.id;
        document.controller = r.controller;
        document.verificationMethods = methods;
        document.authenticationMethods = methods;
        document.services = r.services;
        document.created = r.created;
        document.updated = r.updated;
        document.active = r.active;
        document.dataHash = r.dataHash;
        document.nonce = r.nonce;
    }

    /**
     * @notice Get DIDs controlled by an address
     * @param _controller Controller address
     * @return dids List of DIDs
     */
    function getDIDsByController(address _controller)
        external
        view
        returns (string[] memory dids)
    {
        return controllerDIDs[_controller];
    }

    /**
     * @notice Get the controller of a DID
     * @param _didId DID to query
     * @return controller Controller address
     */
    function getController(string memory _didId)
        external
        view
        returns (address controller)
    {
        return didDocuments[_didId].controller;
    }

    // ========== REVOCATION REGISTRY ==========

    /**
     * @notice Revoke a credential
     * @dev Not blocked by pause(), so that an issuer can always revoke. A revocation is final.
     *      Accepted reason codes follow RFC 5280 section 5.3.1 (CRLReason): 0 unspecified, used
     *      here to mean "not stated"; 1 keyCompromise; 2 cACompromise; 3 affiliationChanged;
     *      4 superseded; 5 cessationOfOperation; 9 privilegeWithdrawn; 10 aACompromise.
     *      Rejected: 6 certificateHold (revocation here cannot be undone), 7 (not used in
     *      RFC 5280), 8 removeFromCRL (delta CRLs only) and any value above 10.
     * @param _didId Issuer's DID
     * @param _credentialId Credential to revoke
     * @param _reasonCode RFC 5280 reason code, 0 if not stated
     */
    function revokeCredential(
        string memory _didId,
        string memory _credentialId,
        uint8 _reasonCode
    ) external
        didExists(_didId)
        onlyController(_didId)
    {
        require(_isValidReasonCode(_reasonCode), "DIDRegistry: Invalid reason code");
        require(
            !revocations[_didId][_credentialId].isRevoked,
            "DIDRegistry: Already revoked"
        );

        revocations[_didId][_credentialId] = Revocation({
            revokedAt: uint64(block.timestamp),
            reasonCode: _reasonCode,
            isRevoked: true
        });

        emit CredentialRevoked(_didId, _credentialId, _reasonCode, block.timestamp);
    }

    /**
     * @notice Check if a credential is revoked
     * @param _didId Issuer's DID
     * @param _credentialId Credential to check
     * @return isRevoked Whether credential is revoked
     */
    function isCredentialRevoked(
        string memory _didId,
        string memory _credentialId
    ) external view returns (bool isRevoked) {
        return revocations[_didId][_credentialId].isRevoked;
    }

    /**
     * @notice Get revocation details
     * @dev For a credential that is not revoked, every field is empty or zero.
     * @param _didId Issuer's DID
     * @param _credentialId Credential to query
     * @return entry Revocation entry
     */
    function getRevocationEntry(
        string memory _didId,
        string memory _credentialId
    ) external view returns (RevocationEntry memory entry) {
        Revocation storage r = revocations[_didId][_credentialId];
        if (r.isRevoked) {
            entry = RevocationEntry({
                credentialId: _credentialId,
                revokedAt: r.revokedAt,
                reasonCode: r.reasonCode,
                isRevoked: true
            });
        }
    }

    // ========== DELEGATION ==========

    /**
     * @notice Add a delegate for DID operations
     * @param _didId DID to delegate
     * @param _delegate Delegate address
     * @param _delegateType Type of delegation
     * @param _validity Validity period in seconds
     */
    function addDelegate(
        string memory _didId,
        address _delegate,
        bytes32 _delegateType,
        uint256 _validity
    ) external
        whenNotPaused
        didExists(_didId)
        onlyController(_didId)
    {
        delegates[_didId].push(Delegate({
            delegateAddress: _delegate,
            delegateType: _delegateType,
            validity: block.timestamp + _validity
        }));

        emit DelegateAdded(_didId, _delegate, _delegateType, block.timestamp + _validity);
    }

    /**
     * @notice Remove a delegate
     * @param _didId DID
     * @param _delegate Delegate to remove
     * @param _delegateType Type of delegation
     */
    function removeDelegate(
        string memory _didId,
        address _delegate,
        bytes32 _delegateType
    ) external
        whenNotPaused
        didExists(_didId)
        onlyController(_didId)
    {
        Delegate[] storage delegateList = delegates[_didId];
        for (uint i = 0; i < delegateList.length; i++) {
            if (delegateList[i].delegateAddress == _delegate &&
                delegateList[i].delegateType == _delegateType) {
                delegateList[i] = delegateList[delegateList.length - 1];
                delegateList.pop();
                emit DelegateRemoved(_didId, _delegate, _delegateType);
                break;
            }
        }
    }

    /**
     * @notice Check if delegate is valid
     */
    function _isValidDelegate(
        string memory _didId,
        address _delegate,
        bytes32 _delegateType
    ) internal view returns (bool) {
        Delegate[] storage delegateList = delegates[_didId];
        for (uint i = 0; i < delegateList.length; i++) {
            if (delegateList[i].delegateAddress == _delegate &&
                delegateList[i].delegateType == _delegateType &&
                delegateList[i].validity > block.timestamp) {
                return true;
            }
        }
        return false;
    }

    // ========== ATTRIBUTE MANAGEMENT ==========

    /**
     * @notice Set an attribute on a DID
     * @param _didId DID
     * @param _name Attribute name
     * @param _value Attribute value
     */
    function setAttribute(
        string memory _didId,
        bytes32 _name,
        bytes memory _value
    ) external
        whenNotPaused
        didExists(_didId)
        onlyController(_didId)
    {
        attributes[_didId][_name] = _value;
        didDocuments[_didId].updated = block.timestamp;

        emit AttributeChanged(_didId, _name, _value, block.timestamp);
    }

    /**
     * @notice Get an attribute
     * @param _didId DID
     * @param _name Attribute name
     * @return value Attribute value
     */
    function getAttribute(
        string memory _didId,
        bytes32 _name
    ) external view returns (bytes memory value) {
        return attributes[_didId][_name];
    }

    // ========== ADMIN FUNCTIONS ==========

    function addAdmin(address _admin) external onlyAdmin {
        isAdmin[_admin] = true;
        emit AdminAdded(_admin, msg.sender);
    }

    function removeAdmin(address _admin) external onlyAdmin {
        require(_admin != owner, "DIDRegistry: Cannot remove owner");
        isAdmin[_admin] = false;
        emit AdminRemoved(_admin, msg.sender);
    }

    /**
     * @notice Pause registration and document changes
     * @dev revokeCredential and deactivateDID stay available while paused.
     */
    function pause() external onlyAdmin {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyAdmin {
        paused = false;
        emit Unpaused(msg.sender);
    }

    // ========== INTERNAL HELPERS ==========

    /**
     * @notice Whether a reason code is accepted (see revokeCredential)
     */
    function _isValidReasonCode(uint8 _code) internal pure returns (bool) {
        return _code <= 10 && _code != 6 && _code != 7 && _code != 8;
    }

    function _cancelPendingController(string memory _didId) internal {
        address proposed = pendingControllers[_didId];
        if (proposed != address(0)) {
            delete pendingControllers[_didId];
            emit ControllerChangeCancelled(_didId, didDocuments[_didId].controller, proposed, block.timestamp);
        }
    }

    function _removeFromControllerList(address _controller, string memory _didId) internal {
        string[] storage dids = controllerDIDs[_controller];
        for (uint i = 0; i < dids.length; i++) {
            if (keccak256(bytes(dids[i])) == keccak256(bytes(_didId))) {
                dids[i] = dids[dids.length - 1];
                dids.pop();
                break;
            }
        }
    }
}