import { normalizeLoudness } from '../src/normalize';

describe('normalizeLoudness', () => {
  it('maps silence (< 0.25 loudest) to MIN_LEVEL (0.06)', () => {
    const silent = [0.0, 0.1, 0.2, 0.24];
    const normalized = normalizeLoudness(silent);
    expect(normalized).toHaveLength(silent.length);
    expect(normalized.every(v => v === 0.06)).toBe(true);
  });

  it('normalizes loudest bar to 1.0 and floor (loudest - 0.5) to 0.06', () => {
    const values = [0.0, 0.5, 0.75, 1.0]; // loudest is 1.0, range is [0.5, 1.0]
    const normalized = normalizeLoudness(values);

    // 1.0 (loudest) -> 1.0
    expect(normalized[3]).toBeCloseTo(1.0);

    // 0.75 (halfway between 0.5 and 1.0) -> 0.06 + 0.94 * 0.5 = 0.53
    expect(normalized[2]).toBeCloseTo(0.53);

    // 0.5 (bottom of 40 dB range) -> 0.06
    expect(normalized[1]).toBeCloseTo(0.06);

    // 0.0 (below 40 dB range) -> clamped to 0.06
    expect(normalized[0]).toBeCloseTo(0.06);
  });

  it('normalizes quiet and loud files with identical dynamics to identical shapes', () => {
    // Both files have peak and a sound 20 dB down (0.25 down on 0..1 scale)
    const loud = [0.75, 1.0];
    const quiet = [0.35, 0.6]; // both peaks >= SILENCE (0.25)

    const normLoud = normalizeLoudness(loud);
    const normQuiet = normalizeLoudness(quiet);

    expect(normLoud[1]).toBeCloseTo(1.0);
    expect(normQuiet[1]).toBeCloseTo(1.0);

    // 20 dB down is halfway in the 40 dB (0.5) display range
    expect(normLoud[0]).toBeCloseTo(normQuiet[0]);
    expect(normLoud[0]).toBeCloseTo(0.53);
  });

  it('handles empty array', () => {
    expect(normalizeLoudness([])).toEqual([]);
  });

  it('processes massive arrays (2-hour file at 100ms = 72,000+ bars) without stack overflow', () => {
    // 2 hours = 7,200 seconds = 72,000 bars. Let's test with 100,000 bars.
    const count = 100_000;
    const largeArray = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      largeArray[i] = (i % 100) / 100;
    }
    // Math.max(...largeArray) would fail with RangeError: Maximum call stack size exceeded
    const start = Date.now();
    const result = normalizeLoudness(largeArray as unknown as number[]);
    const duration = Date.now() - start;

    expect(result).toHaveLength(count);
    expect(duration).toBeLessThan(100); // should be fast (a few milliseconds)
  });
});
