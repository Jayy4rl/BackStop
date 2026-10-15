// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IFreezeAdapter} from "../interfaces/IFreezeAdapter.sol";

/// @notice USDC (FiatTokenV2): `isBlacklisted(address) returns (bool)`.
contract UsdcFreezeAdapter is IFreezeAdapter {
    function isFrozen(address token, address account) external view returns (bool) {
        (bool ok, bytes memory ret) =
            token.staticcall(abi.encodeWithSignature("isBlacklisted(address)", account));
        return ok && ret.length >= 32 && abi.decode(ret, (bool));
    }
}

/// @notice USDT (TetherToken, incl. TRC-20 USDT): public mapping `isBlackListed(address)`;
/// falls back to `getBlackListStatus(address)` which older deployments also expose.
/// Verify against the deployed TRON contract in the Nile spike.
contract UsdtFreezeAdapter is IFreezeAdapter {
    function isFrozen(address token, address account) external view returns (bool) {
        (bool ok, bytes memory ret) =
            token.staticcall(abi.encodeWithSignature("isBlackListed(address)", account));
        if (ok && ret.length >= 32) return abi.decode(ret, (bool));
        (ok, ret) = token.staticcall(abi.encodeWithSignature("getBlackListStatus(address)", account));
        return ok && ret.length >= 32 && abi.decode(ret, (bool));
    }
}

/// @notice USDC on Arc. USDC is Arc's native coin and its blocklist lives in the NativeCoinControl
/// precompile (`isBlocklisted(address)`, arc-node crates/precompiles/src/native_coin_control.rs),
/// not on the ERC-20 interface at 0x3600…, so the standard USDC adapter would always answer
/// "not frozen" there. Falls back to the token's own `isBlacklisted` if the precompile does not answer.
contract ArcUsdcFreezeAdapter is IFreezeAdapter {
    address public constant NATIVE_COIN_CONTROL = 0x1800000000000000000000000000000000000001;

    function isFrozen(address token, address account) external view returns (bool) {
        (bool ok, bytes memory ret) =
            NATIVE_COIN_CONTROL.staticcall(abi.encodeWithSignature("isBlocklisted(address)", account));
        if (ok && ret.length >= 32) return abi.decode(ret, (bool));
        (ok, ret) = token.staticcall(abi.encodeWithSignature("isBlacklisted(address)", account));
        return ok && ret.length >= 32 && abi.decode(ret, (bool));
    }
}
