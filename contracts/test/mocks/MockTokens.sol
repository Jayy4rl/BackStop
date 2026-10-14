// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Base mock: balances, allowances, an issuer blacklist (USDC-style
/// `isBlacklisted`), and a ledger of every outflow for invariant I3.
abstract contract MockTokenBase {
    string public name;
    string public symbol;
    uint8 public constant decimals = 6;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public isBlacklisted;
    mapping(address => mapping(address => uint256)) public outflow; // from => to => total

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory n, string memory s) {
        name = n;
        symbol = s;
    }

    function mint(address to, uint256 v) external {
        balanceOf[to] += v;
        totalSupply += v;
        emit Transfer(address(0), to, v);
    }

    function setBlacklisted(address who, bool b) external {
        isBlacklisted[who] = b;
    }

    function _approve(address spender, uint256 v) internal {
        allowance[msg.sender][spender] = v;
        emit Approval(msg.sender, spender, v);
    }

    function _move(address from, address to, uint256 v) internal virtual {
        require(!isBlacklisted[from] && !isBlacklisted[to], "blacklisted");
        require(balanceOf[from] >= v, "balance");
        balanceOf[from] -= v;
        balanceOf[to] += v;
        outflow[from][to] += v;
        emit Transfer(from, to, v);
    }

    function _spend(address from, uint256 v) internal {
        uint256 a = allowance[from][msg.sender];
        require(a >= v, "allowance");
        if (a != type(uint256).max) allowance[from][msg.sender] = a - v;
    }
}

/// @notice Standard ERC-20 returning bool (USDC-like). Reverts for blacklisted addresses.
contract MockUSDC is MockTokenBase {
    constructor() MockTokenBase("USD Coin", "USDC") {}

    function approve(address s, uint256 v) external returns (bool) {
        _approve(s, v);
        return true;
    }

    function transfer(address to, uint256 v) external returns (bool) {
        _move(msg.sender, to, v);
        return true;
    }

    function transferFrom(address from, address to, uint256 v) external returns (bool) {
        _spend(from, v);
        _move(from, to, v);
        return true;
    }
}

/// @notice USDT-like: transfer/transferFrom return nothing; blacklist via `isBlackListed`.
contract MockUSDT is MockTokenBase {
    constructor() MockTokenBase("Tether USD", "USDT") {}

    function isBlackListed(address who) external view returns (bool) {
        return isBlacklisted[who];
    }

    function approve(address s, uint256 v) external {
        _approve(s, v);
    }

    function transfer(address to, uint256 v) external {
        _move(msg.sender, to, v);
    }

    function transferFrom(address from, address to, uint256 v) external {
        _spend(from, v);
        _move(from, to, v);
    }
}

/// @notice Returns false instead of reverting, and moves nothing, when `failing` is set.
contract FalseReturnToken is MockTokenBase {
    bool public failing;

    constructor() MockTokenBase("False", "FALSE") {}

    function setFailing(bool f) external {
        failing = f;
    }

    function approve(address s, uint256 v) external returns (bool) {
        _approve(s, v);
        return true;
    }

    function transfer(address to, uint256 v) external returns (bool) {
        if (failing) return false;
        _move(msg.sender, to, v);
        return true;
    }

    function transferFrom(address from, address to, uint256 v) external returns (bool) {
        if (failing) return false;
        _spend(from, v);
        _move(from, to, v);
        return true;
    }
}

/// @notice Returns nothing and silently moves nothing when `failing` is set.
contract SilentFailToken is MockTokenBase {
    bool public failing;

    constructor() MockTokenBase("Silent", "SILENT") {}

    function setFailing(bool f) external {
        failing = f;
    }

    function approve(address s, uint256 v) external {
        _approve(s, v);
    }

    function transfer(address to, uint256 v) external {
        if (!failing) _move(msg.sender, to, v);
    }

    function transferFrom(address from, address to, uint256 v) external {
        if (!failing) {
            _spend(from, v);
            _move(from, to, v);
        }
    }
}

/// @notice Charges a transfer fee (in bps) burned from the received amount, like USDT's
/// dormant fee switch.
contract FeeOnTransferToken is MockTokenBase {
    uint256 public feeBps;

    constructor() MockTokenBase("Fee", "FEE") {}

    function setFee(uint256 bps) external {
        feeBps = bps;
    }

    function approve(address s, uint256 v) external returns (bool) {
        _approve(s, v);
        return true;
    }

    function transfer(address to, uint256 v) external returns (bool) {
        _moveWithFee(msg.sender, to, v);
        return true;
    }

    function transferFrom(address from, address to, uint256 v) external returns (bool) {
        _spend(from, v);
        _moveWithFee(from, to, v);
        return true;
    }

    function _moveWithFee(address from, address to, uint256 v) internal {
        _move(from, to, v);
        uint256 fee = v * feeBps / 10_000;
        balanceOf[to] -= fee;
        totalSupply -= fee;
    }
}

/// @notice Calls back into a target during transfer (re-entrancy test). Records whether the
/// callback reverted; if `propagate` is set, a reverted callback reverts the transfer too.
contract ReentrantToken is MockTokenBase {
    address public target;
    bytes public callbackData;
    bool public propagate;
    bool public callbackAttempted;
    bool public callbackReverted;

    constructor() MockTokenBase("Reenter", "REENTER") {}

    function arm(address t, bytes calldata data, bool prop) external {
        target = t;
        callbackData = data;
        propagate = prop;
        callbackAttempted = false;
        callbackReverted = false;
    }

    function approve(address s, uint256 v) external returns (bool) {
        _approve(s, v);
        return true;
    }

    function transfer(address to, uint256 v) external returns (bool) {
        _move(msg.sender, to, v);
        _callback();
        return true;
    }

    function transferFrom(address from, address to, uint256 v) external returns (bool) {
        _spend(from, v);
        _move(from, to, v);
        _callback();
        return true;
    }

    function _callback() internal {
        if (target == address(0) || callbackAttempted) return;
        callbackAttempted = true;
        (bool ok, bytes memory ret) = target.call(callbackData);
        if (!ok) {
            callbackReverted = true;
            if (propagate) {
                assembly {
                    revert(add(ret, 0x20), mload(ret))
                }
            }
        }
    }
}
