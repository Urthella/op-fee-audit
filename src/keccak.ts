// Keccak-256 as Ethereum uses it (the original Keccak padding, not SHA-3's), which Node's crypto
// doesn't offer. Lanes are 64-bit BigInts; transactions are small, so speed doesn't matter.

const MASK = (1n << 64n) - 1n;
const RATE = 136; // bytes, for a 256-bit output

const ROUND_CONSTANTS = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n, 0x000000000000808bn, 0x0000000080000001n,
  0x8000000080008081n, 0x8000000000008009n, 0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n,
  0x000000000000800an, 0x800000008000000an, 0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
/** Rotation offsets, indexed by x + 5y. */
const ROTATIONS = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14].map(BigInt);

const rotl = (v: bigint, n: bigint) => (n === 0n ? v : ((v << n) | (v >> (64n - n))) & MASK);

function permute(a: bigint[]): void {
  for (const rc of ROUND_CONSTANTS) {
    // θ
    const c = [0, 1, 2, 3, 4].map((x) => a[x] ^ a[x + 5] ^ a[x + 10] ^ a[x + 15] ^ a[x + 20]);
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1n);
      for (let y = 0; y < 25; y += 5) a[x + y] ^= d;
    }
    // ρ and π
    const b = new Array<bigint>(25);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(a[x + 5 * y], ROTATIONS[x + 5 * y]);
    // χ
    for (let y = 0; y < 25; y += 5) for (let x = 0; x < 5; x++) a[x + y] = b[x + y] ^ (~b[((x + 1) % 5) + y] & MASK & b[((x + 2) % 5) + y]);
    // ι
    a[0] ^= rc;
  }
}

export function keccak256(data: Uint8Array): Buffer {
  const padded = Buffer.alloc(Math.floor(data.length / RATE + 1) * RATE);
  padded.set(data);
  padded[data.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;
  const state = new Array<bigint>(25).fill(0n);
  for (let block = 0; block < padded.length; block += RATE) {
    for (let i = 0; i < RATE / 8; i++) state[i] ^= padded.readBigUInt64LE(block + 8 * i);
    permute(state);
  }
  const out = Buffer.alloc(32);
  for (let i = 0; i < 4; i++) out.writeBigUInt64LE(state[i], 8 * i);
  return out;
}
