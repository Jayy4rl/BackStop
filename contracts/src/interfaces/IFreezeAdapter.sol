// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Reports whether the token's issuer has frozen an account. USDC and USDT expose
/// their freeze lists differently, so each token gets a small adapter (decision D1(b)).
interface IFreezeAdapter {
    function isFrozen(address token, address account) external view returns (bool);
}
