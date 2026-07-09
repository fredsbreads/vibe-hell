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

  /**
   * Resets this SAME instance back to a fresh seed, in place - rather than
   * every holder of a reference to this object replacing it with `new
   * SeededRandom(seed)` themselves. Enemy instances each keep their own
   * direct reference to TimeManager's rng (captured once, at construction,
   * for the pool's whole lifetime - see TimeManager's constructor); if
   * TimeManager.reset() reassigned `this.rng` to a brand new object instead
   * of reseeding this one, every already-constructed Enemy would keep
   * reading from the OLD (still-advancing) instance while TimeManager's own
   * draws (spawn position, projectile kind) used the new one - two
   * different streams masquerading as one, which is exactly what broke
   * death-replay fidelity (aim imperfection reproducing the wrong values).
   */
  reseed(seed: number): void {
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
