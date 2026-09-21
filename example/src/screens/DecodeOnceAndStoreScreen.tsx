import React, { useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Waveform, decodeWaveform, useWaveform, type WaveformData } from 'react-native-waveform-view';
import { useSound } from 'react-native-nitro-sound';
import { AudioSelector } from '../components/AudioSelector';
import { PlayerControls } from '../components/PlayerControls';
import { FIXTURES, AudioFixture } from '../fixtures/fixtureList';

export function DecodeOnceAndStoreScreen() {
  const [selected, setSelected] = useState<AudioFixture>(FIXTURES[0]);
  const [storedDb, setStoredDb] = useState<Record<string, WaveformData>>({});
  const [isPrecomputing, setIsPrecomputing] = useState(false);
  const [precomputeTimeMs, setPrecomputeTimeMs] = useState<number | null>(null);

  const stored = storedDb[selected.path];

  // Instantly ready if stored exists in our local simulated database
  const { detail, detailMs, loading } = useWaveform(selected.path, { stored });

  const { state, startPlayer, pausePlayer, resumePlayer, seekToPlayer } =
    useSound({ subscriptionDuration: 100 });

  const durationMs = state.duration > 0 ? state.duration : 10000;
  const currentPositionMs = state.currentPosition;
  const progress = durationMs > 0 ? currentPositionMs / durationMs : 0;

  const handlePrecompute = async () => {
    setIsPrecomputing(true);
    const start = Date.now();
    try {
      const result = await decodeWaveform(selected.path);
      setStoredDb(prev => ({ ...prev, [selected.path]: result }));
      setPrecomputeTimeMs(Date.now() - start);
    } catch {
      // Decode error
    } finally {
      setIsPrecomputing(false);
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.screenTitle}>Decode-Once-And-Store</Text>
      <Text style={styles.screenDescription}>
        Demonstrates pre-computed caching: store the numbers in your database on upload, and render
        instantly on the first frame with no decoding when the user opens the screen.
      </Text>

      <AudioSelector selectedFixture={selected} onSelect={setSelected} />

      <View style={styles.actionRow}>
        <TouchableOpacity
          style={[styles.precomputeButton, isPrecomputing && styles.precomputeButtonDisabled]}
          onPress={handlePrecompute}
          disabled={isPrecomputing}
        >
          <Text style={styles.precomputeText}>
            {isPrecomputing ? 'Precomputing...' : stored ? '✓ Precomputed (Stored in DB)' : '⚡ Precompute for Instant Render'}
          </Text>
        </TouchableOpacity>
      </View>

      {precomputeTimeMs !== null && (
        <Text style={styles.timingNote}>Precomputed in {(precomputeTimeMs / 1000).toFixed(2)}s</Text>
      )}

      <View style={styles.waveformContainer}>
        {stored && detail && detail.length > 0 ? (
          <Waveform
            detail={detail}
            detailMs={detailMs || 100}
            durationMs={durationMs}
            progress={progress}
            isPlaying={state.isPlaying}
            onSeekEnd={p => seekToPlayer(p * durationMs).catch(() => {})}
            playedColor="#10B981"
            upcomingColor="#334155"
            fadeColor="#0F172A"
          />
        ) : (
          <View style={styles.placeholder}>
            <Text style={styles.placeholderTitle}>No stored waveform for this track</Text>
            <Text style={styles.placeholderSub}>
              Tap &quot;Precompute for Instant Render&quot; above to store waveform in local DB.
            </Text>
          </View>
        )}
      </View>

      <PlayerControls
        isPlaying={state.isPlaying}
        playbackRate={1.0}
        currentPositionMs={currentPositionMs}
        durationMs={durationMs}
        onTogglePlay={() => {
          if (state.isPlaying) pausePlayer().catch(() => {});
          else resumePlayer().catch(() => startPlayer(selected.path).catch(() => {}));
        }}
        onRateChange={() => {}}
        onRestart={() => seekToPlayer(0).catch(() => {})}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: 16,
  },
  screenTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#F8FAFC',
    marginBottom: 4,
  },
  screenDescription: {
    fontSize: 13,
    color: '#94A3B8',
    lineHeight: 18,
    marginBottom: 12,
  },
  actionRow: {
    marginVertical: 8,
  },
  precomputeButton: {
    backgroundColor: '#059669',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 8,
    alignItems: 'center',
  },
  precomputeButtonDisabled: {
    opacity: 0.6,
  },
  precomputeText: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 14,
  },
  timingNote: {
    color: '#34D399',
    fontSize: 12,
    textAlign: 'center',
    marginBottom: 8,
  },
  waveformContainer: {
    minHeight: 120,
    justifyContent: 'center',
    backgroundColor: '#0F172A',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#334155',
    paddingVertical: 20,
    marginVertical: 8,
  },
  placeholder: {
    alignItems: 'center',
    padding: 20,
  },
  placeholderTitle: {
    color: '#E2E8F0',
    fontWeight: '600',
    fontSize: 14,
  },
  placeholderSub: {
    color: '#64748B',
    fontSize: 12,
    marginTop: 4,
    textAlign: 'center',
  },
});
