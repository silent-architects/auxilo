# Base Sepolia E2E — AuxiloSplitRouter live exercise

One `forge script` invocation deploys the router to Base Sepolia and runs a full
live settlement: throwaway buyer signs a ReceiveWithAuthorization over the
derived nonce (`keccak256(abi.encode(contributor, 7000, salt))`) against real
Circle testnet USDC, the settler settles, and the script asserts the 70/30
split landed. No real funds; this validates the flow end-to-end pre-audit.

- Script: `script/SepoliaE2E.s.sol`
- USDC (Base Sepolia, Circle-verified): `0x036CbD53842c5426634e7929541eC2318f3dCF7e`
- RPC: `base_sepolia` → `https://sepolia.base.org` (already in `foundry.toml`)
- Chain id: 84532

## 1. Fund ONE address

The deployer key plays deployer + settler + buyer-funder. It needs, on
**Base Sepolia**:

| Asset | Amount | Faucet |
|---|---|---|
| ETH | ~0.005 (gas for 3 txs) | any Base Sepolia faucet (e.g. Coinbase Developer Platform faucet, Alchemy faucet) |
| USDC | >= 1 USDC | https://faucet.circle.com — select **Base Sepolia** |

The buyer needs nothing: its signature is produced off-chain (`vm.sign`) and
it never sends a transaction. Buyer / contributor / feeWallet addresses are
derived in-script from the deployer address (overridable, see env below).

## 2. Env setup

```sh
cd /Users/iamtylerkelley/dev/auxilo/contracts
export DEPLOYER_PK=0x<raw 32-byte private key of the funded address>
```

Optional overrides:

| Var | Default | Purpose |
|---|---|---|
| `BUYER_PK` | derived from deployer | throwaway buyer key |
| `FEE_WALLET` | derived fresh address | fee destination |
| `E2E_SALT` | unique per run (timestamp-mixed) | EIP-3009 salt; set only to reproduce a specific nonce |

Do not reuse the same `E2E_SALT` twice with the same buyer — EIP-3009 nonce
reuse will revert (`FiatTokenV2: authorization is used or canceled`).

## 3. Run

```sh
forge script script/SepoliaE2E.s.sol --rpc-url base_sepolia --broadcast -vvv
```

(Without `--broadcast` it simulates only — useful as a rehearsal; the
assertions run either way.)

## 4. What success looks like

```
== Logs ==
  deployer/settler : 0x...
  buyer (throwaway): 0x...
  contributor      : 0x...
  feeWallet        : 0x...
  salt             : 0x...
  router deployed  : 0x...
  derived nonce    : 0x...

  === E2E SPLIT OK ===
  router                 : 0x<ROUTER ADDRESS — record this>
  contributor +USDC (6dp): 700000        <- 0.70 USDC
  feeWallet   +USDC (6dp): 300000        <- 0.30 USDC
  router balance         : 0

ONCHAIN EXECUTION COMPLETE & SUCCESSFUL.
```

Three txs broadcast, in order: router deploy, 1-USDC buyer funding,
`settleAndSplitReceive`. **Tx hashes** are written to
`broadcast/SepoliaE2E.s.sol/84532/run-latest.json` — record them alongside the
router address. Spot-check on https://sepolia.basescan.org.

Verify balances independently:

```sh
cast call 0x036CbD53842c5426634e7929541eC2318f3dCF7e \
  "balanceOf(address)(uint256)" <contributor addr> --rpc-url base_sepolia
```

## 5. Expected failures (pre-funding / misconfig)

These are the failures you'll see BEFORE the address is funded — anything else
is a real problem:

| Failure | Meaning |
|---|---|
| `vm.envUint: environment variable "DEPLOYER_PK" not found` | env not exported |
| `PRE-FLIGHT: deployer needs Base Sepolia ETH (~0.005)...` | no testnet ETH yet |
| `PRE-FLIGHT: deployer needs >= 1 USDC on Base Sepolia...` | no testnet USDC yet |

Both PRE-FLIGHT checks run before any broadcast, so an unfunded run costs
nothing and deploys nothing. Verified 2026-07-03: the script compiles and,
dry-run against live Base Sepolia with an unfunded key, fails exactly at the
ETH pre-flight line above.

## 6. Scope note

Testnet only. Mainnet deploy remains gated on the external audit + R-01
counsel sign-off (see `README.md` in this directory).
