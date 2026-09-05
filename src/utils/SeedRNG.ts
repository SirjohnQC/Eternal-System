/**
 * Deterministic seeded pseudo-random number generator.
 * Algorithm: mulberry32 — fast, high quality, 32-bit state.
 * All universe generation MUST use this. Never call Math.random() in simulation code.
 */
export class SeedRNG {
  private state: number;

  constructor(seed: string | number) {
    this.state = typeof seed === 'string' ? SeedRNG.hashString(seed) : seed >>> 0;
  }

  /** Returns a float in [0, 1) */
  next(): number {
    this.state |= 0;
    this.state = this.state + 0x6d2b79f5 | 0;
    let z = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    z = z + Math.imul(z ^ (z >>> 7), 61 | z) ^ z;
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  }

  /** Returns an integer in [min, max] inclusive */
  nextInt(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }

  /** Returns a float in [min, max) */
  nextFloat(min: number, max: number): number {
    return this.next() * (max - min) + min;
  }

  /** Returns true with the given probability [0, 1] */
  chance(probability: number): boolean {
    return this.next() < probability;
  }

  /** Picks a random element from an array */
  pick<T>(array: T[]): T {
    return array[this.nextInt(0, array.length - 1)];
  }

  /** Rolls a D20 */
  d20(): number {
    return this.nextInt(1, 20);
  }

  /** Returns the current internal state for serialisation */
  getState(): number { return this.state; }

  /** Restores a previously saved state */
  setState(state: number): void { this.state = state >>> 0; }

  /** Fork a child RNG from a namespaced seed — keeps generation independent per system */
  fork(namespace: string): SeedRNG {
    return new SeedRNG(SeedRNG.hashString(this.state.toString() + namespace));
  }

  static hashString(str: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }
}
