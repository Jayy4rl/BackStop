// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseTest} from "./Base.t.sol";
import {Escrow} from "../src/Escrow.sol";
import {EscrowFactory} from "../src/EscrowFactory.sol";
import {State, Terms} from "../src/Types.sol";
import {
    MockUSDT,
    FalseReturnToken,
    SilentFailToken,
    FeeOnTransferToken,
    ReentrantToken,
    MockTokenBase
} from "./mocks/MockTokens.sol";

/// @notice Test plan items "Hostile tokens" and "Re-entrancy": every hostile behaviour causes a
/// full revert, never a partial payout; re-entrant callbacks revert.
contract HostileTokensTest is BaseTest {
    FalseReturnToken internal falseTok;
    SilentFailToken internal silentTok;
    FeeOnTransferToken internal feeTok;
    ReentrantToken internal reTok;

    function setUp() public override {
        super.setUp();
        falseTok = new FalseReturnToken();
        silentTok = new SilentFailToken();
        feeTok = new FeeOnTransferToken();
        reTok = new ReentrantToken();
        vm.startPrank(admin);
        factory.allowToken(address(falseTok));
        factory.allowToken(address(silentTok));
        factory.allowToken(address(feeTok));
        factory.allowToken(address(reTok));
        vm.stopPrank();
    }

    function _assertCreateFailsCleanly(address token) internal {
        Terms memory t = _terms(token, true);
        _fundAndApprove(token, payer, t.amount);
        address predicted = factory.predictEscrow(t.orderRef);
        uint256 payerBefore = MockTokenBase(token).balanceOf(payer);
        vm.prank(payer);
        (bool ok,) = address(factory).call(abi.encodeCall(EscrowFactory.createEscrow, (t)));
        assertFalse(ok, "create should revert");
        assertEq(predicted.code.length, 0, "escrow must not exist");
        assertEq(factory.escrowOf(t.orderRef), address(0));
        assertFalse(factory.isEscrow(predicted));
        assertEq(MockTokenBase(token).balanceOf(payer), payerBefore, "payer charged");
    }

    // ---------------------------------------------------------------- funding

    function test_create_falseReturn_reverts() public {
        falseTok.setFailing(true);
        _assertCreateFailsCleanly(address(falseTok));
    }

    function test_create_silentFail_reverts() public {
        silentTok.setFailing(true);
        _assertCreateFailsCleanly(address(silentTok));
    }

    function test_create_feeOnTransfer_reverts() public {
        feeTok.setFee(10);
        _assertCreateFailsCleanly(address(feeTok));
    }

    function test_create_frozenPayer_reverts() public {
        usdc.setBlacklisted(payer, true);
        _assertCreateFailsCleanly(address(usdc));
    }

    function test_create_insufficientAllowance_leavesNoEscrow() public {
        Terms memory t = _terms(address(usdc), true);
        usdc.mint(payer, t.amount);
        vm.prank(payer);
        usdc.approve(address(factory), t.amount - 1);
        address predicted = factory.predictEscrow(t.orderRef);
        vm.prank(payer);
        vm.expectRevert();
        factory.createEscrow(t);
        assertEq(predicted.code.length, 0);
    }

    // ---------------------------------------------------------------- payouts

    function _releaseMustFailCleanly(Escrow e, address token) internal {
        Snap memory before = _snapAt(e, token);
        vm.prank(payer);
        (bool ok,) = address(e).call(abi.encodeCall(Escrow.release, ()));
        assertFalse(ok);
        _assertSame(before, _snapAt(e, token));
    }

    function test_payout_falseReturn_fullRevert() public {
        Escrow e = _escrowIn(State.Delivered, address(falseTok), true);
        falseTok.setFailing(true);
        _releaseMustFailCleanly(e, address(falseTok));
        vm.prank(payee);
        (bool ok,) = address(e).call(abi.encodeCall(Escrow.refundByPayee, ()));
        assertFalse(ok);
    }

    function test_payout_silentFail_fullRevert() public {
        Escrow e = _escrowIn(State.Delivered, address(silentTok), true);
        silentTok.setFailing(true);
        _releaseMustFailCleanly(e, address(silentTok));
    }

    function test_payout_feeOnTransfer_fullRevert() public {
        Escrow e = _escrowIn(State.Delivered, address(feeTok), true);
        feeTok.setFee(1);
        _releaseMustFailCleanly(e, address(feeTok));
    }

    function test_collectFee_feeOnTransfer_fullRevert() public {
        Escrow e = _escrowIn(State.Released, address(feeTok), true);
        feeTok.setFee(5);
        Snap memory before = _snapAt(e, address(feeTok));
        vm.prank(stranger);
        (bool ok,) = address(e).call(abi.encodeCall(Escrow.collectFee, ()));
        assertFalse(ok);
        _assertSame(before, _snapAt(e, address(feeTok)));
    }

    /// USDT returns nothing: the escrow must work normally (balance change decides).
    function test_usdtNoReturnValue_fullLifecycle() public {
        Escrow e = _escrowIn(State.Delivered, address(usdt), true);
        vm.prank(payer);
        e.release();
        uint256 fee = AMOUNT * FEE_BPS / 10_000;
        assertEq(usdt.balanceOf(payee), AMOUNT - fee);
        vm.prank(stranger);
        e.collectFee();
        assertEq(usdt.balanceOf(treasury), fee);

        Escrow r = _escrowIn(State.Disputed, address(usdt), true);
        vm.prank(arbiter);
        r.resolveRefund(0);
        assertEq(usdt.balanceOf(payer), AMOUNT);
    }

    // ---------------------------------------------------------------- re-entrancy

    function test_reentrancy_callbackIntoEscrowReverts_outerCompletesOnce() public {
        Escrow e = _escrowIn(State.Delivered, address(reTok), true);
        reTok.arm(address(e), abi.encodeCall(Escrow.collectFee, ()), false);
        vm.prank(payer);
        e.release();
        assertTrue(reTok.callbackAttempted());
        assertTrue(reTok.callbackReverted(), "re-entrant call must revert");
        assertFalse(e.feeCollected());
        assertEq(reTok.balanceOf(payee), AMOUNT - AMOUNT * FEE_BPS / 10_000);
    }

    function test_reentrancy_doubleRefundAttempt() public {
        Escrow e = _escrowIn(State.Disputed, address(reTok), true);
        vm.warp(uint256(e.disputedAt()) + ARB_TIMEOUT);
        reTok.arm(address(e), abi.encodeCall(Escrow.refundAfterArbiterTimeout, ()), false);
        vm.prank(keeper);
        e.refundAfterArbiterTimeout();
        assertTrue(reTok.callbackReverted());
        assertEq(reTok.balanceOf(payer), AMOUNT, "paid exactly once");
        assertEq(reTok.balanceOf(address(e)), 0);
    }

    function test_reentrancy_propagated_fullRevert() public {
        Escrow e = _escrowIn(State.Delivered, address(reTok), true);
        reTok.arm(address(e), abi.encodeCall(Escrow.releaseAfterHold, ()), true);
        Snap memory before = _snapAt(e, address(reTok));
        vm.prank(payer);
        (bool ok,) = address(e).call(abi.encodeCall(Escrow.release, ()));
        assertFalse(ok);
        _assertSame(before, _snapAt(e, address(reTok)));
    }

    function test_reentrancy_intoFactoryDuringFunding() public {
        Terms memory t = _terms(address(reTok), true);
        Terms memory t2 = _terms(address(reTok), true);
        _fundAndApprove(address(reTok), payer, t.amount * 2);
        reTok.arm(address(factory), abi.encodeCall(EscrowFactory.createEscrow, (t2)), false);
        vm.prank(payer);
        factory.createEscrow(t);
        assertTrue(reTok.callbackReverted());
        assertEq(factory.escrowOf(t2.orderRef), address(0));
    }
}
