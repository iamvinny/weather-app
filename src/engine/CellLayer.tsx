import React from "react";
import { Atlas, useRSXformBuffer, useColorBuffer, useRectBuffer } from "@shopify/react-native-skia";
import type { SharedValue } from "react-native-reanimated";
import type { SkImage } from "@shopify/react-native-skia";
import { particleAlpha, particleFrame, particleTint, particleXform } from "./emitter";
import type { PreparedCell } from "./emitter";
import type { BlendModeName } from "./types";

type Props = {
  prepared: PreparedCell;
  image: SkImage;
  clock: SharedValue<number>;
  /** From the emitter's renderMode: "plus" for Apple's cheapAdditive. */
  blendMode?: BlendModeName;
};

/**
 * Draws one CAEmitterCell's particles as a single Skia atlas call.
 *
 * Every buffer entry is computed straight from the clock, so there is no shared
 * particle state and no per-frame allocation.
 */
export const CellLayer = ({ prepared, image, clock, blendMode = "srcOver" }: Props) => {
  const count = prepared.count;
  const imgW = image.width();
  const imgH = image.height();
  // Sprites may be one frame of a sheet, so the anchor is the frame's centre.
  const halfW = (imgW * prepared.frameW) / 2;
  const halfH = (imgH * prepared.frameH) / 2;

  const sprites = useRectBuffer(count, (val, i) => {
    "worklet";
    particleFrame(prepared, clock.value / 1000, i, imgW, imgH, val);
  });

  const transforms = useRSXformBuffer(count, (val, i) => {
    "worklet";
    particleXform(prepared, clock.value / 1000, i, halfW, halfH, val);
  });

  const colors = useColorBuffer(count, (val, i) => {
    "worklet";
    const t = clock.value / 1000;
    val[0] = particleTint(prepared, t, i, 0);
    val[1] = particleTint(prepared, t, i, 1);
    val[2] = particleTint(prepared, t, i, 2);
    val[3] = particleAlpha(prepared, t, i);
  });

  if (count === 0) return null;
  return (
    <Atlas
      image={image}
      sprites={sprites}
      transforms={transforms}
      colors={colors}
      colorBlendMode="modulate"
      blendMode={blendMode}
    />
  );
};
