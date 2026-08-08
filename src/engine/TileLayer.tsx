import React from "react";
import { Group, Image, ImageShader, Rect, Skia, type SkImage } from "@shopify/react-native-skia";
import { useDerivedValue, type SharedValue } from "react-native-reanimated";
import type { ImageNode } from "./types";

type Props = {
  node: ImageNode;
  image: SkImage;
  clock: SharedValue<number>;
};

/**
 * A CALayer with image contents. When `tiled`, the source repeats across the
 * layer's (much larger than screen) bounds; an attached keyframe animation
 * scrolls it to sell drifting motion behind the particles. `node.matrix`
 * carries the layer's transform chain — the perspective-tilted cloud planes —
 * and wraps the scroll, so the slide happens in the layer's own space and the
 * loop stays seamless.
 */
export const TileLayer = ({ node, image, clock }: Props) => {
  const [x, y, w, h] = node.frame;
  const scroll = node.scroll;

  const matrix = node.matrix ?? undefined;

  const transform = useDerivedValue(() => {
    if (!scroll) return [{ translateX: 0 }];
    const period = scroll.duration / (scroll.speed || 1);
    const u = ((clock.value / 1000) % period) / period;
    return [{ translateX: scroll.dx * u }, { translateY: scroll.dy * u }];
  }, [scroll]);

  if (!node.tiled) {
    return (
      <Group matrix={matrix}>
        <Group transform={transform}>
          <Image image={image} x={x} y={y} width={w} height={h} opacity={node.opacity} fit="fill" />
        </Group>
      </Group>
    );
  }

  const tw = image.width() / (node.contentsScale || 1);
  const th = image.height() / (node.contentsScale || 1);

  return (
    <Group matrix={matrix}>
      <Group transform={transform} opacity={node.opacity}>
        <Rect x={x} y={y} width={w} height={h}>
          <ImageShader
            image={image}
            tx="repeat"
            ty="repeat"
            fit="none"
            rect={Skia.XYWHRect(x, y, tw, th)}
          />
        </Rect>
      </Group>
    </Group>
  );
};
