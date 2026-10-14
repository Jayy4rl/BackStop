// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseTest} from "./Base.t.sol";
import {Escrow} from "../src/Escrow.sol";
import {EscrowFactory} from "../src/EscrowFactory.sol";
import {IEscrowFactory} from "../src/interfaces/IEscrowFactory.sol";
import {IEscrow} from "../src/interfaces/IEscrow.sol";
import {State, Terms, Roles} from "../src/Types.sol";

contract EscrowFactoryTest is BaseTest {
    // ---------------------------------------------------------------- UC1

    function test_create_happyPath() public {
        Terms memory t = _terms(address(usdc), true);
        _fundAndApprove(address(usdc), payer, t.amount);
        address predicted = factory.predictEscrow(t.orderRef);

        vm.expectEmit(address(factory));
        emit IEscrowFactory.EscrowCreated(predicted, payer, payee, address(usdc), t.amount, t.orderRef, arbiter);
        vm.prank(payer);
        address e = factory.createEscrow(t);

        assertEq(e, predicted);
        assertTrue(factory.isEscrow(e));
        assertEq(factory.escrowOf(t.orderRef), e);
        assertEq(uint8(Escrow(e).state()), uint8(State.Funded));
        assertEq(usdc.balanceOf(e), t.amount);
        assertEq(usdc.balanceOf(payer), 0);
        assertEq(usdc.allowance(payer, address(factory)), 0, "exact approval consumed");
    }

    function _assertCreateGuard(Terms memory t, address caller) internal {
        _fundAndApprove(t.token, t.payer, t.amount);
        address predicted = factory.predictEscrow(t.orderRef);
        uint256 bal = usdc.balanceOf(t.payer);
        vm.prank(caller);
        (bool ok,) = address(factory).call(abi.encodeCall(EscrowFactory.createEscrow, (t)));
        assertFalse(ok);
        assertEq(predicted.code.length, 0);
        assertEq(usdc.balanceOf(t.payer), bal);
    }

    function test_create_guards() public {
        Terms memory t;

        vm.prank(admin);
        factory.pauseCreation();
        _assertCreateGuard(_terms(address(usdc), true), payer);
        vm.prank(admin);
        factory.unpauseCreation();

        t = _terms(address(usdc), true);
        t.token = makeAddr("notAllowed");
        vm.prank(payer);
        vm.expectRevert(IEscrowFactory.TokenNotAllowed.selector);
        factory.createEscrow(t);

        _assertCreateGuard(_terms(address(usdc), true), stranger); // caller is not payer

        t = _terms(address(usdc), true);
        t.payee = address(0);
        _assertCreateGuard(t, payer);

        t = _terms(address(usdc), true);
        t.payee = payer;
        _assertCreateGuard(t, payer);

        t = _terms(address(usdc), true);
        t.amount = 0;
        vm.prank(payer);
        vm.expectRevert(IEscrowFactory.BadAmountOrFee.selector);
        factory.createEscrow(t);

        t = _terms(address(usdc), true);
        t.feeBps = factory.feeCap() + 1;
        _assertCreateGuard(t, payer);

        t = _terms(address(usdc), true);
        t.deliverBy = uint64(block.timestamp); // must be strictly in the future
        _assertCreateGuard(t, payer);
    }

    function test_create_orderRefReuse_reverts() public {
        Terms memory t = _terms(address(usdc), true);
        _create(t);
        _fundAndApprove(address(usdc), payer, t.amount);
        vm.prank(payer);
        vm.expectRevert(IEscrowFactory.OrderRefUsed.selector);
        factory.createEscrow(t);

        // even with different terms (another payer), the same orderRef can't be funded twice
        Terms memory t2 = _terms(address(usdc), true);
        t2.orderRef = t.orderRef;
        t2.payer = stranger;
        _fundAndApprove(address(usdc), stranger, t2.amount);
        vm.prank(stranger);
        vm.expectRevert(IEscrowFactory.OrderRefUsed.selector);
        factory.createEscrow(t2);
    }

    function test_initialize_onlyFactory_onlyOnce() public {
        Escrow e = _createDefault();
        Terms memory t = e.terms();
        Roles memory r = Roles({arbiter: stranger, backupArbiter: address(0), freezeAdapter: address(0)});

        vm.prank(stranger);
        vm.expectRevert(IEscrow.NotFactory.selector);
        e.initialize(t, r);

        vm.prank(address(factory));
        vm.expectRevert(IEscrow.AlreadyInitialized.selector);
        e.initialize(t, r);

        // implementation itself can't be initialised by anyone but the factory
        Escrow impl = Escrow(factory.implementation());
        vm.prank(stranger);
        vm.expectRevert(IEscrow.NotFactory.selector);
        impl.initialize(t, r);
    }

    function test_feeAtCap_allowed_and_lowerCapDoesNotAffectExisting() public {
        Terms memory t = _terms(address(usdc), true);
        t.feeBps = 300;
        Escrow e = _create(t);
        vm.prank(admin);
        factory.setFeeCap(50);
        vm.prank(payee);
        e.markDelivered(0);
        vm.prank(payer);
        e.release();
        assertEq(e.feeOwed(), AMOUNT * 300 / 10_000);
    }

    // ---------------------------------------------------------------- admin

    function test_admin_onlyTimelock() public {
        bytes[9] memory calls = [
            abi.encodeCall(EscrowFactory.setDefaultArbiter, (stranger)),
            abi.encodeCall(EscrowFactory.setTreasury, (stranger)),
            abi.encodeCall(EscrowFactory.allowToken, (stranger)),
            abi.encodeCall(EscrowFactory.disallowToken, (address(usdc))),
            abi.encodeCall(EscrowFactory.setFeeCap, (uint16(10))),
            abi.encodeCall(EscrowFactory.pauseCreation, ()),
            abi.encodeCall(EscrowFactory.unpauseCreation, ()),
            abi.encodeCall(EscrowFactory.setBackupArbiter, (stranger)),
            abi.encodeCall(EscrowFactory.setFreezeAdapter, (address(usdc), stranger))
        ];
        address[4] memory notAdmin = [payer, arbiter, treasury, stranger];
        for (uint256 i; i < calls.length; ++i) {
            for (uint256 j; j < notAdmin.length; ++j) {
                vm.prank(notAdmin[j]);
                (bool ok, bytes memory ret) = address(factory).call(calls[i]);
                assertFalse(ok);
                assertEq(bytes4(ret), IEscrowFactory.NotAdmin.selector);
            }
        }
    }

    function test_admin_guards() public {
        vm.startPrank(admin);
        vm.expectRevert(IEscrowFactory.ZeroAddress.selector);
        factory.setDefaultArbiter(address(0));
        vm.expectRevert(IEscrowFactory.ZeroAddress.selector);
        factory.setTreasury(address(0));
        vm.expectRevert(IEscrowFactory.TokenAlreadyAllowed.selector);
        factory.allowToken(address(usdc));
        vm.expectRevert(IEscrowFactory.TokenNotAllowed.selector);
        factory.disallowToken(stranger);
        vm.expectRevert(IEscrowFactory.FeeCapTooHigh.selector);
        factory.setFeeCap(501);
        factory.setFeeCap(500);
        assertEq(factory.feeCap(), 500);
        vm.expectRevert(IEscrowFactory.CreationNotPaused.selector);
        factory.unpauseCreation();
        factory.pauseCreation();
        vm.expectRevert(IEscrowFactory.CreationIsPaused.selector);
        factory.pauseCreation();
        vm.stopPrank();
    }

    function test_admin_eachWritesOneSetting() public {
        vm.startPrank(admin);
        factory.setDefaultArbiter(stranger);
        assertEq(factory.defaultArbiter(), stranger);
        factory.setTreasury(stranger);
        assertEq(factory.treasury(), stranger);
        factory.disallowToken(address(usdt));
        assertFalse(factory.allowed(address(usdt)));
        factory.allowToken(address(usdt));
        assertTrue(factory.allowed(address(usdt)));
        factory.setFeeCap(42);
        assertEq(factory.feeCap(), 42);
        factory.pauseCreation();
        assertTrue(factory.paused());
        factory.unpauseCreation();
        assertFalse(factory.paused());
        vm.stopPrank();
    }

    function test_pause_existingEscrowsKeepWorking() public {
        Escrow e = _escrowIn(State.Delivered);
        vm.prank(admin);
        factory.pauseCreation();
        vm.prank(payer);
        e.release();
        vm.prank(stranger);
        e.collectFee();
    }

    function test_disallowToken_existingEscrowsUnaffected() public {
        Escrow e = _escrowIn(State.Funded);
        vm.prank(admin);
        factory.disallowToken(address(usdc));
        vm.prank(payee);
        e.refundByPayee();
        assertEq(usdc.balanceOf(payer), AMOUNT);
        Terms memory t = _terms(address(usdc), true);
        _fundAndApprove(address(usdc), payer, t.amount);
        vm.prank(payer);
        vm.expectRevert(IEscrowFactory.TokenNotAllowed.selector);
        factory.createEscrow(t);
    }

    function test_constructor_guards() public {
        vm.expectRevert(IEscrowFactory.ZeroAddress.selector);
        new EscrowFactory(address(0), arbiter, treasury, 100, 0xff);
        vm.expectRevert(IEscrowFactory.ZeroAddress.selector);
        new EscrowFactory(admin, address(0), treasury, 100, 0xff);
        vm.expectRevert(IEscrowFactory.ZeroAddress.selector);
        new EscrowFactory(admin, arbiter, address(0), 100, 0xff);
        vm.expectRevert(IEscrowFactory.FeeCapTooHigh.selector);
        new EscrowFactory(admin, arbiter, treasury, 501, 0xff);
    }

    function test_predict_tvmPrefixDiffers() public {
        EscrowFactory tvm = new EscrowFactory(admin, arbiter, treasury, 100, bytes1(0x41));
        bytes32 ref = keccak256("x");
        assertTrue(tvm.predictEscrow(ref) != address(0));
        assertEq(tvm.create2Prefix(), bytes1(0x41));
    }
}
