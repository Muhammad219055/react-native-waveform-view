module.exports = {
  presets: ['module:@react-native/babel-preset'],
  plugins: [
    ['react-native-worklets/plugin', { processNestedWorklets: true }],
    ['react-native-reanimated/plugin', {}, 'reanimated'],
  ],
};
