import { NativeModules } from 'react-native';

const getNative = () => NativeModules.RNWaveform;

/**
 * Loudness levels on 0..1, where 0 is -80 dBFS and 1 is 0 dBFS.
 *
 * `overview` holds `bins` bars covering the whole file — enough for a
 * fixed-width waveform. `detail` holds one value per `detailMs` (100ms) for
 * the scrubber, so bars follow individual words and pauses; it is empty for a
 * quick pass, which only produces the overview.
 */
export type WaveformData = { overview: number[]; detail: number[]; detailMs: number };

/** Bars in the overview. The native decoders accept 8..128. */
export const DEFAULT_BINS = 64;
/** One detail value per this many milliseconds. */
export const DETAIL_MS = 100;

// A decode that hangs must not leave a player stuck on a placeholder.
// A 20+ minute file can take tens of seconds to decode on a slower phone.
const FULL_TIMEOUT_MS = 120000;
const QUICK_TIMEOUT_MS = 15000;

const pending = new Map<string, Promise<WaveformData>>();
const cache = new Map<string, WaveformData>();

const isLevel = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

export function isValidWaveform(value: unknown, bins = DEFAULT_BINS): value is WaveformData {
  if (value == null || typeof value !== 'object') return false;
  const { overview, detail } = value as Partial<WaveformData>;
  return (
    Array.isArray(overview) && overview.length === bins && overview.every(isLevel) &&
    Array.isArray(detail) && detail.every(isLevel)
  );
}

export type DecodeOptions = {
  /**
   * Sample a short window per bar instead of decoding the file. Returns in
   * about a second even for long audio, but produces no `detail` track — show
   * it while the full decode runs. Quick results are never cached.
   */
  quick?: boolean;
  /** Bars in the overview (8..128). */
  bins?: number;
};

/**
 * Decodes a file's loudness on a native background thread.
 *
 * Results are cached in memory per path, and concurrent calls for the same
 * file share one decode. Persisting across launches is up to the caller:
 * store `overview`/`detail` and hand them straight to the view.
 */
export function decodeWaveform(path: string, options: DecodeOptions = {}): Promise<WaveformData> {
  const { quick = false, bins = DEFAULT_BINS } = options;
  const native = getNative();
  if (!native) {
    return Promise.reject(
      new Error(
        'rn-waveform: native module not found. Rebuild the app after installing (pod install on iOS).',
      ),
    );
  }
  const cached = cache.get(path);
  if (cached && !quick) return Promise.resolve(cached);

  const key = `${quick ? 'quick' : 'full'}:${bins}:${path}`;
  const inFlight = pending.get(key);
  if (inFlight) return inFlight;

  const request = (async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const decoded: unknown = await Promise.race([
        native.getWaveform(path, bins, quick),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Waveform decode timed out')),
            quick ? QUICK_TIMEOUT_MS : FULL_TIMEOUT_MS,
          );
        }),
      ]);
      if (!isValidWaveform(decoded, bins)) throw new Error('Invalid decoded audio waveform');
      const waveform: WaveformData = {
        overview: decoded.overview,
        detail: decoded.detail,
        detailMs: decoded.detailMs || DETAIL_MS,
      };
      if (!quick) cache.set(path, waveform);
      return waveform;
    } finally {
      if (timer) clearTimeout(timer);
    }
  })();

  pending.set(key, request);
  return request.finally(() => pending.delete(key));
}

/** Duration in seconds, read from the file's metadata. */
export function getDurationSeconds(path: string): Promise<number> {
  const native = getNative();
  if (!native) return Promise.reject(new Error('rn-waveform: native module not found.'));
  return native.getDurationSeconds(path);
}

/** Seeds the in-memory cache, e.g. from your own database. */
export function cacheWaveform(path: string, waveform: WaveformData): void {
  cache.set(path, waveform);
}

export function getCachedWaveform(path: string): WaveformData | undefined {
  return cache.get(path);
}

export function clearWaveformCache(path?: string): void {
  if (path) cache.delete(path);
  else cache.clear();
}
