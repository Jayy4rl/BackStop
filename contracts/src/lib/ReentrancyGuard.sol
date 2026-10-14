// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Storage-based reentrancy lock that works in uninitialised clones
/// (status starts at 0, which counts as "not entered"). No transient storage,
/// so it compiles for the TVM.
abstract contract ReentrancyGuard {
    uint256 private _locked; // 0 or 1 = free, 2 = entered

    error ReentrantCall();

    modifier nonReentrant() {
        if (_locked == 2) revert ReentrantCall();
        _locked = 2;
        _;
        _locked = 1;
    }
}
