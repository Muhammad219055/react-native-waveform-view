const path = require('path');
const {getDefaultConfig, mergeConfig} = require('@react-native/metro-config');

const root = path.resolve(__dirname, '..');
const exampleNodeModules = path.resolve(__dirname, 'node_modules');

const config = {
  watchFolders: [root],
  resolver: {
    nodeModulesPaths: [exampleNodeModules],
    extraNodeModules: {
      'react-native-waveform-view': root,
      'react': path.resolve(exampleNodeModules, 'react'),
      'react-native': path.resolve(exampleNodeModules, 'react-native'),
      'react-native-reanimated': path.resolve(exampleNodeModules, 'react-native-reanimated'),
      'react-native-gesture-handler': path.resolve(exampleNodeModules, 'react-native-gesture-handler'),
      'react-native-svg': path.resolve(exampleNodeModules, 'react-native-svg'),
    },
    blockList: [
      new RegExp(`^${path.resolve(root, 'node_modules')}\\/.*`),
    ],
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
