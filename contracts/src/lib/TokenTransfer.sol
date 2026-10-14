// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20Minimal {
    function balanceOf(address) external view returns (uint256);
}

/// @notice Token calls that tolerate tokens returning nothing (USDT) and that are always
/// paired with a balance-change check by the caller (design rule 9).
library TokenTransfer {
    error TokenCallFailed();

    function safeTransfer(address token, address to, uint256 value) internal {
        _call(token, abi.encodeWithSelector(0xa9059cbb, to, value));
    }

    function safeTransferFrom(address token, address from, address to, uint256 value) internal {
        _call(token, abi.encodeWithSelector(0x23b872dd, from, to, value));
    }

    function balanceOf(address token, address who) internal view returns (uint256) {
        return IERC20Minimal(token).balanceOf(who);
    }

    /// @dev Reverts if the call reverts, or returns data that is not `true`.
    /// A missing return value is accepted; the balance check decides success.
    function _call(address token, bytes memory data) private {
        (bool ok, bytes memory ret) = token.call(data);
        if (!ok) revert TokenCallFailed();
        if (ret.length != 0) {
            if (ret.length < 32 || abi.decode(ret, (uint256)) != 1) revert TokenCallFailed();
        }
    }
}
