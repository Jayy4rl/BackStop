// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice EIP-1167 minimal proxy deployment with CREATE2.
/// Bytecode layout is the canonical EIP-1167 runtime (same as OpenZeppelin's Clones).
library Clones {
    error CloneFailed();

    /// @dev Deploys a clone of `implementation` at a deterministic address. Reverts if
    /// the address is already in use (i.e. the salt was used before by this deployer).
    function cloneDeterministic(address implementation, bytes32 salt) internal returns (address instance) {
        assembly ("memory-safe") {
            mstore(0x00, or(shr(0xe8, shl(0x60, implementation)), 0x3d602d80600a3d3981f3363d3d373d3d3d363d73000000))
            mstore(0x20, or(shl(0x78, implementation), 0x5af43d82803e903d91602b57fd5bf3))
            instance := create2(0, 0x09, 0x37, salt)
        }
        if (instance == address(0)) revert CloneFailed();
    }

    /// @dev keccak256 of the 55-byte clone creation code for `implementation`.
    function initCodeHash(address implementation) internal pure returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                hex"3d602d80600a3d3981f3363d3d373d3d3d363d73", implementation, hex"5af43d82803e903d91602b57fd5bf3"
            )
        );
    }

    /// @dev CREATE2 address. `prefix` is 0xff on EVM chains and 0x41 on the TVM.
    function predict(bytes1 prefix, address implementation, bytes32 salt, address deployer)
        internal
        pure
        returns (address)
    {
        return address(
            uint160(uint256(keccak256(abi.encodePacked(prefix, deployer, salt, initCodeHash(implementation)))))
        );
    }
}
