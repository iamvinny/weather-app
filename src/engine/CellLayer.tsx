import React, { useMemo } from "react";
import { Atlas, Skia, useRSXformBuffer, useColorBuffer } from "@shopify/react-native-skia";
import type { SharedValue } from "react-native-reanimated";
import type { SkImage } from "@shopify/react-native-skia";
import { particleAlpha, particleXform, type PreparedCell } from "./emitter";

type Props = {
  prepared: PreparedCell;
  image: SkImage;
  clock: SharedValue<number>;
};

/**
 * Draws one CAEmitterCell's particles as a single Skia atlas call.
 *
 * Each buffer entry is computed straight from the clock, so there is no shared
 * particle state and no per-frame allocation.
 */
export const CellLayer = ({ prepared, image, clock }: Props) => {
  const count = prepared.count;
  const halfW = image.width() / 2;
  const halfH = image.height() / 2;

  const sprites = useMemo(
    () =>
      new Array(count).fill(0).map(() => Skia.XYWHRect(0, 0, image.width(), image.height())),
    [count, image]
  );

  const transforms = useRSXformBuffer(count, (val, i) => {
    "worklet";
    particleXform(prepared, clock.value / 1000, i, halfW, halfH, val);
  });

  const colors = useColorBuffer(count, (val, i) => {
    "worklet";
    val[0] = prepared.r;
    val[1] = prepared.g;
    val[2] = prepared.b;
    val[3] = particleAlpha(prepared, clock.value / 1000, i);
  });

  if (count === 0) return null;
  return (
    <Atlas
      image={image}
      sprites={sprites}
      transforms={transforms}
      colors={colors}
      colorBlendMode="modulate"
    />
  );
};
