// Control task, step 1: deploy StableCoin and StableEngine on the local node and make the
// engine the owner of the stablecoin, so that only the engine can mint and burn it.
//   npx hardhat node
//   npx hardhat run scripts/deploy.ts --network localhost
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { network } from "hardhat";
import type { BaseContract, ContractTransactionResponse, TransactionReceipt } from "ethers";

// The stablecoin name and symbol are read from .env (see .env.example); without it the
// neutral defaults below are used
const envFile = new URL("../.env", import.meta.url);
const hasEnvFile = existsSync(envFile);
if (hasEnvFile) process.loadEnvFile(envFile);
const NAME = process.env.STABLECOIN_NAME || "StudentUSD";
const SYMBOL = process.env.STABLECOIN_SYMBOL || "sUSD";

// Hardhat 3 has no global `ethers` object: it comes from a connection to the network
// chosen with --network
const { ethers, networkName } = await network.create();
const { formatEther, parseEther } = ethers;

// ETH price for the mock oracle: 2000 USD with 18 decimals (2000e18)
const ETH_USD_PRICE = parseEther("2000");

async function send(label: string, response: Promise<ContractTransactionResponse>) {
  const receipt = (await (await response).wait()) as TransactionReceipt;
  console.log(`[Tx] ${label}: block ${receipt.blockNumber}, status ${receipt.status}, gas used ${receipt.gasUsed}`);
  return receipt;
}

async function deployed(label: string, contract: BaseContract) {
  const receipt = (await contract.deploymentTransaction()!.wait()) as TransactionReceipt;
  console.log(`[Deploy] ${label} at ${await contract.getAddress()}: block ${receipt.blockNumber}, gas used ${receipt.gasUsed}`);
}

const [admin] = await ethers.getSigners();
const { chainId } = await ethers.provider.getNetwork();
console.log(`[Network] ${networkName}, chain id ${chainId}, block ${await ethers.provider.getBlockNumber()}`);
console.log(`[Admin] account #0 ${admin.address}`);
console.log(`[Config] .env ${hasEnvFile ? "found" : "not found"}: name "${NAME}", symbol "${SYMBOL}"`);

// 1. The stablecoin. Its first owner is the admin, who deploys it.
const coin = await ethers.deployContract("StableCoin", [NAME, SYMBOL, admin.address], admin);
await deployed("StableCoin", coin);
const coinAddress = await coin.getAddress();
console.log(`         name "${await coin.name()}", symbol "${await coin.symbol()}", decimals ${await coin.decimals()}, totalSupply ${formatEther(await coin.totalSupply())}`);

// 2. The lending engine, which keeps the ETH collateral and the debts
const engine = await ethers.deployContract("StableEngine", [coinAddress], admin);
await deployed("StableEngine", engine);
const engineAddress = await engine.getAddress();
console.log(`         sUsd() = ${await engine.sUsd()}`);
console.log(`         COLLATERAL_RATIO = ${await engine.COLLATERAL_RATIO()}%, MIN_HEALTH_FACTOR = ${formatEther(await engine.MIN_HEALTH_FACTOR())}`);
console.log(`         mockEthUsdPrice = ${formatEther(await engine.mockEthUsdPrice())} (initial value)`);

// 3. The engine becomes the only owner of the stablecoin: from now on only its code can
//    call mint and burn
console.log(`\n[Owner] before: StableCoin.owner() = ${await coin.owner()} (admin)`);
await send("StableCoin.transferOwnership(StableEngine)", coin.transferOwnership(engineAddress));
console.log(`[Owner] after:  StableCoin.owner() = ${await coin.owner()} (StableEngine)`);
// Check without a transaction: the admin's mint must now revert with the custom error of
// Ownable, which the node returns ABI-encoded in `error.data`
try {
  await coin.mint.staticCall(admin.address, 1n);
  throw new Error("the admin can still mint");
} catch (error) {
  const data = (error as { data?: unknown }).data;
  const parsed = typeof data === "string" ? coin.interface.parseError(data) : null;
  if (parsed === null) throw error;
  console.log(`[Check] StableCoin.mint called by the admin reverts with ${parsed.name}`);
  console.log(`        (${parsed.args.join(", ")})`);
}

// 4. The admin sets the mock oracle price. 2000e18 is also the initial value in the contract;
//    it is set here so that the price used by the scenario is visible.
console.log();
await send("StableEngine.setMockOraclePrice(2000e18)", engine.setMockOraclePrice(ETH_USD_PRICE));
console.log(`[Oracle] mockEthUsdPrice() = ${formatEther(await engine.mockEthUsdPrice())} USD per ETH`);

// 5. Save the addresses for scripts/simulate.ts
const deployment = {
  network: networkName,
  chainId: Number(chainId),
  admin: admin.address,
  stableCoin: coinAddress,
  stableEngine: engineAddress,
};
const file = `deployments/${networkName}.json`;
await mkdir("deployments", { recursive: true });
await writeFile(file, JSON.stringify(deployment, null, 2) + "\n");
console.log(`\nAddresses saved to ${file}`);
