// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseTest} from "./Base.t.sol";
import {Escrow} from "../src/Escrow.sol";
import {State} from "../src/Types.sol";
import {ArcUsdcFreezeAdapter, UsdcFreezeAdapter} from "../src/adapters/FreezeAdapters.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {
    ARC_NATIVE_COIN_CONTROL,
    ARC_SYSTEM_EMITTER,
    MockArcSystemEmitter,
    MockArcUsdc,
    MockNativeCoinControl
} from "./mocks/ArcMocks.sol";

/// Arc: USDC is the native coin; its blocklist is the NativeCoinControl precompile and every
/// movement is also logged from the system emitter in 18 decimals.
contract ArcUsdcTest is BaseTest {
    MockArcUsdc internal arcUsdc;
    MockNativeCoinControl internal control;
    ArcUsdcFreezeAdapter internal arcAdapter;

    event Transfer(address indexed from, address indexed to, uint256 value);

    function setUp() public override {
        super.setUp();
        vm.etch(ARC_NATIVE_COIN_CONTROL, address(new MockNativeCoinControl()).code);
        vm.etch(ARC_SYSTEM_EMITTER, address(new MockArcSystemEmitter()).code);
        control = MockNativeCoinControl(ARC_NATIVE_COIN_CONTROL);
        arcUsdc = new MockArcUsdc();
        arcAdapter = new ArcUsdcFreezeAdapter();
        vm.startPrank(admin);
        factory.allowToken(address(arcUsdc));
        factory.setFreezeAdapter(address(arcUsdc), address(arcAdapter));
        vm.stopPrank();
    }

    function test_adapter_readsTheNativeCoinControlPrecompile() public {
        assertEq(arcAdapter.NATIVE_COIN_CONTROL(), ARC_NATIVE_COIN_CONTROL);
        assertFalse(arcAdapter.isFrozen(address(arcUsdc), payee));
        control.blocklist(payee);
        assertTrue(arcAdapter.isFrozen(address(arcUsdc), payee));
        // The standard USDC adapter only asks the token, so it cannot see Arc's blocklist.
        assertFalse(new UsdcFreezeAdapter().isFrozen(address(arcUsdc), payee));
        control.unBlocklist(payee);
        assertFalse(arcAdapter.isFrozen(address(arcUsdc), payee));
    }

    function test_adapter_fallsBackToTheTokenWithoutThePrecompile() public {
        vm.etch(ARC_NATIVE_COIN_CONTROL, "");
        arcUsdc.setBlacklisted(payee, true);
        assertTrue(arcAdapter.isFrozen(address(arcUsdc), payee));
        assertFalse(arcAdapter.isFrozen(address(arcUsdc), payer));
    }

    /// D1(b) on Arc: payee blocklisted after delivery; releases revert ("Blocked address"),
    /// anyone refunds the payer through the Arc adapter.
    function test_D1_frozenPayee_onArc() public {
        Escrow e = _escrowIn(State.Delivered, address(arcUsdc), true);
        vm.warp(e.holdUntil());
        control.blocklist(payee);
        _expectNoop(e, keeper, abi.encodeCall(Escrow.releaseAfterHold, ()));
        vm.prank(stranger);
        e.refundFrozenPayee();
        assertEq(arcUsdc.balanceOf(payer), AMOUNT);
        assertEq(uint8(e.state()), uint8(State.Refunded));
    }

    function test_mock_logsLikeArc() public {
        arcUsdc.mint(payer, 5e6);
        // ERC-20 transfer: the interface's 6-decimal log, then the 18-decimal system log.
        vm.expectEmit(true, true, false, true, address(arcUsdc));
        emit Transfer(payer, payee, 2e6);
        vm.expectEmit(true, true, false, true, ARC_SYSTEM_EMITTER);
        emit Transfer(payer, payee, 2e18);
        vm.prank(payer);
        arcUsdc.transfer(payee, 2e6);
        // Native send: system log only; the ERC-20 view truncates below 1e-6.
        vm.recordLogs();
        vm.prank(payer);
        arcUsdc.nativeSend(payee, 1.5e18 + 7);
        assertEq(vm.getRecordedLogs().length, 1);
        assertEq(arcUsdc.balanceOf(payee), 3.5e6);
    }

    function test_deploy_requiresTheArcAdapterOnArc() public {
        Deploy script = new Deploy();
        assertEq(uint8(script.tokenKindFor("arc-usdc", 5042)), uint8(Deploy.TokenKind.ArcUsdc));
        assertEq(uint8(script.tokenKindFor("arc-usdc", 5042002)), uint8(Deploy.TokenKind.ArcUsdc));
        assertEq(uint8(script.tokenKindFor("usdc", 8453)), uint8(Deploy.TokenKind.Usdc));
        assertEq(uint8(script.tokenKindFor("usdt", 728126428)), uint8(Deploy.TokenKind.Usdt));
        vm.expectRevert(abi.encodeWithSelector(Deploy.WrongFreezeAdapterForChain.selector, "usdc", 5042));
        script.tokenKindFor("usdc", 5042);
        vm.expectRevert(abi.encodeWithSelector(Deploy.WrongFreezeAdapterForChain.selector, "arc-usdc", 8453));
        script.tokenKindFor("arc-usdc", 8453);
        vm.expectRevert(abi.encodeWithSelector(Deploy.UnknownTokenKind.selector, "dai"));
        script.tokenKindFor("dai", 5042);
    }

    function test_deploy_onArc_wiresTheArcAdapter() public {
        Deploy script = new Deploy();
        Deploy.Config memory c = Deploy.Config({
            adminMultisig: makeAddr("multisig"),
            arbiter: arbiter,
            backupArbiter: address(0),
            treasury: treasury,
            token: address(arcUsdc),
            tokenKind: Deploy.TokenKind.ArcUsdc,
            feeCapBps: 150,
            timelockDelay: 48 hours,
            create2Prefix: 0xff
        });
        Deploy.Deployment memory d = script.deploy(c, address(script));
        assertEq(d.factory.freezeAdapterOf(address(arcUsdc)), d.freezeAdapter);
        control.blocklist(payee);
        assertTrue(ArcUsdcFreezeAdapter(d.freezeAdapter).isFrozen(address(arcUsdc), payee));
    }
}
