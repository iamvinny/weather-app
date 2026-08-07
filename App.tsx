import React, { useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import Animated, {
  Extrapolation,
  interpolate,
  runOnJS,
  useAnimatedReaction,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
} from "react-native-reanimated";
import { StatusBar } from "expo-status-bar";
import { WeatherScene } from "./src/engine/WeatherScene";
import { SCENES, spritesFor } from "./src/engine/assets";
import { useSprites } from "./src/engine/useSprites";

/** Scroll distance over which the background collapses into the header. */
const COLLAPSE_RANGE = 320;
const HEADER_MIN = 150;
/** Past this fraction of the collapse, the scene switches to its Mini state. */
const MINI_AT = 0.55;

export default function App() {
  const { width, height } = useWindowDimensions();
  const [sceneName, setSceneName] = useState("rain_night");
  const [state, setState] = useState("Full");

  const scene = SCENES[sceneName];
  const names = useMemo(() => spritesFor(scene), [scene]);
  const images = useSprites(names);
  const ready = names.every((n) => images[n]);

  const scrollY = useSharedValue(0);
  const onScroll = useAnimatedScrollHandler((e) => {
    scrollY.value = e.contentOffset.y;
  });

  // Height of the visible header, shared with the Skia scene so it can align
  // itself to the bottom of whatever is currently on screen.
  const headerHeight = useDerivedValue(() =>
    interpolate(scrollY.value, [0, COLLAPSE_RANGE], [height, HEADER_MIN], Extrapolation.CLAMP)
  );

  const headerStyle = useAnimatedStyle(() => ({ height: headerHeight.value }));

  useAnimatedReaction(
    () => scrollY.value > COLLAPSE_RANGE * MINI_AT,
    (collapsed, prev) => {
      // Also runs on mount (prev === null), so a view that starts scrolled
      // lands in the right state rather than defaulting to Full.
      if (collapsed !== prev) runOnJS(setState)(collapsed ? "Mini" : "Full");
    }
  );

  return (
    <View style={styles.root}>
      <StatusBar style="light" />
      {/* The .caml scenes carry precipitation and lighting only; the sky itself
          ships as a flat backdrop, so we supply the night colour here. */}
      <View style={styles.sky} />

      <Animated.View style={[styles.header, headerStyle]}>
        {ready && (
          <WeatherScene
            scene={scene}
            images={images}
            width={width}
            canvasHeight={height}
            viewHeight={headerHeight}
            state={state}
          />
        )}
      </Animated.View>

      <Animated.ScrollView
        style={StyleSheet.absoluteFill}
        onScroll={onScroll}
        scrollEventThrottle={16}
        showsVerticalScrollIndicator={false}
      >
        {/* Sized so the sheet meets the header exactly at full collapse. */}
        <View style={{ height: HEADER_MIN + COLLAPSE_RANGE }} pointerEvents="box-none">
          <View style={styles.summary}>
            <Text style={styles.city}>Cupertino</Text>
            <Text style={styles.temp}>12°</Text>
            <Text style={styles.cond}>{scene.name.split("@")[0].replace(/_/g, " ")}</Text>
          </View>
        </View>

        <View style={styles.sheet}>
          <Text style={styles.hint}>Scroll to collapse the background into the header.</Text>
          <Text style={styles.label}>SCENE</Text>
          <View style={styles.row}>
            {Object.keys(SCENES).map((s) => (
              <Pressable
                key={s}
                onPress={() => setSceneName(s)}
                style={[styles.chip, sceneName === s && styles.chipOn]}
              >
                <Text style={styles.chipText}>{s.replace("_", " ")}</Text>
              </Pressable>
            ))}
          </View>
          <Text style={styles.label}>STATE: {state}</Text>
          {Array.from({ length: 10 }).map((_, i) => (
            <View key={i} style={styles.card}>
              <Text style={styles.cardText}>{`${(i + 1) * 2}:00`}</Text>
              <Text style={styles.cardText}>{11 + (i % 4)}°</Text>
            </View>
          ))}
        </View>
      </Animated.ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#0b1420" },
  sky: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "#101d2e" },
  header: { position: "absolute", top: 0, left: 0, right: 0, overflow: "hidden" },
  summary: { alignItems: "center", paddingTop: 72 },
  city: { color: "#fff", fontSize: 34, fontWeight: "300" },
  temp: { color: "#fff", fontSize: 92, fontWeight: "200" },
  cond: { color: "rgba(255,255,255,0.7)", fontSize: 18 },
  sheet: {
    backgroundColor: "rgba(10,22,38,0.75)",
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    padding: 20,
    gap: 12,
    minHeight: 700,
  },
  hint: { color: "rgba(255,255,255,0.55)", fontSize: 13 },
  label: { color: "rgba(255,255,255,0.55)", fontSize: 12, letterSpacing: 1, marginTop: 8 },
  row: { flexDirection: "row", gap: 8 },
  chip: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.12)",
  },
  chipOn: { backgroundColor: "rgba(255,255,255,0.32)" },
  chipText: { color: "#fff", fontSize: 13, fontWeight: "600" },
  card: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(255,255,255,0.12)",
  },
  cardText: { color: "#fff", fontSize: 16 },
});
