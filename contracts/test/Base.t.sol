// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {EscrowFactory} from "../src/EscrowFactory.sol";
import {Escrow} from "../src/Escrow.sol";
import {State, Terms, Roles} from "../src/Types.sol";
import {UsdcFreezeAdapter, UsdtFreezeAdapter} from "../src/adapters/FreezeAdapters.sol";
import {MockUSDC, MockUSDT, MockTokenBase} from "./mocks/MockTokens.sol";

abstract contract BaseTest is Test {
    EscrowFactory internal factory;
    MockUSDC internal usdc;
    MockUSDT internal usdt;

    address internal admin = makeAddr("adminTimelock");
    address internal arbiter = makeAddr("arbiterMultisig");
    address internal backup = makeAddr("backupArbiter");
    address internal treasury = makeAddr("treasury");
    address internal payer = makeAddr("payer");
    address internal payee = makeAddr("payee");
    address internal stranger = makeAddr("stranger");
    address internal keeper = makeAddr("keeper");

    uint256 internal constant AMOUNT = 1_000e6;
    uint16 internal constant FEE_BPS = 100; // 1%
    uint32 internal constant HOLD = 7 days;
    uint32 internal constant ARB_TIMEOUT = 30 days;
    uint64 internal constant DELIVER_WINDOW = 10 days;

    uint256 internal refCounter;

    struct Snap {
        State state;
        uint64 holdUntil;
        uint64 disputedAt;
        uint256 feeOwed;
        bool feeCollected;
        uint256 payerBal;
        uint256 payeeBal;
        uint256 escrowBal;
        uint256 treasuryBal;
    }

    function setUp() public virtual {
        vm.warp(1_760_000_000);
        factory = new EscrowFactory(admin, arbiter, treasury, 300, bytes1(0xff));
        usdc = new MockUSDC();
        usdt = new MockUSDT();
        address usdcAdapter = address(new UsdcFreezeAdapter());
        address usdtAdapter = address(new UsdtFreezeAdapter());
        vm.startPrank(admin);
        factory.allowToken(address(usdc));
        factory.allowToken(address(usdt));
        factory.setBackupArbiter(backup);
        factory.setFreezeAdapter(address(usdc), usdcAdapter);
        factory.setFreezeAdapter(address(usdt), usdtAdapter);
        vm.stopPrank();
    }

    function _nextRef() internal returns (bytes32) {
        return keccak256(abi.encode("order", ++refCounter));
    }

    function _terms(address token, bool autoRelease) internal returns (Terms memory t) {
        t = Terms({
            payer: payer,
            payee: payee,
            token: token,
            amount: AMOUNT,
            feeBps: FEE_BPS,
            deliverBy: uint64(block.timestamp) + DELIVER_WINDOW,
            holdPeriod: autoRelease ? HOLD : 0,
            autoRelease: autoRelease,
            arbiterTimeout: ARB_TIMEOUT,
            orderRef: _nextRef()
        });
    }

    function _fundAndApprove(address token, address who, uint256 amt) internal {
        MockTokenBase(token).mint(who, amt);
        vm.prank(who);
        (bool ok,) = token.call(abi.encodeWithSignature("approve(address,uint256)", address(factory), amt));
        require(ok, "approve");
    }

    function _create(Terms memory t) internal returns (Escrow e) {
        _fundAndApprove(t.token, t.payer, t.amount);
        vm.prank(t.payer);
        e = Escrow(factory.createEscrow(t));
    }

    function _createDefault() internal returns (Escrow) {
        return _create(_terms(address(usdc), true));
    }

    /// @dev Drives a fresh escrow into `s` using the normal happy-path calls.
    function _escrowIn(State s, address token, bool autoRelease) internal returns (Escrow e) {
        e = _create(_terms(token, autoRelease));
        if (s == State.Funded) return e;
        if (s == State.Delivered || s == State.Released) {
            vm.prank(payee);
            e.markDelivered(keccak256("evidence"));
            if (s == State.Released) {
                vm.prank(payer);
                e.release();
            }
            return e;
        }
        if (s == State.Disputed) {
            vm.prank(payee);
            e.markDelivered(keccak256("evidence"));
            vm.prank(payer);
            e.dispute(keccak256("dispute-evidence"));
            return e;
        }
        if (s == State.Refunded) {
            vm.prank(payee);
            e.refundByPayee();
            return e;
        }
        revert("unsupported state");
    }

    function _escrowIn(State s) internal returns (Escrow) {
        return _escrowIn(s, address(usdc), true);
    }

    function _snap(Escrow e) internal view returns (Snap memory s) {
        MockTokenBase tok = MockTokenBase(e.terms().token);
        s.state = e.state();
        s.holdUntil = e.holdUntil();
        s.disputedAt = e.disputedAt();
        s.feeOwed = e.feeOwed();
        s.feeCollected = e.feeCollected();
        s.payerBal = tok.balanceOf(payer);
        s.payeeBal = tok.balanceOf(payee);
        s.escrowBal = tok.balanceOf(address(e));
        s.treasuryBal = tok.balanceOf(factory.treasury());
    }

    function _snapAt(Escrow e, address token) internal view returns (Snap memory s) {
        MockTokenBase tok = MockTokenBase(token);
        s.state = e.state();
        s.holdUntil = e.holdUntil();
        s.disputedAt = e.disputedAt();
        s.feeOwed = e.feeOwed();
        s.feeCollected = e.feeCollected();
        s.payerBal = tok.balanceOf(payer);
        s.payeeBal = tok.balanceOf(payee);
        s.escrowBal = tok.balanceOf(address(e));
        s.treasuryBal = tok.balanceOf(factory.treasury());
    }

    function _assertSame(Snap memory a, Snap memory b) internal pure {
        assertEq(uint8(a.state), uint8(b.state), "state changed");
        assertEq(a.holdUntil, b.holdUntil, "holdUntil changed");
        assertEq(a.disputedAt, b.disputedAt, "disputedAt changed");
        assertEq(a.feeOwed, b.feeOwed, "feeOwed changed");
        assertEq(a.feeCollected, b.feeCollected, "feeCollected changed");
        assertEq(a.payerBal, b.payerBal, "payer balance changed");
        assertEq(a.payeeBal, b.payeeBal, "payee balance changed");
        assertEq(a.escrowBal, b.escrowBal, "escrow balance changed");
        assertEq(a.treasuryBal, b.treasuryBal, "treasury balance changed");
    }

    /// @dev Calls `data` on `e` as `caller` and asserts it reverts with nothing changed.
    function _expectNoop(Escrow e, address caller, bytes memory data) internal {
        Snap memory before = _snap(e);
        vm.prank(caller);
        (bool ok,) = address(e).call(data);
        assertFalse(ok, "call should revert");
        _assertSame(before, _snap(e));
    }
}
