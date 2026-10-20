// Control task, step 3: the scenario on the contracts deployed by scripts/deploy.ts.
//   a) The borrower (account #1) deposits 2 ETH as collateral at the price of 2000 USD.
//   b) The script computes the largest amount of the stablecoin the engine allows to mint,
//      checks it with two simulated calls and mints it.
//   c) The borrower tries to withdraw 1 ETH. The engine must revert; the script catches the
//      error and prints its reason.
//   npx hardhat run scripts/simulate.ts --network localhost
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { network } from "hardhat";
import type { BaseContract, ContractTransactionResponse, TransactionReceipt } from "ethers";

const { ethers, networkName } = await network.create();
const { formatEther, parseEther } = ethers;

const DEPOSIT = parseEther("2"); // ETH
const WITHDRAW = parseEther("1"); // ETH
const ONE = 10n ** 18n; // 1.0 with 18 decimals, the scale of the health factor
// The message of the require in _revertIfHealthFactorIsBroken
const HEALTH_FACTOR_BROKEN = "Health factor is broken (under 1.0)";

const deploymentFile = `deployments/${networkName}.json`;
if (!existsSync(deploymentFile)) {
  throw new Error(`No ${deploymentFile}, run scripts/deploy.ts first`);
}
const deployment = JSON.parse(await readFile(deploymentFile, "utf8"));
if ((await ethers.provider.getCode(deployment.stableEngine)) === "0x") {
  throw new Error(`No StableEngine at ${deployment.stableEngine}, run scripts/deploy.ts first`);
}
const [, borrower] = await ethers.getSigners();
const coin = await ethers.getContractAt("StableCoin", deployment.stableCoin);
// every transaction of the scenario is sent by the borrower
const engine = (await ethers.getContractAt("StableEngine", deployment.stableEngine)).connect(borrower);
const symbol = await coin.symbol();
const ratio = await engine.COLLATERAL_RATIO();

// The node answers a reverted call with the ABI-encoded revert data in `error.data`:
// Error(string) for a require with a message, or a custom error of the contract.
// An error without revert data is not a revert (a network problem or a bug in the script).
function revertReason(error: unknown, contract: BaseContract): string {
  const data = (error as { data?: unknown }).data;
  if (typeof data !== "string") throw error;
  // a revert without a reason, e.g. a require without a message, returns no selector
  if (data.length < 10) return `no reason (revert data ${data})`;
  const parsed = contract.interface.parseError(data);
  if (parsed === null) return `an unknown error ${data.slice(0, 10)}`;
  return parsed.name === "Error" ? `"${parsed.args[0]}"` : `${parsed.name}(${parsed.args.join(", ")})`;
}

async function send(label: string, response: Promise<ContractTransactionResponse>) {
  const receipt = (await (await response).wait()) as TransactionReceipt;
  console.log(`[Tx] ${label}: block ${receipt.blockNumber}, status ${receipt.status}, gas used ${receipt.gasUsed}`);
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() === deployment.stableCoin.toLowerCase()) {
      const { name, args } = coin.interface.parseLog(log)!;
      console.log(`[Event] StableCoin.${name}: value ${formatEther(args.value)} ${symbol}`);
      console.log(`        from ${args.from}`);
      console.log(`        to   ${args.to}`);
    } else {
      const { name, args } = engine.interface.parseLog(log)!;
      const unit = name.startsWith("Collateral") ? "ETH" : symbol;
      console.log(`[Event] StableEngine.${name}: user ${args.user}`);
      console.log(`        amount ${formatEther(args.amount)} ${unit}`);
    }
  }
}

async function position() {
  const collateral = await engine.collateralDeposited(borrower);
  const debt = await engine.sUsdMinted(borrower);
  const healthFactor = await engine.getHealthFactor(borrower);
  console.log(`[Position] collateral ${formatEther(collateral)} ETH = ${formatEther(await engine.getUsdValue(collateral))} USD`);
  console.log(`           debt ${formatEther(debt)} ${symbol}`);
  console.log(healthFactor === ethers.MaxUint256
    ? "           health factor: type(uint256).max (no debt)"
    : `           health factor: ${formatEther(healthFactor)} (${healthFactor})`);
}

async function balances() {
  const eth = formatEther(await ethers.provider.getBalance(borrower));
  const stable = formatEther(await coin.balanceOf(borrower));
  console.log(`[Balance] borrower: ${eth} ETH, ${stable} ${symbol}`);
  console.log(`          ${symbol} totalSupply: ${formatEther(await coin.totalSupply())}`);
}

const { chainId } = await ethers.provider.getNetwork();
console.log(`[Network] ${networkName}, chain id ${chainId}, block ${await ethers.provider.getBlockNumber()}`);
console.log(`[StableCoin] ${await coin.name()} (${symbol}) at ${deployment.stableCoin}`);
console.log(`             owner() = ${await coin.owner()} (StableEngine)`);
console.log(`[StableEngine] at ${deployment.stableEngine}`);
const price = formatEther(await engine.mockEthUsdPrice());
const minHealthFactor = formatEther(await engine.MIN_HEALTH_FACTOR());
console.log(`[Engine] mockEthUsdPrice ${price} USD per ETH, COLLATERAL_RATIO ${ratio}%, MIN_HEALTH_FACTOR ${minHealthFactor}`);
console.log(`[Borrower] account #1 ${borrower.address}`);
await balances();

// a) Deposit of the collateral
console.log(`\na) depositCollateral: ${formatEther(DEPOSIT)} ETH`);
await send("StableEngine.depositCollateral", engine.depositCollateral({ value: DEPOSIT }));
await position();

// b) The maximum mint. With integer division the engine computes
//      limit = getUsdValue(collateral) * 100 / COLLATERAL_RATIO,
//      getHealthFactor = limit * 1e18 / debt (rounded down).
//    The rounded-down result is at least 1e18 exactly when debt <= limit, so the largest allowed
//    debt is limit itself, and the largest mint is limit minus the debt already minted.
console.log("\nb) mintStablecoin: the largest amount the health factor allows");
const collateral = await engine.collateralDeposited(borrower);
const collateralUsd = await engine.getUsdValue(collateral);
const maxDebt = (collateralUsd * 100n) / ratio;
const minted = await engine.sUsdMinted(borrower);
const maxMint = maxDebt - minted;
console.log(`[Limit] getUsdValue(${formatEther(collateral)} ETH) = ${formatEther(collateralUsd)} USD`);
console.log(`        max debt = ${formatEther(collateralUsd)} * 100 / ${ratio} = ${formatEther(maxDebt)} ${symbol} (rounded down)`);
console.log(`        already minted ${formatEther(minted)} ${symbol}, so max mint = ${formatEther(maxMint)} ${symbol}`);
console.log(`        = ${maxMint} wei`);
// Proof without sending transactions: staticCall (eth_call) runs the function on the current
// state and discards the result
await engine.mintStablecoin.staticCall(maxMint);
console.log("[Check] mintStablecoin.staticCall(max): succeeds");
try {
  await engine.mintStablecoin.staticCall(maxMint + 1n);
  throw new Error("mintStablecoin(max + 1 wei) did not revert, the limit is wrong");
} catch (error) {
  console.log(`[Check] mintStablecoin.staticCall(max + 1 wei): reverts with ${revertReason(error, engine)}`);
}
await send("StableEngine.mintStablecoin(max)", engine.mintStablecoin(maxMint));
await position();
await balances();

// c) Withdrawal of 1 ETH. The health factor the withdrawal would give is computed from the
//    on-chain values with the formula of getHealthFactor.
console.log(`\nc) withdrawCollateral: ${formatEther(WITHDRAW)} ETH`);
const debt = await engine.sUsdMinted(borrower);
const usdLeft = await engine.getUsdValue(collateral - WITHDRAW);
const healthFactorLeft = (((usdLeft * 100n) / ratio) * ONE) / debt;
console.log(`[Forecast] collateral left ${formatEther(collateral - WITHDRAW)} ETH = ${formatEther(usdLeft)} USD`);
console.log(`           health factor = ${formatEther(usdLeft)} * 100 / ${ratio} / ${formatEther(debt)} = ${formatEther(healthFactorLeft)}`);
const ethBefore = await ethers.provider.getBalance(borrower);
try {
  await send("StableEngine.withdrawCollateral", engine.withdrawCollateral(WITHDRAW));
  console.log("Захист НЕ спрацював: застава знята, хоча фактор здоров'я впав нижче 1.0");
  process.exitCode = 1;
} catch (error) {
  const reason = revertReason(error, engine);
  console.log(`[Revert] withdrawCollateral(${formatEther(WITHDRAW)} ETH) reverted with ${reason}`);
  if (reason === `"${HEALTH_FACTOR_BROKEN}"`) {
    console.log(`Захист спрацював успішно: зняття ${formatEther(WITHDRAW)} ETH відхилено, бо фактор здоров'я впав би до ${formatEther(healthFactorLeft)} (< 1.0)`);
  } else {
    console.log("Неочікуваний відкат: зняття відхилено не перевіркою фактора здоров'я");
    process.exitCode = 1;
  }
}
await position();
const ethAfter = await ethers.provider.getBalance(borrower);
console.log(`[Balance] borrower ETH before and after c): ${formatEther(ethBefore)} -> ${formatEther(ethAfter)}`);
