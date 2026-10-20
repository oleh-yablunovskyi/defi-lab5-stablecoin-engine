# DeFi lab 5 — over-collateralized stablecoin and lending engine

Lab work #5 for the course "Decentralized Finance (DeFi) and Cryptocurrency Technologies" (SUICT):
a lending protocol that takes ETH as collateral and mints a USD stablecoin against it with
over-collateralization, the idea behind MakerDAO and DAI.

- `StableCoin` is an ERC-20 token (OpenZeppelin) whose `mint` and `burn` only its owner can call
  (`Ownable`). After deployment the owner is `StableEngine`, so coins are created and destroyed
  only by the rules of the engine.
- `StableEngine` keeps the ETH collateral and the debt of every user, values ETH with a mock
  oracle price (2000 USD by default) and lets a user mint coins while the health factor stays at
  least 1.0:

  ```text
  health factor = (collateral value in USD * 100 / 150) / debt
  ```

  The collateral ratio of 150% means at least 150 USD of ETH for every 100 coins of debt.

Everything runs on a local Hardhat node (chain id 31337). No accounts, API keys or testnet ETH
are needed.

## Layout

| Path | What it is |
| --- | --- |
| `contracts/StableCoin.sol` | The stablecoin from the lab text; its name and symbol are constructor parameters. |
| `contracts/StableEngine.sol` | The engine from the lab text (`depositCollateral`, `mintStablecoin`, `setMockOraclePrice`, `getHealthFactor`, `getUsdValue`) plus `burnStablecoin` and `withdrawCollateral` from the control task. |
| `scripts/deploy.ts` | Deploys the coin and the engine, transfers the ownership of the coin to the engine, sets the price to 2000 USD and writes the addresses to `deployments/localhost.json`. |
| `scripts/simulate.ts` | The control scenario: account #1 deposits 2 ETH, mints the largest amount the health factor allows and then tries to withdraw 1 ETH, which reverts. |
| `test/StableEngine.ts` | Mocha tests for both contracts. |
| `.env.example` | Name and symbol of the stablecoin. |

## Requirements

Node.js 22 or newer (checked with Node.js 22.22.2 and npm 11.14.0).

## Running

```bash
npm install
cp .env.example .env    # optional: the name and symbol of the stablecoin

# terminal 1: a local node on http://127.0.0.1:8545
npx hardhat node

# terminal 2
npx hardhat run scripts/deploy.ts --network localhost
npx hardhat run scripts/simulate.ts --network localhost
```

The tests run on Hardhat's in-process chain and do not need the node:

```bash
npx hardhat test
npx hardhat test --gas-stats    # the same with the gas used per function
npx tsc --noEmit                # type check, after a build (it generates types/)
```

The node keeps the chain in memory, so after a restart run `deploy.ts` again. `simulate.ts` is
meant for a fresh deployment; a second run deposits 2 ETH more and mints up to the new limit.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `STABLECOIN_NAME` | `StudentUSD` | ERC-20 name of the stablecoin |
| `STABLECOIN_SYMBOL` | `sUSD` | ERC-20 symbol of the stablecoin |

`scripts/deploy.ts` reads them from `.env` with `process.loadEnvFile`. The lab text asks to name
the coin after the student; that name is kept in the local `.env`, which is not committed.

## Expected output

Steps b) and c) of `scripts/simulate.ts` right after `deploy.ts` on a fresh node, without `.env`
(so the coin has the default name):

```text
b) mintStablecoin: the largest amount the health factor allows
[Limit] getUsdValue(2.0 ETH) = 4000.0 USD
        max debt = 4000.0 * 100 / 150 = 2666.666666666666666666 sUSD (rounded down)
        already minted 0.0 sUSD, so max mint = 2666.666666666666666666 sUSD
        = 2666666666666666666666 wei
[Check] mintStablecoin.staticCall(max): succeeds
[Check] mintStablecoin.staticCall(max + 1 wei): reverts with "Health factor is broken (under 1.0)"
[Tx] StableEngine.mintStablecoin(max): block 6, status 1, gas used 104788
[Event] StableCoin.Transfer: value 2666.666666666666666666 sUSD
        from 0x0000000000000000000000000000000000000000
        to   0x70997970C51812dc3A010C7d01b50e0d17dc79C8
[Event] StableEngine.StablecoinMinted: user 0x70997970C51812dc3A010C7d01b50e0d17dc79C8
        amount 2666.666666666666666666 sUSD
[Position] collateral 2.0 ETH = 4000.0 USD
           debt 2666.666666666666666666 sUSD
           health factor: 1.0 (1000000000000000000)
[Balance] borrower: 9997.999910164873844556 ETH, 2666.666666666666666666 sUSD
          sUSD totalSupply: 2666.666666666666666666

c) withdrawCollateral: 1.0 ETH
[Forecast] collateral left 1.0 ETH = 2000.0 USD
           health factor = 2000.0 * 100 / 150 / 2666.666666666666666666 = 0.5
[Revert] withdrawCollateral(1.0 ETH) reverted with "Health factor is broken (under 1.0)"
Захист спрацював успішно: зняття 1.0 ETH відхилено, бо фактор здоров'я впав би до 0.5 (< 1.0)
```

The limit is 4000 / 1.5 USD rounded down to 1 wei. With that debt the health factor is exactly
1.0; one wei more gives 0.999999999999999999, so the mint reverts. The failed withdrawal changes
nothing: the node rejects the transaction already when it estimates the gas, so it is never mined
and the borrower pays no gas.

## Notes

- `setMockOraclePrice` has no access control, as in the code figure of the lab text: any account
  can change the price. It stands in for an oracle in the simulation; a real protocol reads a
  price feed.
- There is no liquidation. A position whose health factor falls below 1.0 after a price drop can
  neither mint nor withdraw, but nobody can liquidate it.
- `burnStablecoin` needs no `approve`: the engine owns the coin and burns from the caller's
  balance.
- `withdrawCollateral` checks the health factor after reducing the collateral and sends the ETH
  last (checks-effects-interactions) with `call`; Solidity 0.8.34 marks `transfer` as deprecated.

The written report is kept outside this repository.
