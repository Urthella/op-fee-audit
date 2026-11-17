#!/usr/bin/env node
// op-fee-audit: recomputes the L1 data fee of every transaction in an OP Stack chain's latest
// blocks, from the transaction's own bytes and the Fjord formula, and checks the receipts agree.
// Exits 1 if a receipt disagrees, 2 if transactions couldn't be checked or something failed.

import { parseArgs } from "node:util";

import { CHAINS, type Report, audit, collect, describe, exitCode } from "./audit.ts";
import { Rpc } from "./rpc.ts";

const USAGE = `usage: op-fee-audit [--rpc URL | --chain NAME[,NAME...]] [--blocks N] [--json]
  chains: ${CHAINS.map((c) => c.preset).join(", ")}, or all for every mainnet`;

const { values } = parseArgs({
  options: {
    rpc: { type: "string" },
    chain: { type: "string" },
    blocks: { type: "string", default: "10" },
    json: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});

/** A node to audit and, for a `--chain` preset, the chain it must serve. */
interface Target {
  rpc: string;
  preset?: (typeof CHAINS)[number];
}

/** The nodes to audit, or what's wrong with the arguments. */
function targets(): Target[] | string {
  if (values.chain === undefined) return [{ rpc: values.rpc ?? "https://mainnet.base.org" }];
  if (values.rpc !== undefined) return "--rpc and --chain don't go together";
  const names = values.chain === "all" ? CHAINS.filter((c) => !c.testnet).map((c) => c.preset) : values.chain.split(",");
  const out: Target[] = [];
  for (const name of names) {
    const preset = CHAINS.find((c) => c.preset === name);
    if (!preset) return `no chain called ${name}`;
    // Your own node instead of the public one: OP_FEE_AUDIT_RPC_BASE, OP_FEE_AUDIT_RPC_OP_SEPOLIA, ...
    const own = process.env[`OP_FEE_AUDIT_RPC_${name.toUpperCase().replaceAll("-", "_")}`];
    out.push({ rpc: own || preset.rpc, preset });
  }
  return out;
}

const blocks = Number(values.blocks);
const nodes = targets();
if (values.help) {
  console.error(USAGE);
} else if (!Number.isInteger(blocks) || blocks < 1 || blocks > 200) {
  console.error(`--blocks must be 1 to 200: ${values.blocks}\n${USAGE}`);
  process.exitCode = 2;
} else if (typeof nodes === "string") {
  console.error(`${nodes}\n${USAGE}`);
  process.exitCode = 2;
} else {
  const reports: Report[] = [];
  const codes: number[] = [];
  for (const node of nodes) {
    try {
      const { chainId, blocks: read } = await collect(new Rpc(node.rpc), blocks);
      if (node.preset && chainId !== node.preset.chainId) throw new Error(`the node serves chain ${chainId}, not ${node.preset.name} (chain ${node.preset.chainId})`);
      const report = audit(chainId, read);
      if (!values.json) console.log(`${reports.length ? "\n" : ""}${describe(report)}`);
      reports.push(report);
      codes.push(exitCode(report));
    } catch (error) {
      // The preset's name rather than the URL, which may carry an API key.
      console.error(`op-fee-audit: ${node.preset ? `${node.preset.preset}: ` : ""}${(error as Error).message}`);
      codes.push(2);
    }
  }
  if (values.json && reports.length) console.log(JSON.stringify(nodes.length > 1 ? reports : reports[0], null, 2));
  // A receipt that disagrees outranks a chain that couldn't be read. Not process.exit(): it can
  // trip a libuv assertion on Windows.
  process.exitCode = codes.includes(1) ? 1 : Math.max(0, ...codes);
}
