import React from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { AudioFixture, FIXTURES } from '../fixtures/fixtureList';

type AudioSelectorProps = {
  selectedFixture: AudioFixture;
  onSelect: (fixture: AudioFixture) => void;
};

export function AudioSelector({ selectedFixture, onSelect }: AudioSelectorProps) {
  return (
    <View style={styles.container}>
      <Text style={styles.label}>Select Audio Track:</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.scroll}>
        {FIXTURES.map(fixture => {
          const isSelected = fixture.id === selectedFixture.id;
          return (
            <TouchableOpacity
              key={fixture.id}
              style={[styles.item, isSelected && styles.itemSelected]}
              onPress={() => onSelect(fixture)}
            >
              <Text style={[styles.name, isSelected && styles.nameSelected]}>
                {fixture.name}
              </Text>
              <Text style={[styles.meta, isSelected && styles.metaSelected]}>
                {fixture.durationLabel} • {fixture.format}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginVertical: 10,
  },
  label: {
    color: '#CBD5E1',
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 8,
    paddingHorizontal: 4,
  },
  scroll: {
    paddingHorizontal: 4,
    gap: 8,
  },
  item: {
    backgroundColor: '#1E293B',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#334155',
  },
  itemSelected: {
    backgroundColor: '#312E81',
    borderColor: '#6366F1',
  },
  name: {
    color: '#F1F5F9',
    fontSize: 13,
    fontWeight: '600',
  },
  nameSelected: {
    color: '#FFFFFF',
  },
  meta: {
    color: '#64748B',
    fontSize: 11,
    marginTop: 2,
  },
  metaSelected: {
    color: '#A5B4FC',
  },
});
