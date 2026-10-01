/** Deterministic PRNG (mulberry32) so a saved/inherited run can be replayed with the exact same
 * sequence of "random" events instead of drawing fresh ones from Math.random() every time. */
export function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A fresh seed for runs that aren't replaying an inherited snapshot. */
export function randomSeed(): number {
  return Math.floor(Math.random() * 0xffffffff);
}
