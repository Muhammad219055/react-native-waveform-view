import React, {useEffect, useState} from 'react';
import {ActivityIndicator, StyleSheet, Text, View} from 'react-native';
import {Waveform, useWaveform} from 'react-native-waveform-view';
import {useSound} from 'react-native-nitro-sound';
import {AudioSelector} from '../components/AudioSelector';
import {PlayerControls} from '../components/PlayerControls';
import {FIXTURES, AudioFixture} from '../fixtures/fixtureList';

export function DecodeOnOpenScreen() {
  const [selected, setSelected] = useState<AudioFixture>(FIXTURES[0]);
  const [playbackRate, setPlaybackRate] = useState(1.0);
  const [isSeeking, setIsSeeking] = useState(false);
  const [decodeDurationMs, setDecodeDurationMs] = useState<number | null>(null);

  const {
    sound,
    state,
    startPlayer,
    pausePlayer,
    resumePlayer,
    seekToPlayer,
    setPlaybackSpeed,
  } = useSound({subscriptionDuration: 100});

  const startTime = React.useRef(Date.now());
  useEffect(() => {
    startTime.current = Date.now();
    setDecodeDurationMs(null);
  }, [selected.path]);

  const {samples, detail, detailMs, loading, failed} = useWaveform(
    selected.path,
    {
      quickFirst: true,
    },
  );

  useEffect(() => {
    if (detail && decodeDurationMs === null) {
      setDecodeDurationMs(Date.now() - startTime.current);
    }
  }, [detail, decodeDurationMs]);

  // Stop audio on unmount or track change
  useEffect(() => {
    return () => {
      try {
        sound?.stopPlayer?.().catch(() => {});
      } catch {
        // Native state might already be null
      }
    };
  }, [selected.path, sound]);

  const durationMs = state.duration > 0 ? state.duration : 10000;
  const currentPositionMs = state.currentPosition;
  const progress = durationMs > 0 ? currentPositionMs / durationMs : 0;

  const handleTogglePlay = () => {
    if (state.isPlaying) {
      pausePlayer().catch(() => {});
    } else {
      resumePlayer().catch(() => {
        startPlayer(selected.path).catch(() => {});
      });
    }
  };

  const handleRateChange = (rate: number) => {
    setPlaybackRate(rate);
    setPlaybackSpeed(rate).catch(() => {});
  };

  const handleSeekEnd = (newProgress: number) => {
    setIsSeeking(false);
    seekToPlayer(newProgress * durationMs).catch(() => {});
  };

  return (
    <View style={styles.container}>
      <Text style={styles.screenTitle}>Decode-On-Open</Text>
      <Text style={styles.screenDescription}>
        Demonstrates progressive loading: immediate ~1s overview bars
        (quickFirst) followed by full 100ms detail bars.
      </Text>

      <AudioSelector selectedFixture={selected} onSelect={setSelected} />

      <View style={styles.statsCard}>
        <Text style={styles.statLabel}>
          Status:{' '}
          <Text style={styles.statValue}>
            {loading
              ? 'Decoding...'
              : detail
              ? 'Fully Decoded'
              : samples
              ? 'Quick Overview Ready'
              : 'Ready'}
          </Text>
        </Text>
        {decodeDurationMs !== null && (
          <Text style={styles.statLabel}>
            Decode Time:{' '}
            <Text style={styles.statValue}>
              {(decodeDurationMs / 1000).toFixed(2)}s
            </Text>
          </Text>
        )}
      </View>

      <View style={styles.waveformContainer}>
        {loading && !samples && !detail && (
          <View style={styles.centered}>
            <ActivityIndicator size="large" color="#8B5CF6" />
            <Text style={styles.loadingText}>
              Decoding native audio loudness...
            </Text>
          </View>
        )}

        {failed && (
          <View style={styles.centered}>
            <Text style={styles.errorText}>Failed to decode audio file.</Text>
          </View>
        )}

        {detail && detail.length > 0 && (
          <Waveform
            detail={detail}
            detailMs={detailMs || 100}
            durationMs={durationMs}
            progress={progress}
            isPlaying={state.isPlaying}
            playbackRate={playbackRate}
            isSeeking={isSeeking}
            onSeekStart={() => setIsSeeking(true)}
            onSeekEnd={handleSeekEnd}
            playedColor="#3303f5ff"
            upcomingColor="#334155"
            fadeColor="#0F172A"
          />
        )}
      </View>

      <PlayerControls
        isPlaying={state.isPlaying}
        playbackRate={playbackRate}
        currentPositionMs={currentPositionMs}
        durationMs={durationMs}
        onTogglePlay={handleTogglePlay}
        onRateChange={handleRateChange}
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
  statsCard: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    backgroundColor: '#1E293B',
    padding: 10,
    borderRadius: 8,
    marginVertical: 8,
  },
  statLabel: {
    color: '#94A3B8',
    fontSize: 12,
  },
  statValue: {
    color: '#38BDF8',
    fontWeight: '600',
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
  centered: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  loadingText: {
    color: '#A5B4FC',
    marginTop: 10,
    fontSize: 13,
  },
  errorText: {
    color: '#EF4444',
    fontSize: 13,
  },
});
