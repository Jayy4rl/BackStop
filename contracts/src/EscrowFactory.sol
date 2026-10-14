// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Terms, Roles} from "./Types.sol";
import {Escrow} from "./Escrow.sol";
import {IEscrowFactory} from "./interfaces/IEscrowFactory.sol";
import {Clones} from "./lib/Clones.sol";
import {ReentrancyGuard} from "./lib/ReentrancyGuard.sol";
import {TokenTransfer} from "./lib/TokenTransfer.sol";

/// @title EscrowFactory
/// @notice Creates and funds one Escrow clone per protected payment (UC1) and holds the
/// settings for future escrows. Admin functions are restricted to the admin timelock and
/// cannot reach an existing escrow's funds or terms; the treasury (A2) is the one setting
/// existing escrows read, and only for their uncollected fee.
contract EscrowFactory is IEscrowFactory, ReentrancyGuard {
    /// @notice Hardcoded ceiling for the fee cap (architecture doc A5): 5%.
    uint16 public constant MAX_FEE_CAP = 500;

    address public immutable admin;
    address public immutable implementation;
    /// @dev CREATE2 address prefix: 0xff on EVM chains, 0x41 on the TVM.
    bytes1 public immutable create2Prefix;

    address public defaultArbiter;
    address public backupArbiter;
    address public treasury;
    uint16 public feeCap;
    bool public paused;

    mapping(address => bool) public allowed;
    mapping(address => address) public freezeAdapterOf;
    mapping(address => bool) public isEscrow;
    mapping(bytes32 => address) public escrowOf;

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    constructor(address admin_, address arbiter_, address treasury_, uint16 feeCap_, bytes1 create2Prefix_) {
        if (admin_ == address(0) || arbiter_ == address(0) || treasury_ == address(0)) revert ZeroAddress();
        if (feeCap_ > MAX_FEE_CAP) revert FeeCapTooHigh();
        admin = admin_;
        defaultArbiter = arbiter_;
        treasury = treasury_;
        feeCap = feeCap_;
        create2Prefix = create2Prefix_;
        implementation = address(new Escrow());
    }

    // ---------------------------------------------------------------- UC1

    function createEscrow(Terms calldata t) external nonReentrant returns (address e) {
        // Guards
        if (paused) revert CreationIsPaused();
        if (!allowed[t.token]) revert TokenNotAllowed();
        if (msg.sender != t.payer) revert NotPayer();
        if (t.payee == address(0) || t.payee == t.payer) revert BadPayee();
        if (t.amount == 0 || t.feeBps > feeCap) revert BadAmountOrFee();
        if (t.deliverBy <= block.timestamp) revert BadDeadline();
        if (escrowOf[t.orderRef] != address(0)) revert OrderRefUsed();

        // Effects: deploy and initialise. CREATE2 also fails on a reused orderRef.
        address arbiter = defaultArbiter;
        e = Clones.cloneDeterministic(implementation, t.orderRef);
        isEscrow[e] = true;
        escrowOf[t.orderRef] = e;
        Escrow(e).initialize(t, Roles({arbiter: arbiter, backupArbiter: backupArbiter, freezeAdapter: freezeAdapterOf[t.token]}));

        // Interaction: pull funds, verified by balance change. A failure reverts the
        // deployment as well, so no unfunded escrow can exist.
        uint256 before = TokenTransfer.balanceOf(t.token, e);
        TokenTransfer.safeTransferFrom(t.token, msg.sender, e, t.amount); // msg.sender == t.payer
        if (TokenTransfer.balanceOf(t.token, e) - before != t.amount) revert TransferShort();

        emit EscrowCreated(e, t.payer, t.payee, t.token, t.amount, t.orderRef, arbiter);
    }

    // ---------------------------------------------------------------- admin (A1-A9)

    function setDefaultArbiter(address arbiter_) external onlyAdmin {
        if (arbiter_ == address(0)) revert ZeroAddress();
        defaultArbiter = arbiter_;
        emit DefaultArbiterSet(arbiter_);
    }

    function setTreasury(address treasury_) external onlyAdmin {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasurySet(treasury_);
    }

    function allowToken(address token) external onlyAdmin {
        if (allowed[token]) revert TokenAlreadyAllowed();
        if (token == address(0)) revert ZeroAddress();
        allowed[token] = true;
        emit TokenAllowed(token);
    }

    function disallowToken(address token) external onlyAdmin {
        if (!allowed[token]) revert TokenNotAllowed();
        allowed[token] = false;
        emit TokenDisallowed(token);
    }

    function setFeeCap(uint16 bps) external onlyAdmin {
        if (bps > MAX_FEE_CAP) revert FeeCapTooHigh();
        feeCap = bps;
        emit FeeCapSet(bps);
    }

    function pauseCreation() external onlyAdmin {
        if (paused) revert CreationIsPaused();
        paused = true;
        emit CreationPaused();
    }

    function unpauseCreation() external onlyAdmin {
        if (!paused) revert CreationNotPaused();
        paused = false;
        emit CreationUnpaused();
    }

    /// @notice A8 (D2(c)): backup arbiter set copied into escrows created afterwards.
    /// address(0) disables the backup for new escrows.
    function setBackupArbiter(address backupArbiter_) external onlyAdmin {
        backupArbiter = backupArbiter_;
        emit BackupArbiterSet(backupArbiter_);
    }

    /// @notice A9 (D1(b)): freeze adapter copied into new escrows of `token`.
    /// address(0) disables UC12 for new escrows of that token.
    function setFreezeAdapter(address token, address adapter) external onlyAdmin {
        freezeAdapterOf[token] = adapter;
        emit FreezeAdapterSet(token, adapter);
    }

    // ---------------------------------------------------------------- views

    function predictEscrow(bytes32 orderRef) external view returns (address) {
        return Clones.predict(create2Prefix, implementation, orderRef, address(this));
    }
}
