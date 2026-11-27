import { createHash } from "node:crypto";

/**
 * A seeded PRNG (sfc32, seeded from sha256). Same seed and label, same sequence, on every machine and
 * Node version: no Math.random, no clock, no locale. `fork(label)` gives an independent stream, so a new
 * field in one section never shifts the values of another.
 */
export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Integer in [min, max], both inclusive. */
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  chance(probability: number): boolean;
  shuffle<T>(items: readonly T[]): T[];
  /** Lower-case hex string of `length` characters. */
  hex(length: number): string;
  fork(label: string): Rng;
}

function sfc32(a: number, b: number, c: number, d: number): () => number {
  return () => {
    a |= 0;
    b |= 0;
    c |= 0;
    d |= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

export function createRng(seed: number | string, label = "root"): Rng {
  const digest = createHash("sha256").update(`llp-synthetic|${seed}|${label}`).digest();
  const next = sfc32(
    digest.readUInt32LE(0),
    digest.readUInt32LE(4),
    digest.readUInt32LE(8),
    digest.readUInt32LE(12),
  );
  // Discard the first outputs: sfc32 mixes its state over the first few rounds.
  for (let i = 0; i < 12; i++) next();

  const rng: Rng = {
    next,
    int(min, max) {
      if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) {
        throw new RangeError(`rng.int: bad range [${min}, ${max}]`);
      }
      return min + Math.floor(next() * (max - min + 1));
    },
    pick(items) {
      if (items.length === 0) throw new RangeError("rng.pick: empty list");
      return items[Math.floor(next() * items.length)] as (typeof items)[number];
    },
    chance(probability) {
      return next() < probability;
    },
    shuffle(items) {
      const out = [...items];
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j] as (typeof out)[number], out[i] as (typeof out)[number]];
      }
      return out;
    },
    hex(length) {
      let out = "";
      while (out.length < length) out += Math.floor(next() * 16).toString(16);
      return out;
    },
    fork(childLabel) {
      return createRng(seed, `${label}/${childLabel}`);
    },
  };
  return rng;
}
