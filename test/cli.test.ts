// Runs the real CLI against a fake OP Stack node serving the saved Base blocks, which can be told
// to misbehave.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import type { Block } from "../src/audit.ts";

const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const { chainId, blocks }: { chainId: number; blocks: Block[] } = JSON.parse(gunzipSync(readFileSync(new URL("fixtures/base.json.gz", import.meta.url))).toString("utf8"));
const latest = blocks.at(-1)!.number;

let noBlockReceipts = false;
let tamperedFee: string | undefined;
let unknownType: string | undefined;
let rateLimits = 0;

const server = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  const calls = JSON.parse(body) as { id: number; method: string; params: unknown[] }[];
  const limited = rateLimits > 0;
  if (limited) rateLimits--;
  const answer = ({ id, method, params }: (typeof calls)[number]) => {
    const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });
    const error = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
    if (limited) return error(-32016, "Your IP has exceeded its requests per second capacity");
    const block = (n: unknown) => blocks.find((b) => b.number === Number(n));
    const receipt = (r: Block["receipts"][number]) => (r.transactionHash === tamperedFee ? { ...r, l1Fee: `0x${(BigInt(r.l1Fee!) + 1n).toString(16)}` } : r);
    switch (method) {
      case "eth_chainId":
        return ok(`0x${chainId.toString(16)}`);
      case "eth_blockNumber":
        return ok(`0x${latest.toString(16)}`);
      case "eth_getBlockByNumber": {
        const b = block(params[0]);
        return ok(b && { number: `0x${b.number.toString(16)}`, transactions: b.transactions.map((t) => (t.hash === unknownType ? { ...t, type: "0x63" } : t)) });
      }
      case "eth_getBlockReceipts":
        return noBlockReceipts ? error(-32601, "rpc method is not whitelisted") : ok(block(params[0])?.receipts.map(receipt));
      case "eth_getTransactionReceipt": {
        const r = blocks.flatMap((b) => b.receipts).find((r) => r.transactionHash === params[0]);
        return ok(r && receipt(r));
      }
    }
    return error(-32601, "method not found");
  };
  response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(calls.map(answer)));
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
server.unref();
const RPC = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

function run(...args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [MAIN, "--rpc", RPC, ...args], (error, stdout, stderr) => resolve({ code: error ? Number(error.code) : 0, out: stdout + stderr }));
  });
}
const paying = blocks.flatMap((b) => b.transactions).filter((t) => t.type !== "0x7e");

/** Runs with `--chain` presets, each pointed at the fake node through its environment variable. */
function runChains(chains: string[], ...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const env = { ...process.env };
  for (const c of chains) env[`OP_FEE_AUDIT_RPC_${c.toUpperCase().replaceAll("-", "_")}`] = RPC;
  return new Promise((resolve) => {
    execFile(process.execPath, [MAIN, ...args], { env }, (error, stdout, stderr) => resolve({ code: error ? Number(error.code) : 0, stdout, stderr }));
  });
}

test("audits the saved Base blocks, exit 0", async () => {
  const { code, out } = await run("--blocks", String(blocks.length));
  assert.equal(code, 0, out);
  const n = paying.length;
  assert.match(out, new RegExp(`^${blocks.length} blocks on Base \\(chain 8453\\), ${blocks[0].number} to ${latest}: `));
  assert.match(out, new RegExp(`check: ${n} of ${n} rebuilt transactions hash to their own hash`));
  assert.match(out, new RegExp(`check: the L1 fee matches the Fjord formula on ${n} of ${n} receipts; l1GasUsed on ${n} of ${n}; the DA footprint on ${n} of ${n}`));
  assert.match(out, /scalars: [\d,]+ on the L1 base fee, [\d,]+ on the blob base fee/);
});

test("without eth_getBlockReceipts, receipts are asked for one by one", async () => {
  noBlockReceipts = true;
  try {
    const { code, out } = await run("--blocks", "2", "--json");
    assert.equal(code, 0, out);
    const report = JSON.parse(out);
    const txs = blocks.slice(-2).flatMap((b) => b.transactions).filter((t) => t.type !== "0x7e");
    assert.equal(report.checked, txs.length);
    assert.deepEqual(report.mismatches, []);
    // The floor count and the median size, worked out here from the rebuilt bytes.
    const { estimatedSizeScaled, flzCompressLen } = await import("../src/fee.ts");
    const { rawTransaction } = await import("../src/tx.ts");
    const sizes = txs.map((t) => estimatedSizeScaled(flzCompressLen(rawTransaction(t)!)));
    assert.equal(report.atFloor, sizes.filter((s) => s === 100_000_000n).length);
    const whole = sizes.map((s) => Number(s / 1_000_000n)).sort((a, b) => a - b);
    assert.equal(report.medianSize, whole[Math.floor((whole.length - 1) / 2)]);
  } finally {
    noBlockReceipts = false;
  }
});

test("a receipt with the wrong L1 fee exits 1 and names the transaction", async () => {
  tamperedFee = paying.at(-1)!.hash;
  try {
    const { code, out } = await run("--blocks", "3");
    assert.equal(code, 1, out);
    assert.match(out, new RegExp(`${tamperedFee}: l1Fee should be [\\d,]+, the receipt has [\\d,]+`));
  } finally {
    tamperedFee = undefined;
  }
});

test("a transaction of an unknown type is reported unchecked, exit 2", async () => {
  unknownType = paying.at(-1)!.hash;
  try {
    const { code, out } = await run("--blocks", "3");
    assert.equal(code, 2, out);
    assert.match(out, new RegExp(`${unknownType} \\(type 0x63\\): a type this doesn't rebuild`));
  } finally {
    unknownType = undefined;
  }
});

test("a node that rate-limits inside its JSON-RPC replies is asked again", async () => {
  rateLimits = 2;
  const { code, out } = await run("--blocks", "1");
  assert.equal(code, 0, out);
  assert.equal(rateLimits, 0);
});

test("--chain base audits the node its environment variable names", async () => {
  const { code, stdout, stderr } = await runChains(["base"], "--chain", "base", "--blocks", String(blocks.length));
  assert.equal(code, 0, stderr);
  assert.match(stdout, new RegExp(`^${blocks.length} blocks on Base \\(chain 8453\\), ${blocks[0].number} to ${latest}: `));
});

test("a preset whose node serves another chain fails, and the other chains still run", async () => {
  const { code, stdout, stderr } = await runChains(["base", "optimism"], "--chain", "optimism,base", "--blocks", "2");
  assert.equal(code, 2, stderr);
  assert.match(stderr, /op-fee-audit: optimism: the node serves chain 8453, not OP Mainnet \(chain 10\)/);
  assert.match(stdout, /^2 blocks on Base \(chain 8453\)/);
  assert.doesNotMatch(stderr, /127\.0\.0\.1/, "the URL may carry an API key: name the preset instead");
});

test("with several chains, --json prints an array, and a mismatch outranks a failed chain", async () => {
  tamperedFee = paying.at(-1)!.hash;
  try {
    const { code, stdout, stderr } = await runChains(["base", "optimism"], "--chain", "base,optimism", "--blocks", "2", "--json");
    assert.equal(code, 1, stderr);
    const reports = JSON.parse(stdout);
    assert.equal(reports.length, 1);
    assert.equal(reports[0].chainId, 8453);
    assert.equal(reports[0].mismatches[0].hash, tamperedFee);
  } finally {
    tamperedFee = undefined;
  }
});

test("--chain all audits every mainnet and no testnet", async () => {
  const mainnets = ["base", "optimism", "unichain", "ink", "soneium", "worldchain", "mode", "zora", "lisk"];
  const { code, stdout, stderr } = await runChains([...mainnets, "op-sepolia", "base-sepolia"], "--chain", "all", "--blocks", "1");
  assert.equal(code, 2, stderr);
  assert.match(stdout, /^1 blocks on Base/);
  const failed = [...stderr.matchAll(/op-fee-audit: ([a-z-]+): the node serves chain 8453/g)].map((m) => m[1]);
  assert.deepEqual(failed, mainnets.slice(1));
});

test("bad arguments and an unreachable node exit 2", async () => {
  for (const args of [["--chain", "mars"], ["--chain", "base,"]]) {
    const bad = await runChains(["base"], ...args);
    assert.equal(bad.code, 2, `${args}: ${bad.stderr}`);
    assert.match(bad.stderr, /usage: op-fee-audit/);
  }
  const both = await runChains(["base"], "--chain", "base", "--rpc", RPC);
  assert.equal(both.code, 2, both.stderr);
  assert.match(both.stderr, /--rpc and --chain don't go together/);
  for (const args of [["--blocks", "0"], ["--blocks", "201"], ["--blocks", "many"]]) {
    const bad = await run(...args);
    assert.equal(bad.code, 2, `${args}: ${bad.out}`);
    assert.match(bad.out, /usage: op-fee-audit/);
  }
  const closed = await new Promise<{ code: number; out: string }>((resolve) =>
    execFile(process.execPath, [MAIN, "--rpc", "http://127.0.0.1:1"], (error, stdout, stderr) => resolve({ code: error ? Number(error.code) : 0, out: stdout + stderr })),
  );
  assert.equal(closed.code, 2, closed.out);
});
