// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Terms} from "../Types.sol";

interface IEscrowFactory {
    event EscrowCreated(
        address indexed escrow,
        address indexed payer,
        address indexed payee,
        address token,
        uint256 amount,
        bytes32 orderRef,
        address arbiter
    );
    event DefaultArbiterSet(address arbiter);
    event BackupArbiterSet(address backupArbiter);
    event TreasurySet(address treasury);
    event TokenAllowed(address token);
    event TokenDisallowed(address token);
    event FeeCapSet(uint16 bps);
    event FreezeAdapterSet(address indexed token, address adapter);
    event CreationPaused();
    event CreationUnpaused();

    error NotAdmin();
    error ZeroAddress();
    error CreationIsPaused();
    error CreationNotPaused();
    error TokenNotAllowed();
    error TokenAlreadyAllowed();
    error NotPayer();
    error BadPayee();
    error BadAmountOrFee();
    error BadDeadline();
    error FeeCapTooHigh();
    error OrderRefUsed();
    error TransferFailed();
    error TransferShort();
    error Reentrancy();

    // UC1: none -> Funded
    function createEscrow(Terms calldata t) external returns (address escrow);

    // A1-A7: admin timelock only, one setting each
    function setDefaultArbiter(address arbiter) external;
    function setTreasury(address treasury) external;
    function allowToken(address token) external;
    function disallowToken(address token) external;
    function setFeeCap(uint16 bps) external;
    function pauseCreation() external;
    function unpauseCreation() external;
    // A8, A9: added by open decisions D2(c) and D1(b); new escrows only
    function setBackupArbiter(address backupArbiter) external;
    function setFreezeAdapter(address token, address adapter) external;

    function treasury() external view returns (address);
    function admin() external view returns (address);
    function implementation() external view returns (address);
    function defaultArbiter() external view returns (address);
    function backupArbiter() external view returns (address);
    function feeCap() external view returns (uint16);
    function paused() external view returns (bool);
    function allowed(address token) external view returns (bool);
    function freezeAdapterOf(address token) external view returns (address);
    function isEscrow(address escrow) external view returns (bool);
    function escrowOf(bytes32 orderRef) external view returns (address);
    function predictEscrow(bytes32 orderRef) external view returns (address);
}
