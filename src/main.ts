#!/usr/bin/env node
// op-fee-audit: recomputes the L1 data fee of every transaction in an OP Stack chain's latest
// blocks, from the transaction's own bytes and the Fjord formula, and checks the receipts agree.
// Exits 1 if a receipt disagrees, 2 if transactions couldn't be checked or something failed.

import { parseArgs } from "node:util";

import { audit, collect, describe, exitCode } from "./audit.ts";
import { Rpc } from "./rpc.ts";

const USAGE = "usage: op-fee-audit [--rpc URL] [--blocks N] [--json]";

const { values } = parseArgs({
  options: {
    rpc: { type: "string", default: "https://mainnet.base.org" },
    blocks: { type: "string", default: "10" },
    json: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});

const blocks = Number(values.blocks);
if (values.help) {
  console.error(USAGE);
} else if (!Number.isInteger(blocks) || blocks < 1 || blocks > 200) {
  console.error(`--blocks must be 1 to 200: ${values.blocks}\n${USAGE}`);
  process.exitCode = 2;
} else {
  try {
    const { chainId, blocks: read } = await collect(new Rpc(values.rpc), blocks);
    const report = audit(chainId, read);
    console.log(values.json ? JSON.stringify(report, null, 2) : describe(report));
    // Not process.exit(): it can trip a libuv assertion on Windows.
    process.exitCode = exitCode(report);
  } catch (error) {
    console.error(`op-fee-audit: ${(error as Error).message}`);
    process.exitCode = 2;
  }
}
