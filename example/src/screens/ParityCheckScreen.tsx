import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { decodeWaveform, type WaveformData } from 'react-native-waveform-view';
import { FIXTURES } from '../fixtures/fixtureList';

export type ParityResult = {
  fixtureId: string;
  name: string;
  format: string;
  durationMs: number;
  overviewCount: number;
  detailCount: number;
  decodeTimeMs: number;
  overviewSample: number[];
  detailSample: number[];
  meanLoudness: number;
  maxLoudness: number;
  minLoudness: number;
  error?: string;
};

export function ParityCheckScreen() {
  const [isRunning, setIsRunning] = useState(false);
  const [results, setResults] = useState<ParityResult[]>([]);
  const [progressText, setProgressText] = useState<string>('Initializing benchmark...');

  useEffect(() => {
    runVerification();
  }, []);

  const runVerification = async () => {
    setIsRunning(true);
    setResults([]);
    const testResults: ParityResult[] = [];

    // All standard fixtures + corrupted file
    const items = [
      ...FIXTURES,
      {
        id: 'corrupted',
        name: 'Corrupted MP3 File',
        durationLabel: 'Invalid',
        format: 'MP3 (Corrupted)',
        path:
          Platform.OS === 'android'
            ? '/data/data/com.waveformexample/files/fixtures/corrupted.mp3'
            : '/Users/muhammad/Desktop/rn-waveform/fixtures/corrupted.mp3',
      },
    ];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      setProgressText(`Testing (${i + 1}/${items.length}): ${item.name}...`);
      const startTime = Date.now();

      try {
        const decoded: WaveformData = await decodeWaveform(item.path);
        const elapsed = Date.now() - startTime;
        const detail = decoded.detail || [];
        const overview = decoded.samples || [];

        let sum = 0;
        let max = 0;
        let min = 1.0;
        for (const v of detail) {
          sum += v;
          if (v > max) max = v;
          if (v < min) min = v;
        }
        const mean = detail.length > 0 ? sum / detail.length : 0;

        testResults.push({
          fixtureId: item.id,
          name: item.name,
          format: item.format,
          durationMs: decoded.durationMs || 0,
          overviewCount: overview.length,
          detailCount: detail.length,
          decodeTimeMs: elapsed,
          // First 20 bars for quick inspection
          overviewSample: overview.slice(0, 20),
          detailSample: detail.slice(0, 20),
          meanLoudness: Number(mean.toFixed(4)),
          maxLoudness: Number(max.toFixed(4)),
          minLoudness: Number(min.toFixed(4)),
        });
      } catch (err: any) {
        const elapsed = Date.now() - startTime;
        testResults.push({
          fixtureId: item.id,
          name: item.name,
          format: item.format,
          durationMs: 0,
          overviewCount: 0,
          detailCount: 0,
          decodeTimeMs: elapsed,
          overviewSample: [],
          detailSample: [],
          meanLoudness: 0,
          maxLoudness: 0,
          minLoudness: 0,
          error: String(err?.message || err),
        });
      }
    }

    setResults(testResults);
    setIsRunning(false);
    setProgressText('Benchmark complete!');

    // Emit structured JSON dump for script extraction
    const payload = {
      platform: Platform.OS,
      timestamp: Date.now(),
      results: testResults,
    };
    console.log('===PARITY_DUMP_START===' + JSON.stringify(payload) + '===PARITY_DUMP_END===');
  };

  return (
    <View style={styles.container}>
      <Text style={styles.screenTitle}>Cross-Platform Parity Check</Text>
      <Text style={styles.screenDescription}>
        Decodes all audio fixtures natively on {Platform.OS.toUpperCase()} and compares duration,
        sample count, loudness normalization, and corrupted file error handling.
      </Text>

      <TouchableOpacity
        style={[styles.runButton, isRunning && styles.runButtonDisabled]}
        onPress={runVerification}
        disabled={isRunning}
      >
        {isRunning && <ActivityIndicator color="#FFFFFF" size="small" style={{ marginRight: 8 }} />}
        <Text style={styles.runButtonText}>
          {isRunning ? 'Running Verification...' : '▶ Run Parity Verification'}
        </Text>
      </TouchableOpacity>

      <Text style={styles.statusText}>{progressText}</Text>

      <View style={styles.resultsList}>
        {results.map(r => (
          <View key={r.fixtureId} style={styles.resultCard}>
            <View style={styles.resultHeader}>
              <Text style={styles.fixtureName}>{r.name}</Text>
              <Text style={styles.formatBadge}>{r.format}</Text>
            </View>

            {r.error ? (
              <Text style={styles.errorText}>
                Rejected: {r.error} (in {(r.decodeTimeMs / 1000).toFixed(2)}s)
              </Text>
            ) : (
              <View style={styles.statsGrid}>
                <Text style={styles.statLine}>
                  Duration: <Text style={styles.statVal}>{(r.durationMs / 1000).toFixed(2)}s</Text>
                </Text>
                <Text style={styles.statLine}>
                  Bars: <Text style={styles.statVal}>{r.detailCount} detail / {r.overviewCount} ovw</Text>
                </Text>
                <Text style={styles.statLine}>
                  Time: <Text style={styles.statVal}>{(r.decodeTimeMs / 1000).toFixed(2)}s</Text>
                </Text>
                <Text style={styles.statLine}>
                  Loudness Mean: <Text style={styles.statVal}>{r.meanLoudness}</Text>
                </Text>
              </View>
            )}
          </View>
        ))}
      </View>
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
  runButton: {
    flexDirection: 'row',
    backgroundColor: '#6366F1',
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 10,
  },
  runButtonDisabled: {
    opacity: 0.7,
  },
  runButtonText: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 14,
  },
  statusText: {
    color: '#A5B4FC',
    fontSize: 12,
    marginBottom: 12,
    textAlign: 'center',
  },
  resultsList: {
    marginTop: 4,
  },
  resultCard: {
    backgroundColor: '#1E293B',
    borderRadius: 8,
    padding: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#334155',
  },
  resultHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  fixtureName: {
    color: '#F8FAFC',
    fontWeight: '600',
    fontSize: 14,
  },
  formatBadge: {
    color: '#38BDF8',
    fontSize: 11,
    backgroundColor: '#0F172A',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  statsGrid: {
    marginTop: 4,
  },
  statLine: {
    color: '#94A3B8',
    fontSize: 12,
    marginBottom: 2,
  },
  statVal: {
    color: '#E2E8F0',
    fontWeight: '500',
  },
  errorText: {
    color: '#F87171',
    fontSize: 12,
  },
});
