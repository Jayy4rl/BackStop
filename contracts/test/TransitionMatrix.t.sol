// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseTest} from "./Base.t.sol";
import {Escrow} from "../src/Escrow.sol";
import {State} from "../src/Types.sol";

/// @notice Test plan item "Transition matrix": for every (state, function) pair, assert the
/// one listed transition, or a revert with state and every balance unchanged.
contract TransitionMatrixTest is BaseTest {
    uint8 internal constant REVERT = 255;
    uint256 internal constant N_FN = 12;

    function _fn(uint256 i) internal pure returns (bytes memory) {
        if (i == 0) return abi.encodeCall(Escrow.markDelivered, (keccak256("ev")));
        if (i == 1) return abi.encodeCall(Escrow.release, ());
        if (i == 2) return abi.encodeCall(Escrow.releaseAfterHold, ());
        if (i == 3) return abi.encodeCall(Escrow.dispute, (keccak256("ev")));
        if (i == 4) return abi.encodeCall(Escrow.resolveRelease, (keccak256("ruling")));
        if (i == 5) return abi.encodeCall(Escrow.resolveRefund, (keccak256("ruling")));
        if (i == 6) return abi.encodeCall(Escrow.refundByPayee, ());
        if (i == 7) return abi.encodeCall(Escrow.reclaimAfterDeadline, ());
        if (i == 8) return abi.encodeCall(Escrow.refundAfterArbiterTimeout, ());
        if (i == 9) return abi.encodeCall(Escrow.collectFee, ());
        if (i == 10) return abi.encodeCall(Escrow.refundFrozenPayee, ());
        return abi.encodeCall(Escrow.returnExcess, ());
    }

    function _caller(uint256 i) internal view returns (address) {
        if (i == 0 || i == 3 || i == 6) return payee;
        if (i == 1 || i == 7) return payer;
        if (i == 4 || i == 5) return arbiter;
        return keeper; // anyone
    }

    /// @dev Puts the world in the state where the function's own time/precondition guard
    /// holds, so only the state guard decides the outcome.
    function _prepare(Escrow e, uint256 i) internal {
        if (i == 2 && e.holdUntil() != 0) vm.warp(e.holdUntil());
        if (i == 7) vm.warp(e.terms().deliverBy + 1);
        if (i == 8) {
            if (e.disputedAt() != 0) vm.warp(uint256(e.disputedAt()) + ARB_TIMEOUT);
            else vm.warp(block.timestamp + ARB_TIMEOUT + 1);
        }
        if (i == 10) usdc.setBlacklisted(payee, true);
        if (i == 11) usdc.mint(address(e), 5e6);
    }

    /// @dev Expected resulting state, or REVERT.
    function _expected(State s, uint256 i) internal pure returns (uint8) {
        if (s == State.Funded) {
            if (i == 0) return uint8(State.Delivered);
            if (i == 3) return uint8(State.Disputed);
            if (i == 6 || i == 7) return uint8(State.Refunded);
            return REVERT;
        }
        if (s == State.Delivered) {
            if (i == 1 || i == 2) return uint8(State.Released);
            if (i == 3) return uint8(State.Disputed);
            if (i == 6 || i == 10) return uint8(State.Refunded);
            return REVERT;
        }
        if (s == State.Disputed) {
            if (i == 1 || i == 4) return uint8(State.Released);
            if (i == 5 || i == 6 || i == 8) return uint8(State.Refunded);
            return REVERT;
        }
        if (s == State.Released) {
            if (i == 9 || i == 11) return uint8(State.Released);
            return REVERT;
        }
        if (s == State.Refunded) {
            if (i == 11) return uint8(State.Refunded);
            return REVERT;
        }
        return REVERT;
    }

    function _runCell(State s, uint256 i) internal {
        Escrow e = _escrowIn(s);
        _prepare(e, i);
        uint8 want = _expected(s, i);
        Snap memory before = _snap(e);
        vm.prank(_caller(i));
        (bool ok,) = address(e).call(_fn(i));
        if (want == REVERT) {
            assertFalse(ok, string.concat("expected revert: state ", vm.toString(uint8(s)), " fn ", vm.toString(i)));
            _assertSame(before, _snap(e));
        } else {
            assertTrue(ok, string.concat("expected success: state ", vm.toString(uint8(s)), " fn ", vm.toString(i)));
            assertEq(uint8(e.state()), want, "wrong resulting state");
            if (i == 9) assertTrue(e.feeCollected());
            if (i == 11) {
                uint256 owed = (e.state() == State.Released && !e.feeCollected()) ? e.feeOwed() : 0;
                assertEq(usdc.balanceOf(address(e)), owed, "excess not returned");
            }
        }
    }

    function test_matrix_Funded() public {
        for (uint256 i; i < N_FN; ++i) {
            uint256 snap = vm.snapshotState();
            _runCell(State.Funded, i);
            vm.revertToState(snap);
        }
    }

    function test_matrix_Delivered() public {
        for (uint256 i; i < N_FN; ++i) {
            uint256 snap = vm.snapshotState();
            _runCell(State.Delivered, i);
            vm.revertToState(snap);
        }
    }

    function test_matrix_Disputed() public {
        for (uint256 i; i < N_FN; ++i) {
            uint256 snap = vm.snapshotState();
            _runCell(State.Disputed, i);
            vm.revertToState(snap);
        }
    }

    function test_matrix_Released() public {
        for (uint256 i; i < N_FN; ++i) {
            uint256 snap = vm.snapshotState();
            _runCell(State.Released, i);
            vm.revertToState(snap);
        }
    }

    function test_matrix_Refunded() public {
        for (uint256 i; i < N_FN; ++i) {
            uint256 snap = vm.snapshotState();
            _runCell(State.Refunded, i);
            vm.revertToState(snap);
        }
    }

    /// @dev State None exists only on the implementation; every function must revert there.
    function test_matrix_None_implementation() public {
        Escrow impl = Escrow(factory.implementation());
        assertEq(uint8(impl.state()), uint8(State.None));
        address[4] memory callers = [payer, payee, arbiter, address(0)];
        for (uint256 i; i < N_FN; ++i) {
            for (uint256 c; c < callers.length; ++c) {
                vm.prank(callers[c]);
                (bool ok,) = address(impl).call(_fn(i));
                assertFalse(ok);
                assertEq(uint8(impl.state()), uint8(State.None));
            }
        }
    }

    /// @dev The P2P shape (autoRelease = false): releaseAfterHold never works and dispute has
    /// no hold window.
    function test_matrix_Delivered_noAutoRelease() public {
        Escrow e = _escrowIn(State.Delivered, address(usdc), false);
        vm.warp(block.timestamp + 365 days);
        _expectNoop(e, keeper, abi.encodeCall(Escrow.releaseAfterHold, ()));
        vm.prank(payee);
        e.dispute(keccak256("late but allowed"));
        assertEq(uint8(e.state()), uint8(State.Disputed));
    }
}
