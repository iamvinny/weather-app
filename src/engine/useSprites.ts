import { useEffect, useState } from "react";
import { Asset } from "expo-asset";
import { Skia, type SkImage } from "@shopify/react-native-skia";
import { SPRITES } from "./assets";

/** Decode a scene's sprites into Skia images, keyed by filename. */
export function useSprites(names: string[]) {
  const [images, setImages] = useState<Record<string, SkImage | null>>({});
  const key = names.join(",");

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const loaded: Record<string, SkImage | null> = {};
      for (const name of names) {
        const mod = SPRITES[name];
        if (!mod) {
          console.warn(`sprite not registered in assets.ts: ${name}`);
          loaded[name] = null;
          continue;
        }
        const asset = Asset.fromModule(mod);
        await asset.downloadAsync();
        const uri = asset.localUri ?? asset.uri;
        const data = await Skia.Data.fromURI(uri);
        loaded[name] = Skia.Image.MakeImageFromEncoded(data);
      }
      if (!cancelled) setImages(loaded);
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return images;
}
