/**
 * Decoded values are perceptual loudness on 0..1 (= -80..0 dBFS). Drawing
 * them directly makes every waveform look different depending on how loud the
 * recording was, so map them onto a fixed range below the file's loudest bar
 * — the standard way level displays work. A pause 40 dB down reads as a
 * minimum bar, and recording gain no longer changes the shape.
 */
const DISPLAY_RANGE = 0.5; // 40 dB of the 80 dB scale.
const MIN_LEVEL = 0.06;
/** Loudest bar quieter than -60 dBFS: effectively silence, keep it flat. */
const SILENCE = 0.25;

export function normalizeLoudness(values: readonly number[]): number[] {
  // A loop, not Math.max(...values): detail tracks hold tens of thousands of
  // values, beyond the argument limit of a spread call.
  let loudest = 0;
  for (const value of values) if (value > loudest) loudest = value;
  if (loudest < SILENCE) return values.map(() => MIN_LEVEL);
  return values.map(value => {
    const level = Math.max(0, Math.min(1, (value - (loudest - DISPLAY_RANGE)) / DISPLAY_RANGE));
    return MIN_LEVEL + (1 - MIN_LEVEL) * level;
  });
}
