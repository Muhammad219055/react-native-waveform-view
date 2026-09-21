import { useEffect, useMemo, useState } from 'react';
import { decodeWaveform, getCachedWaveform, type WaveformData } from './decode';
import { normalizeLoudness } from './normalize';

type State = { path?: string | null; waveform?: WaveformData; final?: boolean; failed?: boolean };

export type UseWaveformOptions = {
  /**
   * Show a sampled overview within about a second while the full decode runs.
   * The `detail` track only arrives with the full decode.
   */
  quickFirst?: boolean;
  bins?: number;
  /**
   * A waveform you already have (e.g. from your database), used immediately
   * instead of decoding.
   */
  stored?: WaveformData;
};

/**
 * Loads a file's waveform, normalized and ready to draw.
 *
 * If you decode at import/upload time and keep the result, pass it as
 * `stored` and the waveform renders on the first frame with no decoding.
 */
export function useWaveform(path?: string | null, options: UseWaveformOptions = {}) {
  const { quickFirst = true, bins, stored } = options;
  const ready = useMemo(
    () => stored ?? (path ? getCachedWaveform(path) : undefined),
    [path, stored],
  );
  const [state, setState] = useState<State>({});

  useEffect(() => {
    if (!path || ready) return;
    let cancelled = false;

    if (quickFirst) {
      decodeWaveform(path, { quick: true, bins }).then(
        waveform => {
          // Never let the approximate pass overwrite a finished full decode.
          if (!cancelled) {
            setState(prev => (prev.path === path && prev.final ? prev : { path, waveform }));
          }
        },
        () => {},
      );
    }

    decodeWaveform(path, { bins }).then(
      waveform => { if (!cancelled) setState({ path, waveform, final: true }); },
      () => {
        if (!cancelled) {
          setState(prev => (prev.path === path && prev.waveform ? prev : { path, failed: true }));
        }
      },
    );

    return () => { cancelled = true; };
  }, [path, ready, quickFirst, bins]);

  const current = state.path === path ? state : {};
  const raw = ready ?? current.waveform;
  const samples = useMemo(() => (raw ? normalizeLoudness(raw.overview) : undefined), [raw]);
  const detail = useMemo(
    () => (raw && raw.detail.length > 0 ? normalizeLoudness(raw.detail) : undefined),
    [raw],
  );
  const failed = !ready && Boolean(current.failed);

  return {
    /** Normalized whole-file bars, for a fixed-width waveform. */
    samples,
    /** Normalized close-up track for `<Waveform>`, once fully decoded. */
    detail,
    detailMs: raw?.detailMs,
    /** The full, unnormalized result — store this to skip decoding next time. */
    waveform: raw,
    loading: Boolean(path && !samples && !failed),
    failed,
  };
}
