// The OP Stack's L1 data fee since Fjord, as op-geth computes it (core/types/rollup_cost.go): the
// signed transaction's FastLZ-compressed length feeds a linear estimate of its size in a batch,
// and that size is priced at the L1 base fee and the L1 blob base fee with the chain's scalars.

/** The length of the data after FastLZ compression, as op-geth's FlzCompressLen, after Solady. */
export function flzCompressLen(ib: Uint8Array): number {
  let n = 0;
  const ht = new Uint32Array(8192);
  const u24 = (i: number) => ib[i] | (ib[i + 1] << 8) | (ib[i + 2] << 16);
  const cmp = (p: number, q: number, e: number) => {
    let l = 0;
    for (e -= q; l < e; l++) if (ib[p + l] !== ib[q + l]) e = 0;
    return l;
  };
  const literals = (r: number) => {
    n += 0x21 * Math.floor(r / 0x20);
    r %= 0x20;
    if (r !== 0) n += r + 1;
  };
  const match = (l: number) => {
    l--;
    n += 3 * Math.floor(l / 262);
    n += l % 262 >= 6 ? 3 : 2;
  };
  const hash = (v: number) => (Math.imul(2654435769 | 0, v) >>> 19) & 0x1fff;
  const setNextHash = (ip: number) => {
    ht[hash(u24(ip))] = ip;
    return ip + 1;
  };
  let a = 0;
  const ipLimit = ib.length < 13 ? 0 : ib.length - 13;
  for (let ip = a + 2; ip < ipLimit; ) {
    let r = 0;
    for (;;) {
      const s = u24(ip);
      const h = hash(s);
      r = ht[h];
      ht[h] = ip;
      const d = ip - r;
      if (ip >= ipLimit) break;
      ip++;
      if (d <= 0x1fff && s === u24(r)) break;
    }
    if (ip >= ipLimit) break;
    ip--;
    if (ip > a) literals(ip - a);
    const l = cmp(r + 3, ip + 3, ipLimit + 9);
    match(l);
    ip = setNextHash(setNextHash(ip + l));
    a = ip;
  }
  literals(ib.length - a);
  return n;
}

const INTERCEPT = -42_585_600n;
const FASTLZ_COEF = 836_500n;
const MIN_SIZE_SCALED = 100n * 1_000_000n;
const DIVISOR = 1_000_000_000_000n;

/** Fjord's estimate of the transaction's size in a batch, in bytes × 1e6, at least 100 bytes. */
export function estimatedSizeScaled(fastLzSize: number): bigint {
  const estimate = INTERCEPT + FASTLZ_COEF * BigInt(fastLzSize);
  return estimate < MIN_SIZE_SCALED ? MIN_SIZE_SCALED : estimate;
}

/** The prices a receipt records for its L1 fee. */
export interface FeeParams {
  l1BaseFee: bigint;
  l1BlobBaseFee: bigint;
  baseFeeScalar: bigint;
  blobBaseFeeScalar: bigint;
}

export interface L1Cost {
  fee: bigint;
  /** What receipts report as l1GasUsed: the estimated size at 16 gas a byte. */
  gasUsed: bigint;
  /** The part of the fee priced at the L1 base fee, the rest being the blob fee. */
  calldataPart: bigint;
}

export function l1Cost(fastLzSize: number, p: FeeParams): L1Cost {
  const size = estimatedSizeScaled(fastLzSize);
  const calldataPerByte = p.baseFeeScalar * p.l1BaseFee * 16n;
  const blobPerByte = p.blobBaseFeeScalar * p.l1BlobBaseFee;
  return { fee: (size * (calldataPerByte + blobPerByte)) / DIVISOR, gasUsed: (size * 16n) / 1_000_000n, calldataPart: (size * calldataPerByte) / DIVISOR };
}

/** Jovian's DA footprint, which receipts report as blobGasUsed: the estimated size in bytes times the chain's scalar. */
export const daFootprint = (fastLzSize: number, scalar: bigint) => (estimatedSizeScaled(fastLzSize) / 1_000_000n) * scalar;
