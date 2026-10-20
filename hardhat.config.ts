import hardhatToolboxMochaEthersPlugin from "@nomicfoundation/hardhat-toolbox-mocha-ethers";
import { defineConfig } from "hardhat/config";

// Local development only. Two networks are built into Hardhat and need no config:
// - "default": an in-process simulated chain (`npx hardhat test`);
// - "localhost": http://127.0.0.1:8545, the chain started with `npx hardhat node`.
export default defineConfig({
  plugins: [hardhatToolboxMochaEthersPlugin],
  solidity: {
    profiles: {
      default: {
        version: "0.8.34",
      },
      production: {
        version: "0.8.34",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
        },
      },
    },
  },
});
