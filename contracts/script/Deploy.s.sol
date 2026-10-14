// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {EscrowFactory} from "../src/EscrowFactory.sol";
import {UsdcFreezeAdapter, UsdtFreezeAdapter} from "../src/adapters/FreezeAdapters.sol";

/// @notice Deploys the admin timelock and the EscrowFactory for one chain.
///
/// Bootstrap: the timelock starts with a zero delay and the deployer as proposer/executor, so the
/// initial factory settings (token allowlist, freeze adapter, backup arbiter) can be applied through
/// it in one batch. The same batch raises the delay to its final value (48h by default) and revokes
/// every deployer role, leaving the admin multisig as sole proposer/executor/canceller.
/// The factory's admin is the timelock from construction and can never change.
///
/// Env:
///   ADMIN_MULTISIG   proposer/executor/canceller of the timelock (required)
///   ARBITER          default arbiter multisig (required)
///   BACKUP_ARBITER   backup arbiter set, D2(c) (optional, 0 = none)
///   TREASURY         fee treasury (required)
///   TOKEN            stablecoin to allowlist (required): USDC on Base/Arc, USDT on TRON
///   TOKEN_KIND       "usdc" or "usdt" — selects the freeze adapter (D1(b))
///   FEE_CAP_BPS      fee cap for new escrows (default 150)
///   TIMELOCK_DELAY   seconds (default 172800 = 48h)
///   CREATE2_PREFIX   0xff on EVM (default), 0x41 on the TVM
contract Deploy is Script {
    struct Config {
        address adminMultisig;
        address arbiter;
        address backupArbiter;
        address treasury;
        address token;
        bool tokenIsUsdt;
        uint16 feeCapBps;
        uint256 timelockDelay;
        bytes1 create2Prefix;
    }

    struct Deployment {
        TimelockController timelock;
        EscrowFactory factory;
        address freezeAdapter;
    }

    function run() external returns (Deployment memory d) {
        Config memory c = Config({
            adminMultisig: vm.envAddress("ADMIN_MULTISIG"),
            arbiter: vm.envAddress("ARBITER"),
            backupArbiter: vm.envOr("BACKUP_ARBITER", address(0)),
            treasury: vm.envAddress("TREASURY"),
            token: vm.envAddress("TOKEN"),
            tokenIsUsdt: keccak256(bytes(vm.envOr("TOKEN_KIND", string("usdc")))) == keccak256("usdt"),
            feeCapBps: uint16(vm.envOr("FEE_CAP_BPS", uint256(150))),
            timelockDelay: vm.envOr("TIMELOCK_DELAY", uint256(48 hours)),
            create2Prefix: bytes1(uint8(vm.envOr("CREATE2_PREFIX", uint256(0xff))))
        });
        vm.startBroadcast();
        d = deploy(c, msg.sender);
        vm.stopBroadcast();
        console2.log("timelock      ", address(d.timelock));
        console2.log("factory       ", address(d.factory));
        console2.log("implementation", d.factory.implementation());
        console2.log("freezeAdapter ", d.freezeAdapter);
    }

    function deploy(Config memory c, address deployer) public returns (Deployment memory d) {
        address[] memory proposers = new address[](2);
        proposers[0] = deployer;
        proposers[1] = c.adminMultisig;
        d.timelock = new TimelockController(0, proposers, proposers, address(0));
        d.factory = new EscrowFactory(address(d.timelock), c.arbiter, c.treasury, c.feeCapBps, c.create2Prefix);
        d.freezeAdapter = c.tokenIsUsdt ? address(new UsdtFreezeAdapter()) : address(new UsdcFreezeAdapter());

        uint256 n = c.backupArbiter == address(0) ? 6 : 7;
        address[] memory targets = new address[](n);
        uint256[] memory values = new uint256[](n);
        bytes[] memory data = new bytes[](n);
        uint256 i;
        (targets[i], data[i++]) = (address(d.factory), abi.encodeCall(EscrowFactory.allowToken, (c.token)));
        (targets[i], data[i++]) =
            (address(d.factory), abi.encodeCall(EscrowFactory.setFreezeAdapter, (c.token, d.freezeAdapter)));
        if (c.backupArbiter != address(0)) {
            (targets[i], data[i++]) =
                (address(d.factory), abi.encodeCall(EscrowFactory.setBackupArbiter, (c.backupArbiter)));
        }
        TimelockController tl = d.timelock;
        (targets[i], data[i++]) = (address(tl), abi.encodeCall(TimelockController.updateDelay, (c.timelockDelay)));
        (targets[i], data[i++]) = (address(tl), abi.encodeCall(tl.revokeRole, (tl.PROPOSER_ROLE(), deployer)));
        (targets[i], data[i++]) = (address(tl), abi.encodeCall(tl.revokeRole, (tl.EXECUTOR_ROLE(), deployer)));
        (targets[i], data[i++]) = (address(tl), abi.encodeCall(tl.revokeRole, (tl.CANCELLER_ROLE(), deployer)));

        bytes32 salt = keccak256("backstop-bootstrap");
        tl.scheduleBatch(targets, values, data, bytes32(0), salt, 0);
        tl.executeBatch(targets, values, data, bytes32(0), salt);
    }
}
