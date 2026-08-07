#!/usr/bin/env python3
"""Convert Apple Weather .caml scenes into the runtime format this app renders.

    # one condition
    python3 tools/caml_to_scene.py <Mica dir> rain_night

    # every condition, and regenerate the asset registry
    python3 tools/caml_to_scene.py <Mica dir> --all

Scenes are authored in a fixed 640x1136 design space held by the "Rotation"
layer, which is anchored bottom-left and uniformly scaled to cover the device.
Core Animation authors it y-up; we flip to the y-down space renderers expect.
"""
import glob, json, os, re, shutil, sys
from collections import defaultdict
from xml.etree import ElementTree as ET

NS = "{http://www.apple.com/CoreAnimation/1.0}"

# sunny@2x-896h-n84.caml -> condition sunny, time (day|night|any)
FNAME = re.compile(
    r"^(?P<cond>[A-Za-z_]+?)(?:_(?P<time>day|night))?@(?P<scale>\d+)x(?:-(?P<device>[\w-]+))?\.caml$"
)
# Names that arrived truncated in this extraction; verify against the device.
ALIASES = {"opicalStorm": "tropicalStorm", "_Bow": "rainbow"}

# Core Animation render modes -> Skia blend modes.
BLEND = {
    "cheapAdditive": "plus",
    "additive": "plus",
    "cheapScreen": "screen",
    "screen": "screen",
    "backToFront": "srcOver",
    "oldestFirst": "srcOver",
    "oldestLast": "srcOver",
    "unordered": "srcOver",
}


def tag(el):
    return el.tag.replace(NS, "")


def f(el, name, default=0.0):
    try:
        return float(el.get(name))
    except (TypeError, ValueError):
        return default


def nums(s, default=None):
    if not s:
        return default
    return [float(x) for x in re.findall(r"-?\d+\.?\d*(?:[eE]-?\d+)?", s)]


def scale_of(transform):
    m = re.search(r"scale\(\s*(-?\d+\.?\d*)", transform or "")
    return float(m.group(1)) if m else 1.0


def repeat_of(el):
    """repeatCount="Inf" means the emitter's duration window loops forever."""
    v = (el.get("repeatCount") or "").strip().lower()
    if v in ("inf", "infinity"):
        return -1
    try:
        return int(float(v))
    except ValueError:
        return 0


def color_of(el, child="color"):
    c = el.find(NS + child)
    if c is None:
        return [1.0, 1.0, 1.0, 1.0]
    rgb = nums(c.get("value"), [1.0, 1.0, 1.0]) or [1.0, 1.0, 1.0]
    while len(rgb) < 3:
        rgb.append(1.0)
    return rgb[:3] + [float(c.get("opacity", 1.0))]


def values_of(el):
    node = el.find(NS + "values")
    if node is None:
        return []
    out = []
    for v in node:
        if tag(v) == "CGColor":
            out.extend(nums(v.get("value"), [1, 1, 1, 1]))
        else:
            out.append(float(v.get("value", 0)))
    return out


def colors_of(el):
    """<colors><CGColor opacity="0.75" value="1 1 1"/>...</colors> -> flat RGBA.

    colorOverLife keeps its ramp here rather than in <values>. For lightning
    the ramp is a strobe (0 -> 0.75 -> 0 -> 0.25 -> 0), which is what makes a
    bolt flicker and then fade; miss it and bolts never go out.
    """
    node = el.find(NS + "colors")
    if node is None:
        return []
    out = []
    for c in node:
        rgb = nums(c.get("value"), [1.0, 1.0, 1.0]) or [1.0, 1.0, 1.0]
        while len(rgb) < 3:
            rgb.append(1.0)
        out.extend(rgb[:3] + [float(c.get("opacity", 1.0))])
    return out


def parse_path(d):
    """'108.1 1147.1 m 107 1142 l ...' -> [[x, y], ...] (postfix commands)."""
    pts, buf = [], []
    for tok in (d or "").split():
        try:
            buf.append(float(tok))
        except ValueError:
            if tok in ("m", "l") and len(buf) >= 2:
                pts.append([buf[-2], buf[-1]])
            buf = []
    # Collapse the duplicated vertices Apple emits between segments.
    out = [p for i, p in enumerate(pts) if i == 0 or p != pts[i - 1]]
    return out


def keyframe_anim(el):
    for a in el.iter():
        if a.get("type") != "CAKeyframeAnimation":
            continue
        vals = values_of(a)
        if a.get("keyPath") in ("position.y", "position.x") and len(vals) >= 2:
            return {
                "keyPath": a.get("keyPath"),
                "duration": float(a.get("duration", 1)) or 1.0,
                "speed": float(a.get("speed", 1)) or 1.0,
                "from": vals[0],
                "to": vals[-1],
            }
    return None


CELL_FLOATS = [
    "birthRate", "lifetime", "lifetimeRange", "velocity", "velocityRange",
    "scale", "scaleRange", "scaleSpeed", "alphaRange", "alphaSpeed",
    "xAcceleration", "yAcceleration", "emissionLongitude", "emissionLatitude",
    "emissionRange", "spin", "spinRange", "rotation", "rotationRange",
    "beginTime", "duration", "timeOffset", "contentsScale",
    "contentsFramesPerSecond",
]


def parse_behaviors(el):
    out = []
    for b in el.findall(f"{NS}emitterBehaviors/{NS}CAEmitterBehavior"):
        bd = {
            "behavior": b.get("behavior"),
            "keyPath": b.get("keyPath"),
            "enabled": b.get("enabled", "1") != "0",
        }
        vals = values_of(b) or colors_of(b)
        if vals:
            bd["values"] = vals
        for k in ("force", "frequency", "falloff", "falloffDistance",
                  "orientationLatitude", "orientationLongitude", "stiffness", "radius"):
            if b.get(k) is not None:
                bd[k] = f(b, k)
        if b.get("position"):
            bd["position"] = nums(b.get("position"))
        out.append(bd)
    return out


def parse_cell(el):
    cell = {"name": el.get("name") or "cell", "enabled": el.get("enabled", "1") != "0"}
    for k in CELL_FLOATS:
        if el.get(k) is not None:
            cell[k] = f(el, k)
    for k in ("contentsFrameCount", "contentsFramesPerRow"):
        if el.get(k) is not None:
            cell[k] = int(f(el, k, 1))
    cell["repeatCount"] = repeat_of(el)
    cell["color"] = color_of(el)

    contents = el.find(NS + "contents")
    if contents is not None and contents.get("src"):
        cell["image"] = os.path.basename(contents.get("src"))
    if el.get("contentsRect"):
        cell["contentsRect"] = nums(el.get("contentsRect"))
    if el.get("contentsFrameMode"):
        cell["contentsFrameMode"] = el.get("contentsFrameMode")

    behaviors = parse_behaviors(el)
    if behaviors:
        cell["behaviors"] = behaviors
    return cell


def parse_emitter(el):
    shape = el.get("emitterShape", "point")
    em = {
        "type": "emitter",
        "id": el.get("id"),
        "name": el.get("name") or "emitter",
        "birthRate": f(el, "birthRate", 1.0),
        "speed": f(el, "speed", 1.0),
        "scale": f(el, "scale", 1.0),
        "shape": shape,
        "mode": el.get("emitterMode", "volume"),
        "blendMode": BLEND.get(el.get("renderMode"), "srcOver"),
        "beginTime": f(el, "beginTime", 0.0),
        "duration": f(el, "duration", 0.0),
        "repeatCount": repeat_of(el),
        "emitterPosition": nums(el.get("emitterPosition"), [0.0, 0.0]),
        "emitterSize": nums(el.get("emitterSize"), [0.0, 0.0]),
        "cullRect": nums(el.get("cullRect")),
        "cells": [parse_cell(c) for c in el.findall(f"{NS}emitterCells/{NS}CAEmitterCell")],
    }
    if shape == "path":
        em["path"] = parse_path(el.get("emitterPath"))
    return em


def parse_image_layer(el, contents):
    bounds = nums(el.get("bounds"), [0, 0, 0, 0])
    pos = nums(el.get("position"), [0, 0])
    anchor = nums(el.get("anchorPoint"), [0.5, 0.5])
    w, h = bounds[2], bounds[3]
    return {
        "type": "image",
        "id": el.get("id"),
        "name": el.get("name") or "image",
        "image": os.path.basename(contents.get("src")),
        "frame": [pos[0] - anchor[0] * w, pos[1] - anchor[1] * h, w, h],
        "opacity": f(el, "opacity", 1.0),
        "tiled": el.get("contentsScaling") == "repeat",
        "contentsScale": f(el, "contentsScale", 1.0),
        "scroll": keyframe_anim(el),
    }


def collect(el, out, ox=0.0, oy=0.0, phase=0.0, tscale=1.0, pduration=0.0, prepeat=0):
    """Walk the layer tree in draw order, accumulating parent offsets.

    Containers are not always plain CALayers -- the lightning bolts in the
    thunderstorm scenes hang off a CATransformLayer -- so anything ending in
    "Layer" is treated as a group worth descending into.

    Core Animation nests time as well as space: a child's local time is
    (parent_time - beginTime) * speed. Flattening the tree would lose that, so
    we compose it into a single (phase, tscale) per emitter. Without this the
    bolt sub-emitters all inherit beginTime 0 and fire simultaneously instead
    of staggering across the storm.
    """
    for child in el.findall(f"{NS}sublayers/*"):
        t = tag(child)
        if child.get("hidden") == "1":
            continue
        if not t.endswith("Layer"):
            continue
        # t_child = (t_parent - beginTime) * speed, composed with the ancestors.
        child_phase = phase + f(child, "beginTime", 0.0) / (tscale or 1.0)
        child_tscale = tscale * (f(child, "speed", 1.0) or 1.0)

        if t == "CAEmitterLayer":
            em = parse_emitter(child)
            em["beginTime"] = child_phase
            em["speed"] = child_tscale
            # A child's active window is clipped by its parent's, so a
            # sub-emitter that declares no duration of its own repeats on the
            # parent's cycle. The lightning branches rely on this: without it
            # they emit continuously and the bolts never stop glowing.
            if em["duration"] <= 0 and prepeat == -1:
                em["duration"] = pduration
                em["repeatCount"] = prepeat
            pos = nums(child.get("position"), [0, 0])
            bounds = nums(child.get("bounds"), [0, 0, 0, 0])
            anchor = nums(child.get("anchorPoint"), [0.5, 0.5])
            # A path emitter's points are already in the layer's own space.
            base_x = ox + pos[0] - anchor[0] * bounds[2]
            base_y = oy + pos[1] - anchor[1] * bounds[3]
            em["emitterPosition"] = [em["emitterPosition"][0] + base_x,
                                     em["emitterPosition"][1] + base_y]
            if em.get("path"):
                em["path"] = [[p[0] + base_x, p[1] + base_y] for p in em["path"]]
            out.append(em)
            # Emitters can host their own sublayers; keep descending.
            collect(child, out, base_x, base_y, child_phase, child_tscale,
                    em["duration"], em["repeatCount"])
            continue

        contents = child.find(NS + "contents")
        if contents is not None and contents.get("src"):
            layer = parse_image_layer(child, contents)
            layer["frame"][0] += ox
            layer["frame"][1] += oy
            out.append(layer)

        bounds = nums(child.get("bounds"), [0, 0, 0, 0])
        pos = nums(child.get("position"), [0, 0])
        anchor = nums(child.get("anchorPoint"), [0.5, 0.5])
        collect(child, out,
                ox + pos[0] - anchor[0] * bounds[2],
                oy + pos[1] - anchor[1] * bounds[3],
                child_phase, child_tscale, pduration, prepeat)


def parse_states(root):
    states = {}
    for st in root.findall(f"{NS}states/{NS}LKState"):
        entry = {"basedOn": st.get("basedOn"), "set": [], "remove": []}
        for e in st.findall(f"{NS}elements/*"):
            if tag(e) == "LKStateSetValue":
                v = e.find(NS + "value")
                entry["set"].append({
                    "targetId": e.get("targetId"),
                    "keyPath": e.get("keyPath"),
                    "value": float(v.get("value", 0)) if v is not None else 0.0,
                })
            elif tag(e) == "LKStateRemoveElement":
                obj = e.find(NS + "object")
                entry["remove"].append({
                    "targetId": e.get("targetId"),
                    "keyPath": e.get("keyPath"),
                    "name": obj.get("name") if obj is not None else None,
                })
        states[st.get("name")] = entry
    return states


def flip_y(nodes, height):
    """Core Animation authors these scenes y-up with a bottom-left origin.

    Confirmed by the Mini state: it culls the rain emitter to design y
    846..2046, which flips to the top 290px -- the collapsed header.
    """
    for n in nodes:
        if n["type"] == "image":
            x, y, w, h = n["frame"]
            n["frame"] = [x, height - (y + h), w, h]
            if n["scroll"] and n["scroll"]["keyPath"] == "position.y":
                n["scroll"]["from"] = -n["scroll"]["from"]
                n["scroll"]["to"] = -n["scroll"]["to"]
        else:
            n["emitterPosition"][1] = height - n["emitterPosition"][1]
            if n.get("path"):
                n["path"] = [[p[0], height - p[1]] for p in n["path"]]
            if n.get("cullRect") and len(n["cullRect"]) == 4:
                cx, cy, cw, ch = n["cullRect"]
                # Unbounded axes are stored as +/-DBL_MAX; flipping those
                # arithmetically collapses them to 0, which would cull the
                # whole scene. Keep them unbounded instead.
                if abs(cy) > 1e30 or abs(ch) > 1e30:
                    top, ch = -1e9, 2e9
                else:
                    top = height - (cy + ch)
                n["cullRect"] = [cx, top, cw, ch]
            else:
                # A few scenes carry a malformed rect; treat it as unbounded.
                n["cullRect"] = None


def convert(path):
    root = ET.parse(path).getroot()
    root_layer = root.find(NS + "CALayer") if tag(root) != "CALayer" else root
    design = root_layer.find(f"{NS}sublayers/{NS}CALayer")
    if design is None:
        raise ValueError("no design-space layer found")

    bounds = nums(design.get("bounds"), [0, 0, 640, 1136])
    nodes = []
    collect(design, nodes)
    flip_y(nodes, bounds[3])

    return {
        "name": os.path.basename(path).replace(".caml", ""),
        "designSize": [bounds[2], bounds[3]],
        "deviceScale": scale_of(design.get("transform")),
        # Cells carry no emissionLongitude, so travel direction comes entirely
        # from the container the app rotates at runtime (the layer is named
        # "Rotation"; it is also how the app tilts precipitation with wind).
        # In the flipped, y-down space we emit, +pi/2 points straight down.
        "rotation": 1.5707963267948966,
        "nodes": nodes,
        # States hang off the root layer, not the design-space layer.
        "states": parse_states(root_layer),
    }


def sprites_of(scene):
    used = {n["image"] for n in scene["nodes"] if n["type"] == "image"}
    for n in scene["nodes"]:
        if n["type"] == "emitter":
            used |= {c["image"] for c in n["cells"] if c.get("image")}
    return sorted(used)


def variants(mica):
    """Map condition key -> best .caml file (largest carries the most layers)."""
    groups = defaultdict(list)
    for p in sorted(glob.glob(os.path.join(mica, "*.caml"))):
        m = FNAME.match(os.path.basename(p))
        if not m:
            print("  ! unparsed filename:", os.path.basename(p))
            continue
        cond = ALIASES.get(m["cond"], m["cond"])
        key = f"{cond}_{m['time']}" if m["time"] else cond
        groups[key].append(p)
    return {k: max(v, key=os.path.getsize) for k, v in groups.items()}


def write_registry(names, out):
    scenes = "\n".join(
        f'  {n}: require("../../assets/scenes/{n}.json") as Scene,' for n in sorted(names)
    )
    sprites = "\n".join(
        f'  "{s}": require("../../assets/sprites/{s}"),'
        for s in sorted(os.listdir("assets/sprites"))
        if s.lower().endswith(".png")
    )
    out_path = os.path.join(out, "assets.ts")
    with open(out_path, "w") as fh:
        fh.write(
            "// Generated by tools/caml_to_scene.py --all. Do not edit by hand.\n"
            "// Metro needs static require paths, so every scene and sprite is listed.\n"
            'import type { Scene } from "./types";\n\n'
            f"export const SCENES: Record<string, Scene> = {{\n{scenes}\n}};\n\n"
            f"export const SPRITES: Record<string, number> = {{\n{sprites}\n}};\n\n"
            "/** Every sprite filename a scene references, across tiles and cells. */\n"
            "export function spritesFor(scene: Scene): string[] {\n"
            "  const names = new Set<string>();\n"
            "  for (const node of scene.nodes) {\n"
            '    if (node.type === "image") names.add(node.image);\n'
            "    else for (const cell of node.cells) if (cell.image) names.add(cell.image);\n"
            "  }\n"
            "  return [...names];\n"
            "}\n"
        )
    return out_path


def emit(src, key, out_dir, sprite_dir, mica, quiet=False):
    scene = convert(src)
    os.makedirs(out_dir, exist_ok=True)
    os.makedirs(sprite_dir, exist_ok=True)
    with open(os.path.join(out_dir, f"{key}.json"), "w") as fh:
        json.dump(scene, fh, separators=(",", ":"))

    missing = []
    for img in sprites_of(scene):
        s = os.path.join(mica, img)
        if os.path.exists(s):
            shutil.copy2(s, os.path.join(sprite_dir, img))
        else:
            missing.append(img)

    ems = [n for n in scene["nodes"] if n["type"] == "emitter"]
    cells = sum(len(e["cells"]) for e in ems)
    paths = sum(1 for e in ems if e.get("path"))
    if not quiet:
        print(f"  {key:34s} {len(scene['nodes']):3d} nodes  {len(ems):3d} emitters  "
              f"{cells:4d} cells  {paths:3d} paths"
              + (f"  ! missing {missing}" if missing else ""))
    return scene, missing


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    mica, want = sys.argv[1], sys.argv[2]
    out_dir, sprite_dir = "assets/scenes", "assets/sprites"

    table = variants(mica)
    if want != "--all":
        if want not in table:
            sys.exit(f"unknown condition {want!r}; try --all or one of:\n  "
                     + ", ".join(sorted(table)))
        emit(table[want], want, out_dir, sprite_dir, mica)
        return

    print(f"converting {len(table)} conditions from {mica}")
    ok, failed = [], []
    for key, src in sorted(table.items()):
        try:
            emit(src, key, out_dir, sprite_dir, mica)
            ok.append(key)
        except Exception as exc:  # keep going; report at the end
            failed.append((key, exc))
            print(f"  {key:34s} FAILED: {exc}")

    reg = write_registry(ok, "src/engine")
    print(f"\n{len(ok)} scenes converted, {len(failed)} failed")
    print(f"{len(os.listdir(sprite_dir))} sprites -> {sprite_dir}")
    print(f"registry -> {reg}")


if __name__ == "__main__":
    main()
