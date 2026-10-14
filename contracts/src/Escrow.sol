// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {State, Terms, Roles} from "./Types.sol";
import {IEscrow} from "./interfaces/IEscrow.sol";
import {IEscrowFactory} from "./interfaces/IEscrowFactory.sol";
import {IFreezeAdapter} from "./interfaces/IFreezeAdapter.sol";
import {ReentrancyGuard} from "./lib/ReentrancyGuard.sol";
import {TokenTransfer} from "./lib/TokenTransfer.sol";

/// @title Escrow
/// @notice One protected payment. Deployed only as an EIP-1167 clone by EscrowFactory.
/// Every external function is one use case and one state transition: guards, then
/// effects (state, then the event), then at most one token transfer verified by the
/// receiver's balance change. A failed transfer reverts the event with everything else.
/// Money leaves only to the payer, the payee, or (the fee only) the factory's treasury.
contract Escrow is IEscrow, ReentrancyGuard {
    /// @dev Embedded in the implementation's code, so every clone shares it.
    address private immutable FACTORY;

    State public state;
    uint64 public holdUntil;
    uint64 public disputedAt;
    bool public feeCollected;
    uint256 public feeOwed;

    Terms private _terms;
    Roles private _roles;

    constructor() {
        FACTORY = msg.sender;
    }

    // ---------------------------------------------------------------- init

    /// @notice Called once by the factory inside createEscrow, before funds are pulled.
    function initialize(Terms calldata t, Roles calldata r) external {
        if (msg.sender != FACTORY) revert NotFactory();
        if (state != State.None) revert AlreadyInitialized();
        _terms = t;
        _roles = r;
        state = State.Funded;
    }

    // ---------------------------------------------------------------- UC2

    function markDelivered(bytes32 evidenceHash) external nonReentrant {
        if (msg.sender != _terms.payee) revert NotPayee();
        if (state != State.Funded) revert WrongState();
        if (block.timestamp > _terms.deliverBy) revert DeadlinePassed();

        uint64 until = uint64(block.timestamp) + _terms.holdPeriod;
        state = State.Delivered;
        holdUntil = until;

        emit Delivered(evidenceHash, until);
    }

    // ---------------------------------------------------------------- UC3

    function release() external nonReentrant {
        if (msg.sender != _terms.payer) revert NotPayer();
        if (state != State.Delivered && state != State.Disputed) revert WrongState();
        _release(bytes32(0));
    }

    // ---------------------------------------------------------------- UC4

    function releaseAfterHold() external nonReentrant {
        if (state != State.Delivered) revert WrongState();
        if (!_terms.autoRelease) revert AutoReleaseOff();
        if (block.timestamp < holdUntil) revert HoldNotOver();
        _release(bytes32(0));
    }

    // ---------------------------------------------------------------- UC5

    function dispute(bytes32 evidenceHash) external nonReentrant {
        bool isPayer = msg.sender == _terms.payer;
        if (!isPayer && msg.sender != _terms.payee) revert NotParty();
        State s = state;
        if (s == State.Funded) {
            // D4(b): the payee may dispute from Funded only while delivery is still possible,
            // so a payee can't block the payer's reclaim after a missed deadline.
            if (!isPayer && block.timestamp > _terms.deliverBy) revert DeadlinePassed();
        } else if (s == State.Delivered) {
            if (_terms.autoRelease && block.timestamp >= holdUntil) revert HoldOver();
        } else {
            revert WrongState();
        }

        state = State.Disputed;
        disputedAt = uint64(block.timestamp);

        emit Disputed(msg.sender, evidenceHash);
    }

    // ---------------------------------------------------------------- UC6

    function resolveRelease(bytes32 rulingHash) external nonReentrant {
        _checkArbiterRuling();
        _release(rulingHash);
    }

    // ---------------------------------------------------------------- UC7

    function resolveRefund(bytes32 rulingHash) external nonReentrant {
        _checkArbiterRuling();
        _refund(rulingHash);
    }

    // ---------------------------------------------------------------- UC8

    function refundByPayee() external nonReentrant {
        if (msg.sender != _terms.payee) revert NotPayee();
        State s = state;
        if (s != State.Funded && s != State.Delivered && s != State.Disputed) revert WrongState();
        _refund(bytes32(0));
    }

    // ---------------------------------------------------------------- UC9

    function reclaimAfterDeadline() external nonReentrant {
        if (msg.sender != _terms.payer) revert NotPayer();
        if (state != State.Funded) revert WrongState();
        if (block.timestamp <= _terms.deliverBy) revert DeadlineNotPassed();
        _refund(bytes32(0));
    }

    // ---------------------------------------------------------------- UC10

    function refundAfterArbiterTimeout() external nonReentrant {
        if (state != State.Disputed) revert WrongState();
        if (block.timestamp < uint256(disputedAt) + _terms.arbiterTimeout) revert ArbiterNotTimedOut();
        _refund(bytes32(0));
    }

    // ---------------------------------------------------------------- UC11

    function collectFee() external nonReentrant {
        if (state != State.Released) revert WrongState();
        if (feeOwed == 0 || feeCollected) revert NoFeeOwed();

        uint256 fee = feeOwed;
        address treasury = IEscrowFactory(FACTORY).treasury();
        feeCollected = true;

        emit FeeCollected(treasury, fee);
        _payout(treasury, fee);
    }

    // ---------------------------------------------------------------- UC12 (D1)

    /// @notice If the issuer has frozen the payee after delivery, releases can only revert,
    /// so anyone may return the money to the payer.
    function refundFrozenPayee() external nonReentrant {
        if (state != State.Delivered) revert WrongState();
        address adapter = _roles.freezeAdapter;
        if (adapter == address(0)) revert NoFreezeAdapter();
        if (!IFreezeAdapter(adapter).isFrozen(_terms.token, _terms.payee)) revert PayeeNotFrozen();
        _refund(bytes32(0));
    }

    // ---------------------------------------------------------------- UC13 (D3)

    /// @notice Sends any untracked balance (tokens sent directly to this address) to the payer
    /// once the escrow is terminal. Never touches an uncollected fee.
    function returnExcess() external nonReentrant {
        State s = state;
        if (s != State.Released && s != State.Refunded) revert WrongState();
        uint256 owed = (s == State.Released && !feeCollected) ? feeOwed : 0;
        uint256 bal = TokenTransfer.balanceOf(_terms.token, address(this));
        if (bal <= owed) revert NoExcess();
        uint256 excess = bal - owed;

        emit ExcessReturned(_terms.payer, excess);
        _payout(_terms.payer, excess);
    }

    // ---------------------------------------------------------------- views

    function terms() external view returns (Terms memory) {
        return _terms;
    }

    function roles() external view returns (Roles memory) {
        return _roles;
    }

    function factory() external view returns (address) {
        return FACTORY;
    }

    // ---------------------------------------------------------------- internal

    function _checkArbiterRuling() private view {
        address a = _roles.arbiter;
        address b = _roles.backupArbiter;
        if (msg.sender != a && (b == address(0) || msg.sender != b)) revert NotArbiter();
        if (state != State.Disputed) revert WrongState();
        if (block.timestamp >= uint256(disputedAt) + _terms.arbiterTimeout) revert ArbiterTimedOut();
    }

    /// @dev Effects then one transfer: payee receives amount - fee, fee stays until collectFee.
    function _release(bytes32 rulingHash) private {
        uint256 amount = _terms.amount;
        uint256 fee = amount * _terms.feeBps / 10_000;
        state = State.Released;
        feeOwed = fee;

        emit Released(amount - fee, fee, rulingHash);
        _payout(_terms.payee, amount - fee);
    }

    /// @dev Refunds never carry a fee (decision D5(a)).
    function _refund(bytes32 rulingHash) private {
        uint256 amount = _terms.amount;
        state = State.Refunded;

        emit Refunded(amount, rulingHash);
        _payout(_terms.payer, amount);
    }

    function _payout(address to, uint256 value) private {
        address token = _terms.token;
        uint256 before = TokenTransfer.balanceOf(token, to);
        TokenTransfer.safeTransfer(token, to, value);
        if (TokenTransfer.balanceOf(token, to) - before != value) revert TransferShort();
    }
}
