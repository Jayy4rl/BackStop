// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Escrow lifecycle. `None` exists only on the implementation and on an
/// address before the factory has initialised it; no clone is ever observed in it.
enum State {
    None,
    Funded,
    Delivered,
    Disputed,
    Released,
    Refunded
}

/// @notice Immutable terms of one protected payment (architecture doc, "Terms").
struct Terms {
    address payer;
    address payee;
    address token;
    uint256 amount;
    uint16 feeBps;
    uint64 deliverBy;
    uint32 holdPeriod;
    bool autoRelease;
    uint32 arbiterTimeout;
    bytes32 orderRef; // also the CREATE2 salt
}

/// @notice Arbiter set and per-token freeze adapter copied from the factory at creation.
/// None of these are chosen by the caller.
struct Roles {
    address arbiter;
    address backupArbiter; // D2(c); address(0) when no backup set is configured
    address freezeAdapter; // D1(b); address(0) when the token has no adapter
}
