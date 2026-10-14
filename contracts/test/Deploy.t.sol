// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {EscrowFactory} from "../src/EscrowFactory.sol";
import {IEscrowFactory} from "../src/interfaces/IEscrowFactory.sol";
import {MockUSDC} from "./mocks/MockTokens.sol";

contract DeployTest is Test {
    address internal multisig = makeAddr("adminMultisig");
    address internal arbiter = makeAddr("arbiter");
    address internal backup = makeAddr("backup");
    address internal treasury = makeAddr("treasury");
    address internal deployer = makeAddr("deployer");

    function setUp() public {
        // Forge starts at timestamp 1, which TimelockController reserves as its "done" marker;
        // a zero-delay bootstrap scheduled at t=1 would never be ready. Real chains are far past it.
        vm.warp(1_760_000_000);
    }

    function _deploy(address backupArb) internal returns (Deploy.Deployment memory d, MockUSDC usdc) {
        usdc = new MockUSDC();
        Deploy script = new Deploy();
        Deploy.Config memory c = Deploy.Config({
            adminMultisig: multisig,
            arbiter: arbiter,
            backupArbiter: backupArb,
            treasury: treasury,
            token: address(usdc),
            tokenIsUsdt: false,
            feeCapBps: 150,
            timelockDelay: 48 hours,
            create2Prefix: 0xff
        });
        // the script contract acts as the deployer EOA in this test
        d = script.deploy(c, address(script));
        deployer = address(script);
    }

    function test_deploy_finalState() public {
        (Deploy.Deployment memory d, MockUSDC usdc) = _deploy(backup);
        TimelockController tl = d.timelock;
        EscrowFactory f = d.factory;

        assertEq(f.admin(), address(tl));
        assertEq(f.defaultArbiter(), arbiter);
        assertEq(f.backupArbiter(), backup);
        assertEq(f.treasury(), treasury);
        assertEq(f.feeCap(), 150);
        assertTrue(f.allowed(address(usdc)));
        assertEq(f.freezeAdapterOf(address(usdc)), d.freezeAdapter);

        assertEq(tl.getMinDelay(), 48 hours);
        assertFalse(tl.hasRole(tl.PROPOSER_ROLE(), deployer));
        assertFalse(tl.hasRole(tl.EXECUTOR_ROLE(), deployer));
        assertFalse(tl.hasRole(tl.CANCELLER_ROLE(), deployer));
        assertFalse(tl.hasRole(tl.DEFAULT_ADMIN_ROLE(), deployer));
        assertTrue(tl.hasRole(tl.PROPOSER_ROLE(), multisig));
        assertTrue(tl.hasRole(tl.EXECUTOR_ROLE(), multisig));
        assertTrue(tl.hasRole(tl.CANCELLER_ROLE(), multisig));
    }

    function test_deploy_withoutBackupArbiter() public {
        (Deploy.Deployment memory d,) = _deploy(address(0));
        assertEq(d.factory.backupArbiter(), address(0));
        assertEq(d.timelock.getMinDelay(), 48 hours);
    }

    /// After bootstrap, admin changes need the multisig and the full 48h delay.
    function test_adminChange_requires48hDelay() public {
        (Deploy.Deployment memory d,) = _deploy(backup);
        TimelockController tl = d.timelock;
        bytes memory call = abi.encodeCall(EscrowFactory.pauseCreation, ());

        vm.prank(multisig);
        vm.expectRevert(); // below minimum delay
        tl.schedule(address(d.factory), 0, call, 0, 0, 1 hours);

        vm.prank(multisig);
        tl.schedule(address(d.factory), 0, call, 0, 0, 48 hours);

        vm.prank(multisig);
        vm.expectRevert(); // not ready yet
        tl.execute(address(d.factory), 0, call, 0, 0);

        vm.warp(block.timestamp + 48 hours);
        vm.prank(multisig);
        tl.execute(address(d.factory), 0, call, 0, 0);
        assertTrue(d.factory.paused());

        // the multisig itself can't bypass the timelock
        vm.prank(multisig);
        vm.expectRevert(IEscrowFactory.NotAdmin.selector);
        d.factory.unpauseCreation();
    }
}
