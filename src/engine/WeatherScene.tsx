import React, { useMemo } from "react";
import { Canvas, Group, useClock, type SkImage } from "@shopify/react-native-skia";
import { useDerivedValue, type SharedValue } from "react-native-reanimated";
import { CellLayer } from "./CellLayer";
import { TileLayer } from "./TileLayer";
import { prepareCell } from "./emitter";
import { cellOverride, nodeOverride, resolveState } from "./states";
import type { EmitterNode, ImageNode, Scene } from "./types";

type Props = {
  scene: Scene;
  images: Record<string, SkImage | null>;
  width: number;
  /** Fixed size of the drawing surface. */
  canvasHeight: number;
  /**
   * Height actually visible right now. The scene is aligned to the bottom of
   * this, so a parent that shrinks (and clips) collapses the scene the way the
   * Weather app's header does. Defaults to the full canvas.
   */
  viewHeight?: SharedValue<number>;
  /** "Full" is the expanded background; "Mini" is the collapsed header. */
  state?: string;
};

/**
 * Renders one extracted Weather scene.
 *
 * Scenes are authored in a fixed design space (640x1136) held by a layer that
 * is anchored bottom-left and uniformly scaled to cover the device.
 */
export const WeatherScene = ({
  scene,
  images,
  width,
  canvasHeight,
  viewHeight,
  state = "Full",
}: Props) => {
  const clock = useClock();
  const [dw, dh] = scene.designSize;

  const overrides = useMemo(() => resolveState(scene, state), [scene, state]);

  const emitters = useMemo(() => {
    return scene.nodes
      .filter((n): n is EmitterNode => n.type === "emitter")
      .map((node) => {
        const emitter: EmitterNode = {
          ...node,
          birthRate: nodeOverride(overrides, node.id, "birthRate") ?? node.birthRate,
          scale: nodeOverride(overrides, node.id, "scale") ?? node.scale,
          speed: nodeOverride(overrides, node.id, "speed") ?? node.speed,
        };
        // State overrides are raw .caml values, still in the y-up design space.
        const cullY = nodeOverride(overrides, node.id, "cullRect.origin.y");
        if (cullY !== undefined && emitter.cullRect) {
          const h = emitter.cullRect[3];
          emitter.cullRect = [emitter.cullRect[0], dh - (cullY + h), emitter.cullRect[2], h];
        }
        const cells = emitter.cells
          .filter((c) => c.enabled && c.image)
          .filter((c) => cellOverride(overrides, node.id, c.name, "enabled") !== 0)
          .map((c) => {
            const rate = cellOverride(overrides, node.id, c.name, "birthRate");
            const cell = rate === undefined ? c : { ...c, birthRate: rate };
            return { cell, prepared: prepareCell(cell, emitter, scene.rotation) };
          });
        return { node: emitter, cells };
      });
  }, [scene, overrides, dh]);

  /**
   * The band of design space this state actually shows: every emitter's cull
   * rect, clipped to the canvas. `Full` leaves rects wider than the canvas and
   * so yields the whole thing; `Mini` clips to the collapsed header strip.
   */
  const band = useMemo(() => {
    const rects = emitters.map((e) => e.node.cullRect).filter(Boolean) as number[][];
    if (!rects.length) return { top: 0, height: dh };
    const top = Math.max(0, Math.min(...rects.map((r) => r[1])));
    const bottom = Math.min(dh, Math.max(...rects.map((r) => r[1] + r[3])));
    return { top, height: Math.max(1, bottom - top) };
  }, [emitters, dh]);

  const transform = useDerivedValue(() => {
    const h = viewHeight ? viewHeight.value : canvasHeight;
    const scale = Math.max(width / dw, h / band.height);
    return [
      { translateX: (width - dw * scale) / 2 },
      { translateY: h - (band.top + band.height) * scale },
      { scale },
    ];
  }, [width, canvasHeight, band, dw]);

  const tiles = useMemo(
    () => scene.nodes.filter((n): n is ImageNode => n.type === "image" && (n.opacity ?? 1) > 0),
    [scene]
  );

  return (
    <Canvas style={{ width, height: canvasHeight }}>
      <Group transform={transform}>
        {tiles.map((node, i) => {
          const image = images[node.image];
          if (!image) return null;
          return <TileLayer key={`tile-${i}`} node={node} image={image} clock={clock} />;
        })}

        {emitters.map(({ cells }, ei) =>
          cells.map(({ cell, prepared }, ci) => {
            const image = images[cell.image!];
            if (!image) return null;
            return (
              <CellLayer
                key={`cell-${ei}-${ci}-${state}`}
                prepared={prepared}
                image={image}
                clock={clock}
              />
            );
          })
        )}
      </Group>
    </Canvas>
  );
};
