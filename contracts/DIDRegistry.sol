// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract DIDRegistry {
    
    struct DIDDocument {
        string id;
        address controller;
        string[] verificationMethods;
        string[] services;
        uint256 timestamp;
        bool active;
        bytes32 dataHash;
    }
    
    mapping(string => DIDDocument) public didDocuments;
    mapping(address => bool) public isAdmin;
    
    event DIDCreated(string indexed didId, address indexed controller);
    event DIDUpdated(string indexed didId, bytes32 dataHash);
    
    constructor() {
        isAdmin[msg.sender] = true;
    }
    
    modifier onlyController(string memory _didId) {
        require(didDocuments[_didId].controller == msg.sender, "Not authorized");
        _;
    }
    
    modifier onlyAdmin() {
        require(isAdmin[msg.sender], "Admin access required");
        _;
    }
    
    function createDID(
        string memory _didId,
        string[] memory _verificationMethods,
        string[] memory _services,
        bytes32 _dataHash
    ) external {
        require(bytes(didDocuments[_didId].id).length == 0, "DID already exists");
        
        didDocuments[_didId] = DIDDocument({
            id: _didId,
            controller: msg.sender,
            verificationMethods: _verificationMethods,
            services: _services,
            timestamp: block.timestamp,
            active: true,
            dataHash: _dataHash
        });
        
        emit DIDCreated(_didId, msg.sender);
    }
    
    function updateDID(
        string memory _didId,
        string[] memory _verificationMethods,
        string[] memory _services,
        bytes32 _dataHash
    ) external onlyController(_didId) {
        require(didDocuments[_didId].active, "DID is deactivated");
        
        didDocuments[_didId].verificationMethods = _verificationMethods;
        didDocuments[_didId].services = _services;
        didDocuments[_didId].dataHash = _dataHash;
        didDocuments[_didId].timestamp = block.timestamp;
        
        emit DIDUpdated(_didId, _dataHash);
    }
    
    function deactivateDID(string memory _didId) external onlyController(_didId) {
        didDocuments[_didId].active = false;
    }
    
    function verifyDID(string memory _didId) external view returns (bool) {
        return didDocuments[_didId].active && 
               bytes(didDocuments[_didId].id).length > 0;
    }
    
    function getDIDDocument(string memory _didId) 
        external view returns (DIDDocument memory) {
        return didDocuments[_didId];
    }
    
    function addAdmin(address _admin) external onlyAdmin {
        isAdmin[_admin] = true;
    }
}