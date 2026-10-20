// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./StableCoin.sol";

contract StableEngine {
    StableCoin public immutable sUsd;

    uint256 public constant COLLATERAL_RATIO = 150;
    uint256 public constant MIN_HEALTH_FACTOR = 1e18;

    uint256 public mockEthUsdPrice = 2000e18;

    mapping(address => uint256) public collateralDeposited;
    mapping(address => uint256) public sUsdMinted;

    event CollateralDeposited(address indexed user, uint256 amount);
    event StablecoinMinted(address indexed user, uint256 amount);
    event StablecoinBurned(address indexed user, uint256 amount);
    event CollateralWithdrawn(address indexed user, uint256 amount);

    constructor(address _sUsdAddress) {
        sUsd = StableCoin(_sUsdAddress);
    }

    function depositCollateral() external payable {
        require(msg.value > 0, "Needs more than 0");
        collateralDeposited[msg.sender] += msg.value;
        emit CollateralDeposited(msg.sender, msg.value);
    }

    function mintStablecoin(uint256 _sUsdAmount) external {
        require(_sUsdAmount > 0, "Needs more than 0");

        sUsdMinted[msg.sender] += _sUsdAmount;

        // Check whether the position stays safe after the debt is issued
        _revertIfHealthFactorIsBroken(msg.sender);

        sUsd.mint(msg.sender, _sUsdAmount);
        emit StablecoinMinted(msg.sender, _sUsdAmount);
    }

    // Control task 2a: the user returns part of the minted stablecoins, they are burned and
    // the debt goes down by the same amount
    function burnStablecoin(uint256 amount) external {
        require(amount > 0, "Needs more than 0");
        require(sUsdMinted[msg.sender] >= amount, "Burning more than minted");

        sUsdMinted[msg.sender] -= amount;

        // The engine owns the stablecoin, so it burns the user's tokens without an approve
        sUsd.burn(msg.sender, amount);
        emit StablecoinBurned(msg.sender, amount);
    }

    // Control task 2b: the user takes part of the ETH collateral back to the wallet
    function withdrawCollateral(uint256 amount) external {
        require(amount > 0, "Needs more than 0");
        require(collateralDeposited[msg.sender] >= amount, "Insufficient collateral");

        collateralDeposited[msg.sender] -= amount;

        // Less collateral can make the position unsafe: a broken health factor reverts the
        // whole transaction, together with the line above
        _revertIfHealthFactorIsBroken(msg.sender);
        emit CollateralWithdrawn(msg.sender, amount);

        // Checks-effects-interactions: the ETH leaves the contract only after all checks
        // and state changes
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "ETH transfer failed");
    }

    // 3. Market price change (only for the simulation in the lab)
    function setMockOraclePrice(uint256 _newPrice) external {
        mockEthUsdPrice = _newPrice;
    }

    // --- Internal financial math ---

    function getHealthFactor(address user) public view returns (uint256) {
        uint256 debt = sUsdMinted[user];
        if (debt == 0) return type(uint256).max; // If there is no debt, the factor is infinite

        uint256 collateralValueInUsd = getUsdValue(collateralDeposited[user]);

        // Math: (collateral value * 100) / (debt * 150)
        // Multiply by 1e18 to keep the fractional part
        uint256 collateralAdjustedForThreshold = (collateralValueInUsd * 100) / COLLATERAL_RATIO;

        return (collateralAdjustedForThreshold * 1e18) / debt;
    }

    function getUsdValue(uint256 ethAmount) public view returns (uint256) {
        // ethAmount (1e18) * price (1e18) / 1e18 = USD value with 18 zeros
        return (ethAmount * mockEthUsdPrice) / 1e18;
    }

    function _revertIfHealthFactorIsBroken(address user) internal view {
        uint256 userHealthFactor = getHealthFactor(user);
        require(userHealthFactor >= MIN_HEALTH_FACTOR, "Health factor is broken (under 1.0)");
    }
}
