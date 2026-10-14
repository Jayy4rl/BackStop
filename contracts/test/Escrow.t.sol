// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseTest} from "./Base.t.sol";
import {Escrow} from "../src/Escrow.sol";
import {IEscrow} from "../src/interfaces/IEscrow.sol";
import {State, Terms} from "../src/Types.sol";

contract EscrowTest is BaseTest {
    // ------------------------------------------------------------ happy paths and amounts

    function test_release_paysPayeeLessFee_feeStaysUntilCollected() public {
        Escrow e = _escrowIn(State.Delivered);
        uint256 fee = AMOUNT * FEE_BPS / 10_000;

        vm.expectEmit(address(e));
        emit IEscrow.Released(AMOUNT - fee, fee, bytes32(0));
        vm.prank(payer);
        e.release();

        assertEq(usdc.balanceOf(payee), AMOUNT - fee);
        assertEq(usdc.balanceOf(address(e)), fee);
        assertEq(e.feeOwed(), fee);
        assertFalse(e.feeCollected());

        vm.expectEmit(address(e));
        emit IEscrow.FeeCollected(treasury, fee);
        vm.prank(stranger);
        e.collectFee();
        assertEq(usdc.balanceOf(treasury), fee);
        assertEq(usdc.balanceOf(address(e)), 0);
        assertTrue(e.feeCollected());

        // collectFee only once
        _expectNoop(e, stranger, abi.encodeCall(Escrow.collectFee, ()));
    }

    function test_markDelivered_setsHoldUntil_andEmits() public {
        Escrow e = _createDefault();
        uint64 expectedHold = uint64(block.timestamp) + HOLD;
        vm.expectEmit(address(e));
        emit IEscrow.Delivered(keccak256("ev"), expectedHold);
        vm.prank(payee);
        e.markDelivered(keccak256("ev"));
        assertEq(e.holdUntil(), expectedHold);
        assertEq(uint8(e.state()), uint8(State.Delivered));
    }

    function test_releaseAfterHold_byAnyone() public {
        Escrow e = _escrowIn(State.Delivered);
        vm.warp(e.holdUntil());
        vm.prank(stranger);
        e.releaseAfterHold();
        assertEq(uint8(e.state()), uint8(State.Released));
        assertEq(usdc.balanceOf(payee), AMOUNT - AMOUNT * FEE_BPS / 10_000);
    }

    function test_refunds_returnFullAmount_noFee() public {
        Escrow e = _escrowIn(State.Disputed);
        vm.expectEmit(address(e));
        emit IEscrow.Refunded(AMOUNT, keccak256("ruling"));
        vm.prank(arbiter);
        e.resolveRefund(keccak256("ruling"));
        assertEq(usdc.balanceOf(payer), AMOUNT);
        assertEq(e.feeOwed(), 0);
        _expectNoop(e, stranger, abi.encodeCall(Escrow.collectFee, ()));
    }

    function test_resolveRelease_carriesRulingHash() public {
        Escrow e = _escrowIn(State.Disputed);
        uint256 fee = AMOUNT * FEE_BPS / 10_000;
        vm.expectEmit(address(e));
        emit IEscrow.Released(AMOUNT - fee, fee, keccak256("ruling"));
        vm.prank(arbiter);
        e.resolveRelease(keccak256("ruling"));
    }

    function test_dispute_recordsTime_andEmits() public {
        Escrow e = _escrowIn(State.Delivered);
        vm.warp(block.timestamp + 1 hours);
        vm.expectEmit(address(e));
        emit IEscrow.Disputed(payer, keccak256("why"));
        vm.prank(payer);
        e.dispute(keccak256("why"));
        assertEq(e.disputedAt(), uint64(block.timestamp));
    }

    function test_zeroFee_releaseLeavesNothing() public {
        Terms memory t = _terms(address(usdc), true);
        t.feeBps = 0;
        Escrow e = _create(t);
        vm.prank(payee);
        e.markDelivered(0);
        vm.prank(payer);
        e.release();
        assertEq(usdc.balanceOf(payee), AMOUNT);
        _expectNoop(e, stranger, abi.encodeCall(Escrow.collectFee, ()));
    }

    function testFuzz_feeMath(uint96 amount, uint16 bps) public {
        amount = uint96(bound(amount, 1, 1e15));
        bps = uint16(bound(bps, 0, 300));
        Terms memory t = _terms(address(usdc), true);
        t.amount = amount;
        t.feeBps = bps;
        Escrow e = _create(t);
        vm.prank(payee);
        e.markDelivered(0);
        vm.prank(payer);
        e.release();
        uint256 fee = uint256(amount) * bps / 10_000;
        assertEq(e.feeOwed(), fee);
        assertEq(usdc.balanceOf(payee) + usdc.balanceOf(address(e)), amount);
    }

    // ------------------------------------------------------------ guard failures: callers

    function test_guards_wrongCallers() public {
        Escrow f = _escrowIn(State.Funded);
        _expectNoop(f, stranger, abi.encodeCall(Escrow.markDelivered, (0)));
        _expectNoop(f, payer, abi.encodeCall(Escrow.markDelivered, (0)));
        _expectNoop(f, stranger, abi.encodeCall(Escrow.dispute, (0)));
        _expectNoop(f, arbiter, abi.encodeCall(Escrow.dispute, (0)));
        _expectNoop(f, stranger, abi.encodeCall(Escrow.refundByPayee, ()));
        _expectNoop(f, payer, abi.encodeCall(Escrow.refundByPayee, ()));
        vm.warp(f.terms().deliverBy + 1);
        _expectNoop(f, stranger, abi.encodeCall(Escrow.reclaimAfterDeadline, ()));
        _expectNoop(f, payee, abi.encodeCall(Escrow.reclaimAfterDeadline, ()));

        Escrow d = _escrowIn(State.Delivered);
        _expectNoop(d, payee, abi.encodeCall(Escrow.release, ()));
        _expectNoop(d, stranger, abi.encodeCall(Escrow.release, ()));
        _expectNoop(d, arbiter, abi.encodeCall(Escrow.release, ()));

        Escrow x = _escrowIn(State.Disputed);
        _expectNoop(x, payer, abi.encodeCall(Escrow.resolveRefund, (0)));
        _expectNoop(x, payee, abi.encodeCall(Escrow.resolveRelease, (0)));
        _expectNoop(x, stranger, abi.encodeCall(Escrow.resolveRelease, (0)));
        _expectNoop(x, admin, abi.encodeCall(Escrow.resolveRefund, (0)));
    }

    function test_guard_releaseAfterHold_autoReleaseOff() public {
        Escrow e = _escrowIn(State.Delivered, address(usdc), false);
        vm.warp(block.timestamp + 365 days);
        _expectNoop(e, stranger, abi.encodeCall(Escrow.releaseAfterHold, ()));
    }

    function test_guard_refundFrozenPayee_requiresFrozen() public {
        Escrow e = _escrowIn(State.Delivered);
        _expectNoop(e, stranger, abi.encodeCall(Escrow.refundFrozenPayee, ()));
    }

    function test_guard_returnExcess_requiresExcess() public {
        Escrow e = _escrowIn(State.Released);
        _expectNoop(e, stranger, abi.encodeCall(Escrow.returnExcess, ()));
    }

    // ------------------------------------------------------------ time boundaries

    function test_boundary_deliverBy() public {
        Escrow e = _escrowIn(State.Funded);
        uint64 deadline = e.terms().deliverBy;
        uint256 s = vm.snapshotState();

        vm.warp(deadline); // exactly deliverBy: deliver ok, reclaim not
        _expectNoop(e, payer, abi.encodeCall(Escrow.reclaimAfterDeadline, ()));
        vm.prank(payee);
        e.markDelivered(0);
        vm.revertToState(s);

        vm.warp(uint256(deadline) + 1); // one second later: reclaim ok, deliver not
        _expectNoop(e, payee, abi.encodeCall(Escrow.markDelivered, (0)));
        vm.prank(payer);
        e.reclaimAfterDeadline();
        assertEq(usdc.balanceOf(payer), AMOUNT);
    }

    function test_boundary_holdUntil() public {
        Escrow e = _escrowIn(State.Delivered);
        uint64 h = e.holdUntil();
        uint256 s = vm.snapshotState();

        vm.warp(uint256(h) - 1); // dispute ok, auto-release not
        _expectNoop(e, keeper, abi.encodeCall(Escrow.releaseAfterHold, ()));
        vm.prank(payer);
        e.dispute(0);
        vm.revertToState(s);

        vm.warp(h); // exactly holdUntil: auto-release ok, dispute closed
        _expectNoop(e, payer, abi.encodeCall(Escrow.dispute, (0)));
        _expectNoop(e, payee, abi.encodeCall(Escrow.dispute, (0)));
        vm.prank(keeper);
        e.releaseAfterHold();
    }

    function test_boundary_arbiterTimeout() public {
        Escrow e = _escrowIn(State.Disputed);
        uint256 t = uint256(e.disputedAt()) + ARB_TIMEOUT;
        uint256 s = vm.snapshotState();

        vm.warp(t - 1); // arbiter may rule, timeout refund not yet
        _expectNoop(e, keeper, abi.encodeCall(Escrow.refundAfterArbiterTimeout, ()));
        vm.prank(arbiter);
        e.resolveRelease(0);
        vm.revertToState(s);

        vm.warp(t - 1);
        vm.prank(arbiter);
        e.resolveRefund(0);
        vm.revertToState(s);

        vm.warp(t); // exactly at timeout: arbiter locked out, anyone refunds
        _expectNoop(e, arbiter, abi.encodeCall(Escrow.resolveRelease, (0)));
        _expectNoop(e, arbiter, abi.encodeCall(Escrow.resolveRefund, (0)));
        vm.prank(keeper);
        e.refundAfterArbiterTimeout();
        assertEq(usdc.balanceOf(payer), AMOUNT);
    }

    // ------------------------------------------------------------ same-block races

    function test_race_releaseVsDispute_bothOrders() public {
        Escrow e = _escrowIn(State.Delivered);
        uint256 s = vm.snapshotState();

        vm.prank(payer);
        e.release();
        _expectNoop(e, payee, abi.encodeCall(Escrow.dispute, (0)));
        assertEq(uint8(e.state()), uint8(State.Released));
        vm.revertToState(s);

        vm.prank(payee);
        e.dispute(0);
        // payer's release is still valid from Disputed (UC3), so the dispute does not block it;
        // what matters is that exactly one terminal outcome results.
        vm.prank(payer);
        e.release();
        assertEq(uint8(e.state()), uint8(State.Released));
        _expectNoop(e, arbiter, abi.encodeCall(Escrow.resolveRefund, (0)));
    }

    function test_race_resolveVsTimeout_bothOrders() public {
        Escrow e = _escrowIn(State.Disputed);
        vm.warp(uint256(e.disputedAt()) + ARB_TIMEOUT - 1);
        uint256 s = vm.snapshotState();

        vm.prank(arbiter);
        e.resolveRelease(0);
        _expectNoop(e, keeper, abi.encodeCall(Escrow.refundAfterArbiterTimeout, ()));
        vm.revertToState(s);

        vm.prank(arbiter);
        e.resolveRefund(0);
        _expectNoop(e, arbiter, abi.encodeCall(Escrow.resolveRelease, (0)));
    }

    function test_race_refundByPayeeVsRelease_bothOrders() public {
        Escrow e = _escrowIn(State.Delivered);
        uint256 s = vm.snapshotState();

        vm.prank(payee);
        e.refundByPayee();
        _expectNoop(e, payer, abi.encodeCall(Escrow.release, ()));
        vm.revertToState(s);

        vm.prank(payer);
        e.release();
        _expectNoop(e, payee, abi.encodeCall(Escrow.refundByPayee, ()));
    }

    function test_race_twoKeepersReleaseAfterHold() public {
        Escrow e = _escrowIn(State.Delivered);
        vm.warp(e.holdUntil());
        vm.prank(keeper);
        e.releaseAfterHold();
        _expectNoop(e, stranger, abi.encodeCall(Escrow.releaseAfterHold, ()));
    }

    // ------------------------------------------------------------ open decisions

    /// D4(b): payee may dispute from Funded only while now <= deliverBy; the payer may still.
    function test_D4_payeeCannotDisputeAfterMissedDeadline() public {
        Escrow e = _escrowIn(State.Funded);
        vm.warp(e.terms().deliverBy + 1);
        _expectNoop(e, payee, abi.encodeCall(Escrow.dispute, (0)));
        vm.prank(payer);
        e.reclaimAfterDeadline();
        assertEq(usdc.balanceOf(payer), AMOUNT);
    }

    function test_D4_payeeMayDisputeFundedBeforeDeadline() public {
        Escrow e = _escrowIn(State.Funded);
        vm.warp(e.terms().deliverBy);
        vm.prank(payee);
        e.dispute(0);
        assertEq(uint8(e.state()), uint8(State.Disputed));
    }

    /// D1(b): payee frozen after the hold ends — releases revert, anyone refunds the payer.
    function test_D1_frozenPayee_USDC() public {
        Escrow e = _escrowIn(State.Delivered);
        vm.warp(e.holdUntil());
        usdc.setBlacklisted(payee, true);
        _expectNoop(e, keeper, abi.encodeCall(Escrow.releaseAfterHold, ()));
        _expectNoop(e, payer, abi.encodeCall(Escrow.release, ()));
        vm.prank(stranger);
        e.refundFrozenPayee();
        assertEq(usdc.balanceOf(payer), AMOUNT);
        assertEq(uint8(e.state()), uint8(State.Refunded));
    }

    function test_D1_frozenPayee_USDT() public {
        Escrow e = _escrowIn(State.Delivered, address(usdt), true);
        usdt.setBlacklisted(payee, true);
        vm.prank(stranger);
        e.refundFrozenPayee();
        assertEq(usdt.balanceOf(payer), AMOUNT);
    }

    function test_D1_noAdapter_noRefund() public {
        vm.prank(admin);
        factory.setFreezeAdapter(address(usdc), address(0));
        Escrow e = _escrowIn(State.Delivered);
        usdc.setBlacklisted(payee, true);
        _expectNoop(e, stranger, abi.encodeCall(Escrow.refundFrozenPayee, ()));
    }

    /// D2(c): the backup arbiter set can rule before the timeout.
    function test_D2_backupArbiterCanRule() public {
        Escrow e = _escrowIn(State.Disputed);
        vm.prank(backup);
        e.resolveRelease(keccak256("backup ruling"));
        assertEq(uint8(e.state()), uint8(State.Released));
    }

    function test_D2_backupArbiterRemovedForNewEscrowsOnly() public {
        Escrow before = _escrowIn(State.Disputed);
        vm.prank(admin);
        factory.setBackupArbiter(address(0));
        Escrow afterE = _escrowIn(State.Disputed);
        _expectNoop(afterE, backup, abi.encodeCall(Escrow.resolveRefund, (0)));
        vm.prank(backup);
        before.resolveRefund(0);
    }

    /// D3(b): stray tokens are returned to the payer only after a terminal state, never the fee.
    function test_D3_returnExcess_keepsUncollectedFee() public {
        Escrow e = _escrowIn(State.Delivered);
        usdc.mint(address(e), 7e6);
        _expectNoop(e, stranger, abi.encodeCall(Escrow.returnExcess, ()));
        vm.prank(payer);
        e.release();
        uint256 fee = e.feeOwed();
        uint256 payerBefore = usdc.balanceOf(payer);
        vm.prank(stranger);
        e.returnExcess();
        assertEq(usdc.balanceOf(payer) - payerBefore, 7e6);
        assertEq(usdc.balanceOf(address(e)), fee);
        vm.prank(stranger);
        e.collectFee();
        assertEq(usdc.balanceOf(treasury), fee);
    }

    /// D6(a) / A2: changing the treasury redirects uncollected fees of existing escrows.
    function test_D6_treasuryRedirect_reachesExistingEscrowFee() public {
        Escrow e = _escrowIn(State.Released);
        address newTreasury = makeAddr("newTreasury");
        usdc.setBlacklisted(treasury, true); // issuer freezes the old treasury
        _expectNoop(e, stranger, abi.encodeCall(Escrow.collectFee, ()));
        vm.prank(admin);
        factory.setTreasury(newTreasury);
        vm.prank(stranger);
        e.collectFee();
        assertEq(usdc.balanceOf(newTreasury), e.feeOwed());
    }

    /// A frozen treasury never blocks a payee (fees are pulled, not pushed).
    function test_frozenTreasury_doesNotBlockRelease() public {
        usdc.setBlacklisted(treasury, true);
        Escrow e = _escrowIn(State.Delivered);
        vm.prank(payer);
        e.release();
        assertEq(uint8(e.state()), uint8(State.Released));
    }

    /// A1: existing escrows keep their arbiter.
    function test_arbiterChange_onlyNewEscrows() public {
        Escrow old = _escrowIn(State.Disputed);
        address newArb = makeAddr("newArbiter");
        vm.prank(admin);
        factory.setDefaultArbiter(newArb);
        _expectNoop(old, newArb, abi.encodeCall(Escrow.resolveRelease, (0)));
        vm.prank(arbiter);
        old.resolveRelease(0);
        Escrow fresh = _escrowIn(State.Disputed);
        assertEq(fresh.roles().arbiter, newArb);
    }

    /// Payee frozen: release reverts cleanly with nothing changed (atomicity holds).
    function test_frozenPayee_releaseRevertsCleanly() public {
        Escrow e = _escrowIn(State.Delivered);
        usdc.setBlacklisted(payee, true);
        _expectNoop(e, payer, abi.encodeCall(Escrow.release, ()));
    }

    function test_terms_immutable_and_rolesFromFactory() public {
        Terms memory t = _terms(address(usdc), true);
        Escrow e = _create(t);
        Terms memory got = e.terms();
        assertEq(keccak256(abi.encode(got)), keccak256(abi.encode(t)));
        assertEq(e.roles().arbiter, arbiter);
        assertEq(e.roles().backupArbiter, backup);
        assertEq(e.factory(), address(factory));
    }
}
