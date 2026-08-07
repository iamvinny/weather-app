module.exports = function (api) {
  api.cache(true);
  return {
    presets: ["babel-preset-expo"],
    // Reanimated 4 compiles "worklet" functions through react-native-worklets.
    plugins: ["react-native-worklets/plugin"],
  };
};
