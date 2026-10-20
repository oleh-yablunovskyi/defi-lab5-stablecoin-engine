import { expect } from "chai";
import { network } from "hardhat";

const { ethers, networkHelpers } = await network.create();
const { parseEther } = ethers;

// 2 ETH at 2000 USD are worth 4000 USD, so the largest debt is 4000 * 100 / 150 USD,
// rounded down to 1 wei like in getHealthFactor
const MAX_DEBT = 2666666666666666666666n;
const HEALTH_FACTOR_BROKEN = "Health factor is broken (under 1.0)";

// The deploy order of scripts/deploy.ts: the coin, the engine, then the engine becomes the owner
async function deployFixture() {
  const [admin, borrower] = await ethers.getSigners();
  const coin = await ethers.deployContract("StableCoin", ["StudentUSD", "sUSD", admin.address]);
  const adminEngine = await ethers.deployContract("StableEngine", [await coin.getAddress()]);
  await coin.transferOwnership(await adminEngine.getAddress());
  return { admin, borrower, coin, adminEngine, engine: adminEngine.connect(borrower) };
}

// The borrower has deposited 2 ETH and minted the maximum, so the health factor is exactly 1.0
async function maxDebtFixture() {
  const deployed = await deployFixture();
  await deployed.engine.depositCollateral({ value: parseEther("2") });
  await deployed.engine.mintStablecoin(MAX_DEBT);
  return deployed;
}

describe("StableCoin", function () {
  it("belongs to the engine, so the deployer can no longer mint or burn", async function () {
    const { admin, coin, engine } = await networkHelpers.loadFixture(deployFixture);

    expect(await coin.owner()).to.equal(await engine.getAddress());
    await expect(coin.mint(admin.address, 1n))
      .to.be.revertedWithCustomError(coin, "OwnableUnauthorizedAccount")
      .withArgs(admin.address);
    await expect(coin.burn(admin.address, 1n))
      .to.be.revertedWithCustomError(coin, "OwnableUnauthorizedAccount")
      .withArgs(admin.address);
  });
});

describe("StableEngine", function () {
  it("takes ETH as collateral", async function () {
    const { borrower, engine } = await networkHelpers.loadFixture(deployFixture);

    const deposit = engine.depositCollateral({ value: parseEther("2") });
    await expect(deposit).to.emit(engine, "CollateralDeposited").withArgs(borrower.address, parseEther("2"));
    await expect(deposit).to.changeEtherBalances(ethers, [borrower, engine], [parseEther("-2"), parseEther("2")]);
    expect(await engine.collateralDeposited(borrower.address)).to.equal(parseEther("2"));
    expect(await engine.getUsdValue(parseEther("2"))).to.equal(parseEther("4000"));
    expect(await engine.getHealthFactor(borrower.address)).to.equal(ethers.MaxUint256);
    await expect(engine.depositCollateral({ value: 0n })).to.be.revertedWith("Needs more than 0");
  });

  it("mints up to the limit and reverts 1 wei above it", async function () {
    const { borrower, coin, engine } = await networkHelpers.loadFixture(deployFixture);
    await engine.depositCollateral({ value: parseEther("2") });

    await expect(engine.mintStablecoin(MAX_DEBT + 1n)).to.be.revertedWith(HEALTH_FACTOR_BROKEN);
    await expect(engine.mintStablecoin(MAX_DEBT))
      .to.emit(engine, "StablecoinMinted")
      .withArgs(borrower.address, MAX_DEBT);
    expect(await coin.balanceOf(borrower.address)).to.equal(MAX_DEBT);
    expect(await engine.sUsdMinted(borrower.address)).to.equal(MAX_DEBT);
    expect(await engine.getHealthFactor(borrower.address)).to.equal(parseEther("1"));
  });

  it("burns stablecoins and reduces the debt and the supply", async function () {
    const { borrower, coin, engine } = await networkHelpers.loadFixture(maxDebtFixture);

    await expect(engine.burnStablecoin(parseEther("1000")))
      .to.emit(engine, "StablecoinBurned")
      .withArgs(borrower.address, parseEther("1000"));
    expect(await engine.sUsdMinted(borrower.address)).to.equal(MAX_DEBT - parseEther("1000"));
    expect(await coin.balanceOf(borrower.address)).to.equal(MAX_DEBT - parseEther("1000"));
    expect(await coin.totalSupply()).to.equal(MAX_DEBT - parseEther("1000"));
    expect(await engine.getHealthFactor(borrower.address)).to.be.greaterThan(parseEther("1"));
    await expect(engine.burnStablecoin(MAX_DEBT)).to.be.revertedWith("Burning more than minted");
    await expect(engine.burnStablecoin(0n)).to.be.revertedWith("Needs more than 0");
  });

  it("returns collateral while the health factor stays at least 1.0", async function () {
    const { borrower, engine } = await networkHelpers.loadFixture(deployFixture);
    await engine.depositCollateral({ value: parseEther("2") });
    await engine.mintStablecoin(parseEther("1000"));

    // 1.5 ETH = 3000 USD, 3000 * 100 / 150 = 2000 USD against a debt of 1000: health factor 2.0
    const withdrawal = engine.withdrawCollateral(parseEther("0.5"));
    await expect(withdrawal).to.emit(engine, "CollateralWithdrawn").withArgs(borrower.address, parseEther("0.5"));
    await expect(withdrawal).to.changeEtherBalances(ethers, [borrower, engine], [parseEther("0.5"), parseEther("-0.5")]);
    expect(await engine.collateralDeposited(borrower.address)).to.equal(parseEther("1.5"));
    expect(await engine.getHealthFactor(borrower.address)).to.equal(parseEther("2"));
    await expect(engine.withdrawCollateral(parseEther("2"))).to.be.revertedWith("Insufficient collateral");
  });

  it("reverts a withdrawal that would break the health factor", async function () {
    const { borrower, engine } = await networkHelpers.loadFixture(maxDebtFixture);

    await expect(engine.withdrawCollateral(parseEther("1"))).to.be.revertedWith(HEALTH_FACTOR_BROKEN);
    await expect(engine.withdrawCollateral(1n)).to.be.revertedWith(HEALTH_FACTOR_BROKEN);
    expect(await engine.collateralDeposited(borrower.address)).to.equal(parseEther("2"));

    // after paying back half of the debt, 1 ETH can be withdrawn (health factor exactly 1.0)
    await engine.burnStablecoin(MAX_DEBT / 2n);
    await expect(engine.withdrawCollateral(parseEther("1"))).to.emit(engine, "CollateralWithdrawn");
    expect(await engine.getHealthFactor(borrower.address)).to.equal(parseEther("1"));
  });

  it("follows the mock oracle price", async function () {
    const { borrower, adminEngine, engine } = await networkHelpers.loadFixture(maxDebtFixture);

    // ETH falls by 10%: 3600 USD of collateral, health factor 0.9, nothing more can be minted
    // or withdrawn
    await adminEngine.setMockOraclePrice(parseEther("1800"));
    expect(await engine.getHealthFactor(borrower.address)).to.equal(parseEther("0.9"));
    await expect(engine.mintStablecoin(1n)).to.be.revertedWith(HEALTH_FACTOR_BROKEN);
    await expect(engine.withdrawCollateral(1n)).to.be.revertedWith(HEALTH_FACTOR_BROKEN);

    // ETH rises to 3000 USD: health factor 1.5, part of the collateral is free again
    await adminEngine.setMockOraclePrice(parseEther("3000"));
    expect(await engine.getHealthFactor(borrower.address)).to.equal(parseEther("1.5"));
    await expect(engine.withdrawCollateral(parseEther("0.5"))).to.emit(engine, "CollateralWithdrawn");
  });
});
