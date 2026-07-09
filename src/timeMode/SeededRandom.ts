/**
 * Small deterministic PRNG (mulberry32) - swapped in for Math.random() at
 * every point that affects a run's actual simulation (enemy kind, spawn
 * position, aim imperfection - see TimeManager/Enemy), so a recorded run
 * can be replayed bit-for-bit: the same seed plus the same recorded input
 * stream always reproduces the exact same enemies/projectiles/misses, not
 * just a visually similar run. Not cryptographic - gameplay RNG only.
 */
export class SeededRandom {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform float in [min, max). */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }
}

/** A fresh, non-deterministic seed for a normal (non-replay) run - Date.now() mixed with Math.random() so two runs started in the same millisecond still diverge. */
export function randomSeed(): number {
  return (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
}
