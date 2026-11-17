import assert from "node:assert/strict";
import { test } from "node:test";

import { daFootprint, estimatedSizeScaled, flzCompressLen, l1Cost } from "../src/fee.ts";
import { keccak256 } from "../src/keccak.ts";
import { quantity, rlp } from "../src/tx.ts";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const str = (s: string) => Buffer.from(s);

test("keccak256 matches the known digests", () => {
  assert.equal(hex(keccak256(str(""))), "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
  assert.equal(hex(keccak256(str("abc"))), "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45");
  assert.equal(hex(keccak256(str("The quick brown fox jumps over the lazy dog"))), "4d741b6f1eb29cb2a9b9911c82f56fa8d73b04959d3d9d222895df6c0b28aa15");
});

test("RLP follows the examples in Ethereum's specification", () => {
  assert.equal(hex(rlp(str("dog"))), "83646f67");
  assert.equal(hex(rlp([str("cat"), str("dog")])), "c88363617483646f67");
  assert.equal(hex(rlp(str(""))), "80");
  assert.equal(hex(rlp([])), "c0");
  assert.equal(hex(rlp(quantity("0x0"))), "80", "zero is the empty string");
  assert.equal(hex(rlp(quantity("0xf"))), "0f", "a byte under 0x80 is itself");
  assert.equal(hex(rlp(quantity("0x400"))), "820400");
  const lorem = "Lorem ipsum dolor sit amet, consectetur adipisicing elit";
  assert.equal(hex(rlp(str(lorem))), `b838${hex(str(lorem))}`, "a 56-byte string takes a length of length");
  assert.equal(hex(rlp([[], [[]], [[], [[]]]])), "c7c0c1c0c3c0c1c0", "the set-theoretic three");
});

test("FastLZ lengths for inputs too short or too varied to match", () => {
  assert.equal(flzCompressLen(new Uint8Array(0)), 0);
  assert.equal(flzCompressLen(str("abcdefghijkl")), 13, "under 13 bytes, it's one literal run: 12 bytes and a tag");
  assert.equal(flzCompressLen(Uint8Array.from({ length: 32 }, (_, i) => i)), 33, "32 distinct bytes: one full literal run");
  assert.ok(flzCompressLen(new Uint8Array(1000)) < 50, "a long run of zeros compresses to a handful of bytes");
});

test("FastLZ stops scanning 13 bytes from the end, as op-geth does", () => {
  // 33 distinct bytes, but bytes 19 to 21 repeat bytes 0 to 2. Scanning ends at ip = 33 - 13 = 20,
  // just as the match at 19 is found, so it's never taken: 33 literals cost 33 + 2 = 35 bytes.
  // Scanning one byte further would encode the match and give 34.
  const ib = Uint8Array.from({ length: 33 }, (_, i) => 100 + i);
  ib.set(ib.slice(0, 3), 19);
  assert.equal(flzCompressLen(ib), 35);
});

test("Fjord's size estimate has a 100-byte floor and a linear slope", () => {
  assert.equal(estimatedSizeScaled(0), 100_000_000n);
  assert.equal(estimatedSizeScaled(170), 100_000_000n, "-42.5856 + 0.8365 × 170 = 99.6: still the floor");
  assert.equal(estimatedSizeScaled(171), -42_585_600n + 836_500n * 171n);
  assert.equal(estimatedSizeScaled(1000), 793_914_400n);
});

test("the L1 fee, gas used and DA footprint follow the formula", () => {
  const p = { l1BaseFee: 1_000_000_000n, l1BlobBaseFee: 1n, baseFeeScalar: 2_000n, blobBaseFeeScalar: 1_000_000n };
  const cost = l1Cost(1000, p);
  // 793.9144 bytes × (16 × 2000 × 1 gwei + 1e6 × 1 wei) / 1e12
  assert.equal(cost.fee, (793_914_400n * (16n * 2_000n * 1_000_000_000n + 1_000_000n)) / 1_000_000_000_000n);
  assert.equal(cost.gasUsed, (793_914_400n * 16n) / 1_000_000n);
  assert.equal(cost.calldataPart, (793_914_400n * 16n * 2_000n * 1_000_000_000n) / 1_000_000_000_000n);
  assert.equal(daFootprint(1000, 400n), 793n * 400n, "whole bytes, times the scalar");
  assert.equal(daFootprint(0, 148n), 100n * 148n, "the floor counts too");
});
