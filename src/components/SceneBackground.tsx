import React, { useMemo } from "react";
import { StyleSheet, useWindowDimensions } from "react-native";
import Animated, { useAnimatedStyle, type SharedValue } from "react-native-reanimated";
import { WeatherScene } from "@/engine/WeatherScene";
import { SCENES, spritesFor } from "@/engine/assets";
import { useSprites } from "@/engine/useSprites";
import { skyFor } from "@/constants/sky";

type Props = {
  sceneName: keyof typeof SCENES | string;
  /** "Full" is the expanded background; "Mini" is the collapsed header. */
  state: string;
  /** Current header height, driven by scroll. */
  headerHeight: SharedValue<number>;
};

/**
 * The scene, clipped to a header whose height follows the scroll position.
 *
 * The canvas stays full-height while this view shrinks and clips, so the scene
 * can align itself to the bottom of whatever is currently visible.
 */
export const SceneBackground = ({ sceneName, state, headerHeight }: Props) => {
  const { width, height } = useWindowDimensions();
  const scene = SCENES[sceneName];

  const names = useMemo(() => spritesFor(scene), [scene]);
  const images = useSprites(names);
  const ready = names.every((n) => images[n]);

  const headerStyle = useAnimatedStyle(() => ({ height: headerHeight.value }));

  return (
    <Animated.View style={[styles.header, headerStyle]}>
      {ready && (
        <WeatherScene
          scene={scene}
          images={images}
          width={width}
          canvasHeight={height}
          viewHeight={headerHeight}
          state={state}
          sky={skyFor(sceneName)}
        />
      )}
    </Animated.View>
  );
};

const styles = StyleSheet.create({
  header: { position: "absolute", top: 0, left: 0, right: 0, overflow: "hidden" },
});
