# op-fee-audit

Recomputes the L1 data fee of every transaction in an OP Stack chain's latest blocks, from the
transaction's own bytes, and checks the receipts agree. It works on Base, OP Mainnet and the
other chains of the Superchain.

For each transaction, `op-fee-audit`:

1. **rebuilds the signed transaction** from the fields the node returns, in its EIP-2718
   envelope, and proves the rebuild: its keccak256 must be the transaction's hash;
2. **compresses it with FastLZ** and feeds the length into Fjord's size estimate;
3. **prices the estimate** with the L1 base fee, the L1 blob base fee and the chain's scalars,
   all as the receipt records them;
4. **compares** the fee, the L1 gas used and Jovian's DA footprint with the receipt.

It exits 1 if any receipt disagrees.

## Why

An OP Stack transaction pays two fees: L2 execution gas, and an L1 data fee for its share of the
batches posted to Ethereum. Since Fjord, that share is estimated from the transaction's
compressed size:

```text
estimatedSize = max(100, −42.5856 + 0.8365 × fastlzSize)    bytes, from a linear regression
l1Fee         = estimatedSize × (16 × baseFeeScalar × l1BaseFee + blobBaseFeeScalar × l1BlobBaseFee) / 10^6
```

The pieces are scattered: the formula in the specs, the compressor in op-geth (after Solady), the
prices in the receipt and the bytes in the block. `op-fee-audit` puts them back together for real
transactions, and shows how a chain's fees break down:

- **Base:** on 2026-11-17, the median transaction paid 2.29 gwei of L1 fee, and 36.1% of all L1
  fees came from the L1 base fee side, the rest from blobs.
- **OP Mainnet:** with a higher base fee scalar, 5,227 against Base's 2,269, 59.5% did.
- **The floor:** 228 of 510 OP Mainnet transactions were small enough to pay for the 100-byte
  minimum.

## Quick start

Needs Node 24 or later, and nothing else.

```sh
git clone https://github.com/Urthella/op-fee-audit && cd op-fee-audit
node src/main.ts --rpc https://optimism-rpc.publicnode.com --blocks 10
```

```text
10 blocks on OP Mainnet (chain 10), 159655105 to 159655114: 520 transactions, 10 of them deposits
  check: 510 of 510 rebuilt transactions hash to their own hash
  check: the L1 fee matches the Fjord formula on 510 of 510 receipts; l1GasUsed on 510 of 510; the DA footprint on 510 of 510
  estimated batch size: median 119 bytes; 228 transactions at the 100-byte floor
  L1 fee: median 2.13 gwei; 59.5% of all L1 fees priced at the L1 base fee, the rest at the blob base fee
  scalars: 5,227 on the L1 base fee, 1,014,213 on the blob base fee
```

- `--rpc URL` picks the node: `https://mainnet.base.org` by default. OP Mainnet's own public
  endpoint rate-limits hard, so publicnode's is easier for it.
- `--chain NAME[,NAME...]` audits chains by name, each through a public RPC that worked, and checks
  each node serves the chain it should:
  - names: `base`, `optimism`, `unichain`, `ink`, `soneium`, `worldchain`, `mode`, `zora`, `lisk`,
    `op-sepolia` and `base-sepolia`;
  - `all` stands for the nine mainnets;
  - `OP_FEE_AUDIT_RPC_BASE`, `OP_FEE_AUDIT_RPC_OP_SEPOLIA` and so on point a chain at your own
    node. Errors name the chain, not the URL, so an API key in it stays out of logs.
- `--blocks N` sets how many of the latest blocks to audit: 10 by default, up to 200.
- `--json` prints the report as JSON, or an array of reports for several chains.

Exit codes: 0 when every receipt matches, 1 when one doesn't, and 2 when transactions couldn't be
checked or something failed. Across several chains, a receipt that disagrees outranks a chain that
couldn't be read.

## Across the Superchain

`node src/main.ts --chain all` on 2026-11-17, ten blocks each:

| Chain | Receipts matched | Median L1 fee | Priced at the L1 base fee | Scalars: L1 base fee, blob base fee |
|---|---:|---:|---:|---|
| Base | 589 of 589 | 1.25 gwei | 43.5% | 2,269, 1,055,762 |
| OP Mainnet | 394 of 394 | 1.74 gwei | 59.3% | 5,227, 1,014,213 |
| Unichain | 40 of 40 | 2.5 gwei | 37.8% | 2,000, 900,000 |
| Ink | 104 of 104 | 1.41 gwei | 59.9% | 4,424, 810,831 |
| Soneium | 2 of 2 | 5.63 gwei | 61.5% | 9,736, 1,540,079 |
| World Chain | 106 of 106 | 9.28 gwei | 72.0% | 8,697, 906,223 |
| Mode | 1 of 1 | 99.99 gwei | 95.9% | 100,000, 1,014,213 |
| Zora | no paying transactions | | | |
| Lisk | no paying transactions | | | |

- **The same formula, tuned per chain:** every chain runs Fjord's formula, but each sets its own
  scalars, and they decide how much of the fee follows Ethereum's base fee rather than its blob
  fee.
- **Mode** sets its base fee scalar at 100,000, 44 times Base's, so its one transaction paid most
  of its L1 fee at the L1 base fee.
- **World Chain's** transactions were the largest, a median 404 bytes against Base's 118, and paid
  the most of the busy chains.

## What it does

- **Reads blocks with their transactions**, and their receipts with `eth_getBlockReceipts`.
  Where that isn't allowed, it asks for each receipt in small batches.
- **Rebuilds** legacy, EIP-2930, EIP-1559 and EIP-7702 transactions with RLP. Deposits, type
  `0x7e`, pay no L1 fee and are counted apart. Node's crypto has no Keccak-256, so it has its
  own.
- **Compresses** with a port of op-geth's `FlzCompressLen`, the FastLZ length function after
  Solady, and computes the fee, the L1 gas used (the estimate at 16 gas a byte) and, where the
  receipt has Jovian's `daFootprintGasScalar`, the DA footprint (the estimate in whole bytes
  times the scalar).
- **Waits out rate limits,** whether a node says so with HTTP 429 or inside its JSON-RPC reply.

## How it's checked

- **The building blocks:**
  - Keccak-256 against its known digests;
  - RLP against the examples in Ethereum's specification;
  - FastLZ on inputs worked out by hand, including one where scanning a byte past op-geth's
    limit would change the answer;
  - the size estimate's floor and slope, and the fee formula.
- **Real blocks:** six from Base and three from OP Mainnet, saved with their receipts by
  [`scripts/fetch-fixtures.ts`](scripts/fetch-fixtures.ts):
  - every transaction, legacy, EIP-1559 and an EIP-7702 one, rebuilds to bytes that hash to
    its hash, including over 50 longer than one Keccak block;
  - every receipt's fee, gas used and DA footprint matches;
  - pricing the uncompressed length instead gets a real fee wrong.
- **End to end:** the CLI runs against a fake node serving the Base blocks:
  - the floor count and median size match ones worked out in the test;
  - receipts fall back to one by one;
  - a tampered fee fails, and an unknown transaction type is reported unchecked;
  - a rate limit inside the JSON-RPC reply is retried;
  - a chain name reaches the node its environment variable names, and `all` reaches every
    mainnet and no testnet;
  - a node serving the wrong chain fails while the other chains still run, and errors name the
    chain rather than the URL;
  - bad arguments and an unreachable node exit 2.
- **Mutation testing:** thirty deliberate bugs were planted one at a time, and the tests caught
  every one.
- **Live**, on 2026-11-17, every receipt matched:
  - the nine mainnets above, 1,236 of 1,236;
  - another run of OP Mainnet, 510 of 510;
  - OP Sepolia, 5 of 5, and Base Sepolia, 63 of 63.

## Limits

- It checks Fjord's formula, which every Superchain chain has run since 2024. Older blocks priced
  with Bedrock's or Ecotone's formulas would show as mismatches.
- No EIP-2930 transaction turned up in the saved blocks, so that type is rebuilt but not checked
  against real data.
- It checks the L1 data fee only. Isthmus' operator fee and L2 execution gas aren't recomputed.

## License

MIT
