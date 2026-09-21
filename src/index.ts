export { default as Waveform, DEFAULT_WAVEFORM_GRADIENT, resampleDetail } from './Waveform';
export type {
  WaveformProps,
  WaveformGradient,
  WaveformGradientConfig,
  WaveformGradientStop,
  WaveformHandlePreset,
  WaveformPlayheadPreset,
} from './Waveform';
export {
  decodeWaveform,
  getDurationSeconds,
  cacheWaveform,
  getCachedWaveform,
  clearWaveformCache,
  isValidWaveform,
  DEFAULT_BINS,
  DETAIL_MS,
  type WaveformData,
  type DecodeOptions,
} from './decode';
export { useWaveform, type UseWaveformOptions } from './useWaveform';
export { normalizeLoudness } from './normalize';
