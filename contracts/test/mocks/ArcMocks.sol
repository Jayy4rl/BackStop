// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MockTokenBase} from "./MockTokens.sol";

// Arc system addresses (docs.arc.io "USDC system events"; arc-node crates/precompiles).
address constant ARC_SYSTEM_EMITTER = 0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE;
address constant ARC_NATIVE_COIN_CONTROL = 0x1800000000000000000000000000000000000001;

/// @notice Stand-in for Arc's NativeCoinControl precompile (same interface and events). Tests
/// place its runtime code at ARC_NATIVE_COIN_CONTROL.
contract MockNativeCoinControl {
    mapping(address => bool) public isBlocklisted;

    event Blocklisted(address indexed account);
    event UnBlocklisted(address indexed account);

    function blocklist(address account) external returns (bool) {
        isBlocklisted[account] = true;
        emit Blocklisted(account);
        return true;
    }

    function unBlocklist(address account) external returns (bool) {
        isBlocklisted[account] = false;
        emit UnBlocklisted(account);
        return true;
    }
}

/// @notice Stand-in for Arc's system log emitter: every USDC movement is logged from
/// ARC_SYSTEM_EMITTER as a standard Transfer, in 18 decimals. Tests place its code there.
contract MockArcSystemEmitter {
    event Transfer(address indexed from, address indexed to, uint256 value);

    function log(address from, address to, uint256 value) external {
        emit Transfer(from, to, value);
    }
}

/// @notice Arc USDC: the 6-decimal ERC-20 interface to the native coin. A transfer emits the
/// interface's own Transfer and the 18-decimal system log; a mint or a native send emits only the
/// system log. The blocklist is the NativeCoinControl precompile ("Blocked address").
contract MockArcUsdc is MockTokenBase {
    uint256 internal constant NATIVE_SCALE = 1e12;

    constructor() MockTokenBase("USDC", "USDC") {}

    function approve(address s, uint256 v) external returns (bool) {
        _approve(s, v);
        return true;
    }

    function transfer(address to, uint256 v) external returns (bool) {
        _move(msg.sender, to, v);
        return true;
    }

    function transferFrom(address from, address to, uint256 v) external returns (bool) {
        _spend(from, v);
        _move(from, to, v);
        return true;
    }

    function mint(address to, uint256 v) external override {
        balanceOf[to] += v;
        totalSupply += v;
        _systemLog(address(0), to, v * NATIVE_SCALE);
    }

    /// @notice A plain native-coin send (18 decimals). The ERC-20 view truncates below 1e-6 USDC.
    function nativeSend(address to, uint256 value18) external {
        _checkBlocklist(msg.sender, to);
        uint256 v = value18 / NATIVE_SCALE;
        require(balanceOf[msg.sender] >= v, "balance");
        balanceOf[msg.sender] -= v;
        balanceOf[to] += v;
        _systemLog(msg.sender, to, value18);
    }

    function _move(address from, address to, uint256 v) internal override {
        _checkBlocklist(from, to);
        super._move(from, to, v);
        _systemLog(from, to, v * NATIVE_SCALE);
    }

    function _checkBlocklist(address from, address to) internal view {
        if (ARC_NATIVE_COIN_CONTROL.code.length == 0) return;
        MockNativeCoinControl c = MockNativeCoinControl(ARC_NATIVE_COIN_CONTROL);
        require(!c.isBlocklisted(from) && !c.isBlocklisted(to), "Blocked address");
    }

    function _systemLog(address from, address to, uint256 value) internal {
        if (ARC_SYSTEM_EMITTER.code.length > 0) MockArcSystemEmitter(ARC_SYSTEM_EMITTER).log(from, to, value);
    }
}
