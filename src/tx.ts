// Rebuilds a transaction's signed bytes from the fields eth_getBlockByNumber returns, in its
// EIP-2718 envelope: what op-geth compresses to estimate the transaction's data-availability size.
// Public endpoints often refuse eth_getRawTransactionByHash, and the rebuilt bytes prove themselves:
// their keccak256 must be the transaction's hash.

import { keccak256 } from "./keccak.ts";

type Rlp = Uint8Array | Rlp[];

function length(prefix: number, n: number): Buffer {
  if (n < 56) return Buffer.of(prefix + n);
  const bytes = Buffer.from(n.toString(16).padStart(n.toString(16).length + (n.toString(16).length % 2), "0"), "hex");
  return Buffer.concat([Buffer.of(prefix + 55 + bytes.length), bytes]);
}

export function rlp(item: Rlp): Buffer {
  if (item instanceof Uint8Array) {
    if (item.length === 1 && item[0] < 0x80) return Buffer.from(item);
    return Buffer.concat([length(0x80, item.length), item]);
  }
  const body = Buffer.concat(item.map(rlp));
  return Buffer.concat([length(0xc0, body.length), body]);
}

/** A hex quantity as minimal big-endian bytes: zero is the empty string. */
export function quantity(hex: string | undefined): Buffer {
  const n = BigInt(hex ?? "0x0");
  if (n === 0n) return Buffer.alloc(0);
  const digits = n.toString(16);
  return Buffer.from(digits.length % 2 ? `0${digits}` : digits, "hex");
}

/** Hex data as bytes; null (a contract creation's `to`) is the empty string. */
const data = (hex: string | null | undefined) => Buffer.from((hex ?? "0x").slice(2), "hex");

export interface Transaction {
  hash: string;
  type: string;
  chainId?: string;
  nonce: string;
  gas: string;
  gasPrice?: string;
  maxPriorityFeePerGas?: string;
  maxFeePerGas?: string;
  to: string | null;
  value: string;
  input: string;
  accessList?: { address: string; storageKeys: string[] }[];
  authorizationList?: { chainId: string; address: string; nonce: string; yParity: string; r: string; s: string }[];
  v?: string;
  yParity?: string;
  r: string;
  s: string;
}

export const DEPOSIT = 0x7e;

const accessList = (tx: Transaction): Rlp => (tx.accessList ?? []).map((entry) => [data(entry.address), entry.storageKeys.map(data)]);
const signature = (tx: Transaction): Rlp[] => [quantity(tx.yParity ?? tx.v), quantity(tx.r), quantity(tx.s)];

/** The signed transaction's bytes, or undefined for a deposit or a type this doesn't know. */
export function rawTransaction(tx: Transaction): Buffer | undefined {
  const type = Number(tx.type);
  const common = [quantity(tx.nonce)];
  switch (type) {
    case 0:
      return rlp([...common, quantity(tx.gasPrice), quantity(tx.gas), data(tx.to), quantity(tx.value), data(tx.input), quantity(tx.v), quantity(tx.r), quantity(tx.s)]);
    case 1:
      return Buffer.concat([Buffer.of(1), rlp([quantity(tx.chainId), ...common, quantity(tx.gasPrice), quantity(tx.gas), data(tx.to), quantity(tx.value), data(tx.input), accessList(tx), ...signature(tx)])]);
    case 2:
      return Buffer.concat([
        Buffer.of(2),
        rlp([quantity(tx.chainId), ...common, quantity(tx.maxPriorityFeePerGas), quantity(tx.maxFeePerGas), quantity(tx.gas), data(tx.to), quantity(tx.value), data(tx.input), accessList(tx), ...signature(tx)]),
      ]);
    case 4: {
      const authorizations = (tx.authorizationList ?? []).map((a) => [quantity(a.chainId), data(a.address), quantity(a.nonce), quantity(a.yParity), quantity(a.r), quantity(a.s)]);
      return Buffer.concat([
        Buffer.of(4),
        rlp([quantity(tx.chainId), ...common, quantity(tx.maxPriorityFeePerGas), quantity(tx.maxFeePerGas), quantity(tx.gas), data(tx.to), quantity(tx.value), data(tx.input), accessList(tx), authorizations, ...signature(tx)]),
      ]);
    }
    default:
      return undefined;
  }
}

/** Whether the rebuilt bytes are the transaction's own: their keccak256 is its hash. */
export const hashesTo = (raw: Uint8Array, hash: string) => `0x${keccak256(raw).toString("hex")}` === hash.toLowerCase();
