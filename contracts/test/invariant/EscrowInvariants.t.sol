// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {EscrowFactory} from "../../src/EscrowFactory.sol";
import {Escrow} from "../../src/Escrow.sol";
import {State, Terms} from "../../src/Types.sol";
import {UsdcFreezeAdapter} from "../../src/adapters/FreezeAdapters.sol";
import {MockUSDC} from "../mocks/MockTokens.sol";

/// @notice Drives random sequences of calls by payers, payees, arbiters and strangers with
/// random time jumps, stray deposits, issuer freezes and treasury changes.
contract Handler is Test {
    EscrowFactory public factory;
    MockUSDC public token;
    address public admin;
    address public arbiter;
    address public backup;
    address[] public actors; // payers 0-2, payees 3-5, arbiter 6, backup 7, stranger 8
    address[] public treasuries;

    Escrow[] public escrows;
    mapping(address => bytes32) public termsHash;
    mapping(address => uint256) public totalIn;
    bytes32[] public usedRefs;

    // ghost violation flags (must stay false)
    bool public terminalChanged; // I5
    bool public wrongTransitionCount; // I7
    bool public arbiterViolation; // I8
    bool public duplicateOrderRef; // I9

    uint256 public calls;
    uint256 public successes;

    constructor(EscrowFactory f, MockUSDC t, address admin_, address arb_, address backup_, address t0, address t1) {
        factory = f;
        token = t;
        admin = admin_;
        arbiter = arb_;
        backup = backup_;
        treasuries.push(t0);
        treasuries.push(t1);
        for (uint256 i; i < 3; ++i) actors.push(makeAddr(string.concat("payer", vm.toString(i))));
        for (uint256 i; i < 3; ++i) actors.push(makeAddr(string.concat("payee", vm.toString(i))));
        actors.push(arb_);
        actors.push(backup_);
        actors.push(makeAddr("stranger"));
    }

    function escrowCount() external view returns (uint256) {
        return escrows.length;
    }

    function treasuryCount() external view returns (uint256) {
        return treasuries.length;
    }

    function create(
        uint256 payerSeed,
        uint256 payeeSeed,
        uint256 amount,
        uint16 feeBps,
        uint32 window,
        uint32 hold,
        bool autoRelease,
        uint32 timeout,
        uint256 refSeed
    ) external {
        address p = actors[payerSeed % 3];
        address q = actors[3 + payeeSeed % 3];
        amount = bound(amount, 1, 1e13);
        bytes32 ref = (usedRefs.length > 0 && refSeed % 5 == 0)
            ? usedRefs[refSeed % usedRefs.length] // try to reuse
            : keccak256(abi.encode(refSeed, usedRefs.length, block.timestamp));
        Terms memory t = Terms({
            payer: p,
            payee: q,
            token: address(token),
            amount: amount,
            feeBps: uint16(bound(feeBps, 0, factory.feeCap())),
            deliverBy: uint64(block.timestamp + bound(window, 1, 30 days)),
            holdPeriod: uint32(bound(hold, 0, 30 days)),
            autoRelease: autoRelease,
            arbiterTimeout: uint32(bound(timeout, 1, 60 days)),
            orderRef: ref
        });
        token.mint(p, amount);
        vm.prank(p);
        token.approve(address(factory), amount);
        bool existed = factory.escrowOf(ref) != address(0);
        vm.prank(p);
        try factory.createEscrow(t) returns (address e) {
            if (existed) duplicateOrderRef = true;
            escrows.push(Escrow(e));
            termsHash[e] = keccak256(abi.encode(t));
            totalIn[e] = amount;
            usedRefs.push(ref);
        } catch {}
        vm.prank(p);
        token.approve(address(factory), 0);
    }

    // act is exposed three times so the fuzzer spends most calls on escrow functions
    function act(uint256 escrowSeed, uint256 fnSeed, uint256 actorSeed, bytes32 data) external {
        _act(escrowSeed, fnSeed, actorSeed, data);
    }

    function act2(uint256 escrowSeed, uint256 fnSeed, uint256 actorSeed, bytes32 data) external {
        _act(escrowSeed, fnSeed, actorSeed, data);
    }

    function act3(uint256 escrowSeed, uint256 fnSeed, uint256 actorSeed, bytes32 data) external {
        _act(escrowSeed, fnSeed, actorSeed, data);
    }

    function _act(uint256 escrowSeed, uint256 fnSeed, uint256 actorSeed, bytes32 data) internal {
        if (escrows.length == 0) return;
        Escrow e = escrows[escrowSeed % escrows.length];
        uint256 fn = _pickFn(e.state(), fnSeed);
        address who;
        if (actorSeed % 4 == 0) {
            // any actor at all, including wrong roles
            who = actors[(actorSeed >> 8) % actors.length];
        } else {
            // the role the function expects, so the machine actually moves
            Terms memory t = e.terms();
            bool alt = (actorSeed >> 8) % 2 == 0;
            if (fn == 1 || fn == 7) who = t.payer;
            else if (fn == 0 || fn == 6) who = t.payee;
            else if (fn == 3) who = alt ? t.payer : t.payee;
            else if (fn == 4 || fn == 5) who = alt ? arbiter : backup;
            else who = actors[8]; // stranger for "anyone" functions
        }
        bytes memory cd;
        if (fn == 0) cd = abi.encodeCall(Escrow.markDelivered, (data));
        else if (fn == 1) cd = abi.encodeCall(Escrow.release, ());
        else if (fn == 2) cd = abi.encodeCall(Escrow.releaseAfterHold, ());
        else if (fn == 3) cd = abi.encodeCall(Escrow.dispute, (data));
        else if (fn == 4) cd = abi.encodeCall(Escrow.resolveRelease, (data));
        else if (fn == 5) cd = abi.encodeCall(Escrow.resolveRefund, (data));
        else if (fn == 6) cd = abi.encodeCall(Escrow.refundByPayee, ());
        else if (fn == 7) cd = abi.encodeCall(Escrow.reclaimAfterDeadline, ());
        else if (fn == 8) cd = abi.encodeCall(Escrow.refundAfterArbiterTimeout, ());
        else if (fn == 9) cd = abi.encodeCall(Escrow.collectFee, ());
        else if (fn == 10) cd = abi.encodeCall(Escrow.refundFrozenPayee, ());
        else cd = abi.encodeCall(Escrow.returnExcess, ());

        State pre = e.state();
        calls++;
        vm.prank(who);
        (bool ok,) = address(e).call(cd);
        if (!ok) return;
        successes++;
        State post = e.state();

        bool preTerminal = pre == State.Released || pre == State.Refunded;
        bool stateless = fn == 9 || fn == 11; // collectFee / returnExcess
        if (preTerminal && post != pre) terminalChanged = true;
        if (stateless ? post != pre : post == pre) wrongTransitionCount = true;
        if ((fn == 4 || fn == 5) && ((who != arbiter && who != backup) || pre != State.Disputed)) {
            arbiterViolation = true;
        }
    }

    /// @dev 3 in 4: a function with a source state matching the escrow; otherwise any of 12.
    function _pickFn(State s, uint256 seed) internal pure returns (uint256) {
        if (seed % 4 == 0) return (seed >> 8) % 12;
        uint256 r = seed >> 16;
        if (s == State.Funded) return [uint256(0), 3, 6, 7][r % 4];
        if (s == State.Delivered) return [uint256(1), 2, 3, 6, 10][r % 5];
        if (s == State.Disputed) return [uint256(1), 4, 5, 6, 8][r % 5];
        if (s == State.Released) return [uint256(9), 11][r % 2];
        return 11;
    }

    function warp(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 0, 20 days));
    }

    function stray(uint256 escrowSeed, uint256 amt) external {
        if (escrows.length == 0) return;
        Escrow e = escrows[escrowSeed % escrows.length];
        amt = bound(amt, 1, 1e9);
        token.mint(address(e), amt);
        totalIn[address(e)] += amt;
    }

    function freeze(uint256 actorSeed, bool on) external {
        token.setBlacklisted(actors[actorSeed % 6], on);
    }

    function switchTreasury(uint256 seed) external {
        vm.prank(admin);
        factory.setTreasury(treasuries[seed % 2]);
    }
}

/// forge-config: default.invariant.depth = 200
/// forge-config: ci.invariant.depth = 400
contract EscrowInvariantsTest is StdInvariant, Test {
    Handler internal h;
    EscrowFactory internal factory;
    MockUSDC internal token;

    function setUp() public {
        vm.warp(1_760_000_000);
        address admin = makeAddr("admin");
        address arbiter = makeAddr("arbiter");
        address backup = makeAddr("backup");
        address t0 = makeAddr("treasury0");
        address t1 = makeAddr("treasury1");
        factory = new EscrowFactory(admin, arbiter, t0, 500, 0xff);
        token = new MockUSDC();
        vm.startPrank(admin);
        factory.allowToken(address(token));
        factory.setBackupArbiter(backup);
        factory.setFreezeAdapter(address(token), address(new UsdcFreezeAdapter()));
        vm.stopPrank();
        h = new Handler(factory, token, admin, arbiter, backup, t0, t1);
        targetContract(address(h));
    }

    function _treasuryOut(address e) internal view returns (uint256 sum) {
        for (uint256 i; i < h.treasuryCount(); ++i) sum += token.outflow(e, h.treasuries(i));
    }

    /// Coverage tally: how many escrows were created and how many escrow calls succeeded.
    function afterInvariant() public view {
        uint256[6] memory byState;
        for (uint256 i; i < h.escrowCount(); ++i) byState[uint8(h.escrows(i).state())]++;
        console2.log("escrows", h.escrowCount(), "calls ok", h.successes());
        console2.log("funded/delivered/disputed", byState[1], byState[2], byState[3]);
        console2.log("released/refunded", byState[4], byState[5]);
    }

    /// I1: while Funded, Delivered or Disputed, balance >= amount.
    function invariant_I1_activeEscrowsFullyBacked() public view {
        for (uint256 i; i < h.escrowCount(); ++i) {
            Escrow e = h.escrows(i);
            State s = e.state();
            if (s == State.Funded || s == State.Delivered || s == State.Disputed) {
                assertGe(token.balanceOf(address(e)), e.terms().amount);
            }
        }
    }

    /// I2: Refunded -> payer got amount, payee nothing. Released -> payee got amount - feeOwed;
    /// the escrow holds feeOwed until collected, after which the treasury got exactly feeOwed.
    function invariant_I2_outcomesPaidCorrectly() public view {
        for (uint256 i; i < h.escrowCount(); ++i) {
            Escrow e = h.escrows(i);
            Terms memory t = e.terms();
            State s = e.state();
            if (s == State.Refunded) {
                assertGe(token.outflow(address(e), t.payer), t.amount);
                assertEq(token.outflow(address(e), t.payee), 0);
            } else if (s == State.Released) {
                assertEq(token.outflow(address(e), t.payee), t.amount - e.feeOwed());
                if (e.feeCollected()) assertEq(_treasuryOut(address(e)), e.feeOwed());
                else assertGe(token.balanceOf(address(e)), e.feeOwed());
            } else {
                assertEq(token.outflow(address(e), t.payee), 0);
            }
        }
    }

    /// I3: tokens leave only to payer, payee or treasury; treasury gets at most feeOwed, once.
    function invariant_I3_onlyThreeExits() public view {
        for (uint256 i; i < h.escrowCount(); ++i) {
            Escrow e = h.escrows(i);
            Terms memory t = e.terms();
            uint256 out = token.outflow(address(e), t.payer) + token.outflow(address(e), t.payee) + _treasuryOut(address(e));
            assertEq(token.balanceOf(address(e)) + out, h.totalIn(address(e)), "tokens left to an unknown address");
            assertLe(_treasuryOut(address(e)), e.feeOwed());
        }
    }

    /// I4: feeOwed <= amount * feeBps / 10_000, and zero in Refunded.
    function invariant_I4_feeBounded() public view {
        for (uint256 i; i < h.escrowCount(); ++i) {
            Escrow e = h.escrows(i);
            Terms memory t = e.terms();
            assertLe(e.feeOwed(), t.amount * t.feeBps / 10_000);
            if (e.state() == State.Refunded) assertEq(e.feeOwed(), 0);
        }
    }

    /// I5: Released and Refunded are terminal.
    function invariant_I5_terminalStates() public view {
        assertFalse(h.terminalChanged());
    }

    /// I6: terms never change after creation.
    function invariant_I6_termsImmutable() public view {
        for (uint256 i; i < h.escrowCount(); ++i) {
            Escrow e = h.escrows(i);
            assertEq(keccak256(abi.encode(e.terms())), h.termsHash(address(e)));
        }
    }

    /// I7: each successful call changes state exactly once (collectFee / returnExcess: never).
    function invariant_I7_oneTransitionPerCall() public view {
        assertFalse(h.wrongTransitionCount());
    }

    /// I8: only the stored arbiter (or backup set) rules, and only in Disputed.
    function invariant_I8_arbiterLimited() public view {
        assertFalse(h.arbiterViolation());
    }

    /// I9: at most one escrow per orderRef.
    function invariant_I9_oneEscrowPerOrderRef() public view {
        assertFalse(h.duplicateOrderRef());
        for (uint256 i; i < h.escrowCount(); ++i) {
            Escrow e = h.escrows(i);
            assertEq(factory.escrowOf(e.terms().orderRef), address(e));
        }
    }
}
