// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {State, Terms, Roles} from "../Types.sol";

interface IEscrow {
    event Delivered(bytes32 evidenceHash, uint64 holdUntil);
    event Disputed(address indexed by, bytes32 evidenceHash);
    event Released(uint256 toPayee, uint256 feeOwed, bytes32 rulingHash);
    event Refunded(uint256 toPayer, bytes32 rulingHash);
    event FeeCollected(address treasury, uint256 amount);
    event ExcessReturned(address to, uint256 amount);

    error NotFactory();
    error AlreadyInitialized();
    error NotPayer();
    error NotPayee();
    error NotParty();
    error NotArbiter();
    error WrongState();
    error DeadlinePassed();
    error DeadlineNotPassed();
    error HoldNotOver();
    error HoldOver();
    error AutoReleaseOff();
    error ArbiterTimedOut();
    error ArbiterNotTimedOut();
    error NoFeeOwed();
    error PayeeNotFrozen();
    error NoFreezeAdapter();
    error NoExcess();
    error TransferFailed();
    error TransferShort();
    error Reentrancy();

    function initialize(Terms calldata t, Roles calldata r) external;

    function markDelivered(bytes32 evidenceHash) external; // UC2  payee        Funded -> Delivered
    function release() external; // UC3  payer        Delivered|Disputed -> Released
    function releaseAfterHold() external; // UC4  anyone       Delivered -> Released
    function dispute(bytes32 evidenceHash) external; // UC5  payer|payee  Funded|Delivered -> Disputed
    function resolveRelease(bytes32 rulingHash) external; // UC6  arbiter      Disputed -> Released
    function resolveRefund(bytes32 rulingHash) external; // UC7  arbiter      Disputed -> Refunded
    function refundByPayee() external; // UC8  payee        Funded|Delivered|Disputed -> Refunded
    function reclaimAfterDeadline() external; // UC9  payer        Funded -> Refunded
    function refundAfterArbiterTimeout() external; // UC10 anyone       Disputed -> Refunded
    function collectFee() external; // UC11 anyone       Released: fee owed -> collected
    function refundFrozenPayee() external; // UC12 anyone       Delivered -> Refunded (D1)
    function returnExcess() external; // UC13 anyone       Released|Refunded: excess -> payer (D3)

    function state() external view returns (State);
    function terms() external view returns (Terms memory);
    function roles() external view returns (Roles memory);
    function holdUntil() external view returns (uint64);
    function disputedAt() external view returns (uint64);
    function feeOwed() external view returns (uint256);
    function feeCollected() external view returns (bool);
    function factory() external view returns (address);
}
