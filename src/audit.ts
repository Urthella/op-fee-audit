// Audits the latest blocks of an OP Stack chain: every transaction is rebuilt from its fields and
// must hash to its own hash, and its receipt's L1 fee, L1 gas used and DA footprint must be what
// the Fjord formula gives from the rebuilt bytes and the prices the receipt records.

import { type FeeParams, daFootprint, estimatedSizeScaled, flzCompressLen, l1Cost } from "./fee.ts";
import type { Rpc } from "./rpc.ts";
import { type Transaction, hashesTo, rawTransaction } from "./tx.ts";

export interface Receipt {
  transactionHash: string;
  l1Fee?: string;
  l1GasUsed?: string;
  l1GasPrice?: string;
  l1BlobBaseFee?: string;
  l1BaseFeeScalar?: string;
  l1BlobBaseFeeScalar?: string;
  daFootprintGasScalar?: string;
  blobGasUsed?: string;
}

export interface Block {
  number: number;
  transactions: Transaction[];
  receipts: Receipt[];
}

export const CHAINS: Record<number, string> = { 10: "OP Mainnet", 8453: "Base", 130: "Unichain", 57073: "Ink", 1868: "Soneium", 480: "World Chain", 34443: "Mode", 7777777: "Zora", 1135: "Lisk", 11155420: "OP Sepolia", 84532: "Base Sepolia" };

// Small: OP Mainnet's public endpoint answers bigger batches with HTTP 413.
const RECEIPT_BATCH = 10;

async function receipts(rpc: Rpc, block: { number: string; transactions: Transaction[] }): Promise<Receipt[]> {
  try {
    return await rpc.call<Receipt[]>("eth_getBlockReceipts", [block.number]);
  } catch {
    // Some public endpoints don't allow eth_getBlockReceipts: ask for each receipt, in batches.
    const out: Receipt[] = [];
    for (let i = 0; i < block.transactions.length; i += RECEIPT_BATCH) {
      out.push(...(await rpc.batch<Receipt>(block.transactions.slice(i, i + RECEIPT_BATCH).map((tx) => ({ method: "eth_getTransactionReceipt", params: [tx.hash] })))));
    }
    return out;
  }
}

export async function collect(rpc: Rpc, count: number): Promise<{ chainId: number; blocks: Block[] }> {
  const [chainId, latest] = await rpc.batch<string>([{ method: "eth_chainId", params: [] }, { method: "eth_blockNumber", params: [] }]);
  const blocks: Block[] = [];
  for (let n = Number(latest) - count + 1; n <= Number(latest); n++) {
    const block = await rpc.call<{ number: string; transactions: Transaction[] }>("eth_getBlockByNumber", [`0x${n.toString(16)}`, true]);
    blocks.push({ number: n, transactions: block.transactions, receipts: await receipts(rpc, block) });
  }
  return { chainId: Number(chainId), blocks };
}

export interface Report {
  chainId: number;
  chain: string;
  first: number;
  last: number;
  transactions: number;
  deposits: number;
  /** Transactions of a type the rebuild doesn't know, or whose rebuilt bytes don't hash to their hash. */
  unchecked: { hash: string; type: string; reason: string }[];
  checked: number;
  mismatches: { hash: string; field: "l1Fee" | "l1GasUsed" | "blobGasUsed"; expected: string; receipt: string }[];
  /** Checked receipts that carry Jovian's DA footprint scalar. */
  footprints: number;
  atFloor: number;
  medianSize: number;
  medianFee: string;
  /** Of all L1 fees paid, the share priced at the L1 base fee rather than the blob base fee. */
  calldataShare: number;
  scalars?: { baseFee: string; blobBaseFee: string };
}

const median = (values: bigint[]) => [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))[Math.floor((values.length - 1) / 2)] ?? 0n;

export function audit(chainId: number, blocks: Block[]): Report {
  const report: Report = {
    chainId,
    chain: CHAINS[chainId] ?? `chain ${chainId}`,
    first: blocks[0]?.number ?? 0,
    last: blocks.at(-1)?.number ?? 0,
    transactions: 0,
    deposits: 0,
    unchecked: [],
    checked: 0,
    mismatches: [],
    footprints: 0,
    atFloor: 0,
    medianSize: 0,
    medianFee: "0",
    calldataShare: 0,
  };
  const sizes: bigint[] = [];
  const fees: bigint[] = [];
  let calldata = 0n;
  let total = 0n;
  for (const block of blocks) {
    const byHash = new Map(block.receipts.map((r) => [r.transactionHash, r]));
    for (const tx of block.transactions) {
      report.transactions++;
      if (Number(tx.type) === 0x7e) {
        report.deposits++;
        continue;
      }
      const raw = rawTransaction(tx);
      const receipt = byHash.get(tx.hash);
      if (!raw || !hashesTo(raw, tx.hash) || !receipt?.l1Fee) {
        report.unchecked.push({ hash: tx.hash, type: tx.type, reason: !raw ? "a type this doesn't rebuild" : !receipt?.l1Fee ? "no L1 fee in the receipt" : "the rebuilt bytes don't hash to the transaction's hash" });
        continue;
      }
      report.checked++;
      const params: FeeParams = { l1BaseFee: BigInt(receipt.l1GasPrice!), l1BlobBaseFee: BigInt(receipt.l1BlobBaseFee!), baseFeeScalar: BigInt(receipt.l1BaseFeeScalar!), blobBaseFeeScalar: BigInt(receipt.l1BlobBaseFeeScalar!) };
      const fastLz = flzCompressLen(raw);
      const cost = l1Cost(fastLz, params);
      const compare = (field: Report["mismatches"][number]["field"], expected: bigint, actual: string) => {
        if (expected !== BigInt(actual)) report.mismatches.push({ hash: tx.hash, field, expected: String(expected), receipt: String(BigInt(actual)) });
      };
      compare("l1Fee", cost.fee, receipt.l1Fee);
      compare("l1GasUsed", cost.gasUsed, receipt.l1GasUsed!);
      if (receipt.daFootprintGasScalar !== undefined && receipt.blobGasUsed !== undefined) {
        report.footprints++;
        compare("blobGasUsed", daFootprint(fastLz, BigInt(receipt.daFootprintGasScalar)), receipt.blobGasUsed);
      }
      const size = estimatedSizeScaled(fastLz);
      sizes.push(size / 1_000_000n);
      if (size === 100n * 1_000_000n) report.atFloor++;
      fees.push(cost.fee);
      calldata += cost.calldataPart;
      total += cost.fee;
      report.scalars = { baseFee: String(params.baseFeeScalar), blobBaseFee: String(params.blobBaseFeeScalar) };
    }
  }
  report.medianSize = Number(median(sizes));
  report.medianFee = String(median(fees));
  report.calldataShare = total ? Number((calldata * 10_000n) / total) / 10_000 : 0;
  return report;
}

/** 0 when every check holds, 1 when a receipt disagrees with the formula, 2 when transactions couldn't be checked. */
export const exitCode = (report: Report) => (report.mismatches.length ? 1 : report.unchecked.length ? 2 : 0);

const number = (n: number | bigint | string) => BigInt(n).toLocaleString("en-US");
const gwei = (wei: bigint) => (Number(wei) / 1e9).toLocaleString("en-US", { maximumFractionDigits: 2 });

export function describe(report: Report): string {
  const blocks = report.last - report.first + 1;
  const lines = [`${blocks} blocks on ${report.chain} (chain ${report.chainId}), ${report.first} to ${report.last}: ${number(report.transactions)} transactions, ${number(report.deposits)} of them deposits`];
  const rebuilt = report.checked + report.unchecked.filter((u) => u.reason.includes("hash")).length;
  lines.push(`  check: ${number(report.checked)} of ${number(rebuilt)} rebuilt transactions hash to their own hash`);
  for (const u of report.unchecked.slice(0, 5)) lines.push(`    ${u.hash} (type ${u.type}): ${u.reason}`);
  const off = (field: string) => report.mismatches.filter((m) => m.field === field).length;
  const footprint = report.footprints ? `; the DA footprint on ${number(report.footprints - off("blobGasUsed"))} of ${number(report.footprints)}` : "";
  lines.push(`  check: the L1 fee matches the Fjord formula on ${number(report.checked - off("l1Fee"))} of ${number(report.checked)} receipts; l1GasUsed on ${number(report.checked - off("l1GasUsed"))} of ${number(report.checked)}${footprint}`);
  for (const m of report.mismatches.slice(0, 5)) lines.push(`    ${m.hash}: ${m.field} should be ${number(m.expected)}, the receipt has ${number(m.receipt)}`);
  if (report.checked) {
    lines.push(`  estimated batch size: median ${report.medianSize} bytes; ${number(report.atFloor)} transactions at the 100-byte floor`);
    lines.push(`  L1 fee: median ${gwei(BigInt(report.medianFee))} gwei; ${(report.calldataShare * 100).toFixed(1)}% of all L1 fees priced at the L1 base fee, the rest at the blob base fee`);
  }
  if (report.scalars) lines.push(`  scalars: ${number(report.scalars.baseFee)} on the L1 base fee, ${number(report.scalars.blobBaseFee)} on the blob base fee`);
  return lines.join("\n");
}
