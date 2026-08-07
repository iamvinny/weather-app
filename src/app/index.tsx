import React, { useState } from "react";
import { StyleSheet, Text, View, useWindowDimensions } from "react-native";
import Animated, {
  Extrapolation,
  interpolate,
  runOnJS,
  useAnimatedReaction,
  useAnimatedScrollHandler,
  useDerivedValue,
  useSharedValue,
} from "react-native-reanimated";
import { SceneBackground } from "@/components/SceneBackground";
import { ForecastSheet } from "@/components/ForecastSheet";
import { ScenePicker } from "@/components/ScenePicker";
import { WeatherSummary } from "@/components/WeatherSummary";
import { SCENES } from "@/engine/assets";
import { skyFor } from "@/constants/sky";
import { COLLAPSE_RANGE, HEADER_MIN, MINI_AT } from "@/constants/layout";

export default function WeatherRoute() {
  const { height } = useWindowDimensions();
  const [sceneName, setSceneName] = useState("rain_night");
  const [state, setState] = useState("Full");

  const scrollY = useSharedValue(0);
  const onScroll = useAnimatedScrollHandler((e) => {
    scrollY.value = e.contentOffset.y;
  });

  // Height of the visible header, shared with the Skia scene so it can align
  // itself to the bottom of whatever is currently on screen.
  const headerHeight = useDerivedValue(() =>
    interpolate(scrollY.value, [0, COLLAPSE_RANGE], [height, HEADER_MIN], Extrapolation.CLAMP)
  );

  useAnimatedReaction(
    () => scrollY.value > COLLAPSE_RANGE * MINI_AT,
    (collapsed, prev) => {
      // Also runs on mount (prev === null), so a view that starts scrolled
      // lands in the right state rather than defaulting to Full.
      if (collapsed !== prev) runOnJS(setState)(collapsed ? "Mini" : "Full");
    }
  );

  const scene = SCENES[sceneName];

  return (
    <View style={styles.root}>
      <View style={[styles.sky, { backgroundColor: skyFor(sceneName) }]} />

      <SceneBackground sceneName={sceneName} state={state} headerHeight={headerHeight} />

      <Animated.ScrollView
        style={StyleSheet.absoluteFill}
        onScroll={onScroll}
        scrollEventThrottle={16}
        showsVerticalScrollIndicator={false}
      >
        {/* Sized so the sheet meets the header exactly at full collapse. */}
        <View style={{ height: HEADER_MIN + COLLAPSE_RANGE }} pointerEvents="box-none">
          <WeatherSummary
            city="Cupertino"
            temperature="80°"
            condition={scene.name.split("@")[0].replace(/_/g, " ")}
            high="85°"
            low="65°"
          />
        </View>

        <ForecastSheet>
          <Text style={styles.hint}>Scroll to collapse the background into the header.</Text>
          <Text style={styles.label}>SCENE ({Object.keys(SCENES).length})</Text>
          <ScenePicker
            scenes={Object.keys(SCENES)}
            selected={sceneName}
            onSelect={setSceneName}
          />
          <Text style={styles.label}>STATE: {state}</Text>
        </ForecastSheet>
      </Animated.ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#0b1420" },
  sky: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 },
  hint: { color: "rgba(255,255,255,0.55)", fontSize: 13 },
  label: { color: "rgba(255,255,255,0.55)", fontSize: 12, letterSpacing: 1, marginTop: 8 },
});
