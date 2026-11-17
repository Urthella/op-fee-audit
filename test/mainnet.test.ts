// Real blocks from Base and OP Mainnet, with their receipts, saved by scripts/fetch-fixtures.ts.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";

import { type Block, audit } from "../src/audit.ts";
import { flzCompressLen, l1Cost } from "../src/fee.ts";
import { hashesTo, rawTransaction } from "../src/tx.ts";

const load = (name: string): { chainId: number; blocks: Block[] } => JSON.parse(gunzipSync(readFileSync(new URL(`fixtures/${name}.json.gz`, import.meta.url))).toString("utf8"));
const chains = { base: load("base"), optimism: load("optimism") };

test("every real transaction rebuilds to bytes that hash to its hash, long ones and EIP-7702 included", () => {
  const types = new Set<string>();
  let long = 0;
  for (const { blocks } of Object.values(chains)) {
    for (const tx of blocks.flatMap((b) => b.transactions)) {
      if (tx.type === "0x7e") continue;
      const raw = rawTransaction(tx)!;
      assert.ok(hashesTo(raw, tx.hash), `${tx.hash} (type ${tx.type})`);
      types.add(tx.type);
      if (raw.length > 136) long++;
    }
  }
  assert.deepEqual([...types].sort(), ["0x0", "0x2", "0x4"]);
  assert.ok(long > 50, `${long} transactions past Keccak's 136-byte block`);
});

test("every real receipt's L1 fee, L1 gas used and DA footprint are the formula's", () => {
  for (const [name, { chainId, blocks }] of Object.entries(chains)) {
    const report = audit(chainId, blocks);
    assert.deepEqual(report.mismatches, [], name);
    assert.deepEqual(report.unchecked, [], name);
    assert.equal(report.checked + report.deposits, report.transactions, name);
    assert.equal(report.footprints, report.checked, `${name}: every receipt has Jovian's DA footprint`);
  }
  assert.equal(audit(chains.base.chainId, chains.base.blocks).chain, "Base");
  assert.equal(audit(chains.optimism.chainId, chains.optimism.blocks).chain, "OP Mainnet");
});

test("compression matters: pricing the uncompressed length gets the real fee wrong", () => {
  const block = chains.optimism.blocks.find((b) => b.transactions.some((t) => t.type !== "0x7e" && rawTransaction(t)!.length > 300))!;
  const tx = block.transactions.find((t) => t.type !== "0x7e" && rawTransaction(t)!.length > 300)!;
  const receipt = block.receipts.find((r) => r.transactionHash === tx.hash)!;
  const params = { l1BaseFee: BigInt(receipt.l1GasPrice!), l1BlobBaseFee: BigInt(receipt.l1BlobBaseFee!), baseFeeScalar: BigInt(receipt.l1BaseFeeScalar!), blobBaseFeeScalar: BigInt(receipt.l1BlobBaseFeeScalar!) };
  const raw = rawTransaction(tx)!;
  assert.equal(l1Cost(flzCompressLen(raw), params).fee, BigInt(receipt.l1Fee!));
  assert.notEqual(l1Cost(raw.length, params).fee, BigInt(receipt.l1Fee!));
});
