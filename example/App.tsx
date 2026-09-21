import React, { useState } from 'react';
import {
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { DecodeOnOpenScreen } from './src/screens/DecodeOnOpenScreen';
import { DecodeOnceAndStoreScreen } from './src/screens/DecodeOnceAndStoreScreen';
import { DisplayOnlyScreen } from './src/screens/DisplayOnlyScreen';
import { ParityCheckScreen } from './src/screens/ParityCheckScreen';

type ScreenKey = 'decode_on_open' | 'store_and_load' | 'display_only' | 'parity_check';

const TABS: { key: ScreenKey; label: string }[] = [
  { key: 'decode_on_open', label: 'Open' },
  { key: 'store_and_load', label: 'Store' },
  { key: 'display_only', label: 'Display' },
  { key: 'parity_check', label: 'Parity' },
];

export default function App() {
  const [activeScreen, setActiveScreen] = useState<ScreenKey>('decode_on_open');

  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaView style={styles.safeArea}>
        <StatusBar barStyle="light-content" backgroundColor="#0B0F19" />

        <View style={styles.header}>
          <Text style={styles.appTitle}>react-native-waveform-view</Text>
          <Text style={styles.appSubtitle}>Smooth, frame-accurate scrolling scrubber</Text>
        </View>

        <View style={styles.tabBar}>
          {TABS.map(tab => {
            const isActive = tab.key === activeScreen;
            return (
              <TouchableOpacity
                key={tab.key}
                style={[styles.tabItem, isActive && styles.tabItemActive]}
                onPress={() => setActiveScreen(tab.key)}
              >
                <Text style={[styles.tabLabel, isActive && styles.tabLabelActive]}>
                  {tab.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        <ScrollView contentContainerStyle={styles.content}>
          {activeScreen === 'decode_on_open' && <DecodeOnOpenScreen />}
          {activeScreen === 'store_and_load' && <DecodeOnceAndStoreScreen />}
          {activeScreen === 'display_only' && <DisplayOnlyScreen />}
          {activeScreen === 'parity_check' && <ParityCheckScreen />}
        </ScrollView>
      </SafeAreaView>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#0B0F19',
  },
  safeArea: {
    flex: 1,
  },
  header: {
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 8,
  },
  appTitle: {
    fontSize: 20,
    fontWeight: '800',
    color: '#F8FAFC',
    letterSpacing: -0.5,
  },
  appSubtitle: {
    fontSize: 12,
    color: '#64748B',
    marginTop: 2,
  },
  tabBar: {
    flexDirection: 'row',
    backgroundColor: '#1E293B',
    marginHorizontal: 16,
    marginVertical: 10,
    borderRadius: 10,
    padding: 3,
  },
  tabItem: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 8,
    alignItems: 'center',
  },
  tabItemActive: {
    backgroundColor: '#334155',
  },
  tabLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#94A3B8',
  },
  tabLabelActive: {
    color: '#FFFFFF',
  },
  content: {
    paddingBottom: 32,
  },
});
