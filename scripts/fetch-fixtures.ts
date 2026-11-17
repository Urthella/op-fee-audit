// Saves real blocks for the offline tests: six from Base and three from OP Mainnet, with their
// transactions and receipts cut down to the fields the audit reads.
//
//   node scripts/fetch-fixtures.ts

import { writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

import { collect } from "../src/audit.ts";
import { Rpc } from "../src/rpc.ts";

const keep = <T extends object>(o: T, keys: string[]) => Object.fromEntries(Object.entries(o).filter(([k]) => keys.includes(k)));
const TX = ["hash", "type", "chainId", "nonce", "gas", "gasPrice", "maxPriorityFeePerGas", "maxFeePerGas", "to", "value", "input", "accessList", "authorizationList", "v", "yParity", "r", "s"];
const RECEIPT = ["transactionHash", "l1Fee", "l1GasUsed", "l1GasPrice", "l1BlobBaseFee", "l1BaseFeeScalar", "l1BlobBaseFeeScalar", "daFootprintGasScalar", "blobGasUsed"];

for (const [name, url, count] of [["base", "https://base-rpc.publicnode.com", 6], ["optimism", "https://optimism-rpc.publicnode.com", 3]] as const) {
  const { chainId, blocks } = await collect(new Rpc(url), count);
  const trimmed = blocks.map((b) => ({ number: b.number, transactions: b.transactions.map((t) => keep(t, TX)), receipts: b.receipts.map((r) => keep(r, RECEIPT)) }));
  writeFileSync(new URL(`../test/fixtures/${name}.json.gz`, import.meta.url), gzipSync(JSON.stringify({ chainId, blocks: trimmed })));
  console.log(`${name}: chain ${chainId}, blocks ${trimmed.map((b) => b.number).join(", ")}, ${trimmed.reduce((n, b) => n + b.transactions.length, 0)} transactions`);
}
