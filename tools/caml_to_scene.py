#!/usr/bin/env python3
"""Convert an Apple Weather .caml scene into the runtime format this app renders.

    python3 tools/caml_to_scene.py <Mica dir> <condition_time> [out dir]
    python3 tools/caml_to_scene.py ../Extracted_IOS_Files/Mica rain_night

Scenes are authored in a fixed 640x1136 design space held by the "Rotation"
layer, which is anchored bottom-left and uniformly scaled to cover the device.
The renderer reproduces that, so we emit design-space coordinates unchanged.
"""
import glob, json, os, re, shutil, sys
from xml.etree import ElementTree as ET

NS = "{http://www.apple.com/CoreAnimation/1.0}"


def tag(el):
    return el.tag.replace(NS, "")


def f(el, name, default=0.0):
    v = el.get(name)
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def nums(s, default=None):
    if not s:
        return default
    return [float(x) for x in re.findall(r"-?\d+\.?\d*(?:[eE]-?\d+)?", s)]


def scale_of(transform):
    """'scale(2.446, 2.446, 1)' -> 2.446"""
    m = re.search(r"scale\(\s*(-?\d+\.?\d*)", transform or "")
    return float(m.group(1)) if m else 1.0


def color_of(el):
    """CAEmitterCell/CALayer <color value="1 1 1" opacity="0.21"/> -> [r,g,b,a]."""
    c = el.find(NS + "color")
    if c is None:
        return [1.0, 1.0, 1.0, 1.0]
    rgb = nums(c.get("value"), [1.0, 1.0, 1.0])
    while len(rgb) < 3:
        rgb.append(1.0)
    return rgb[:3] + [float(c.get("opacity", 1.0))]


def values_of(el):
    """<values><real value="0.65"/><integer value="1"/></values> -> [0.65, 1.0]"""
    node = el.find(NS + "values")
    if node is None:
        return []
    return [float(v.get("value", 0)) for v in node]


def keyframe_anim(el):
    """position.y keyframe animation on a tiled layer -> scroll descriptor."""
    # Inline animations are <animations><p type="CAKeyframeAnimation" .../></animations>;
    # state-attached ones use <animation>. Accept either by matching on type.
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
                "repeat": a.get("repeatCount") == "inf",
            }
    return None


CELL_FLOATS = [
    "birthRate", "lifetime", "lifetimeRange", "velocity", "velocityRange",
    "scale", "scaleRange", "scaleSpeed", "alphaRange", "alphaSpeed",
    "xAcceleration", "yAcceleration", "emissionLongitude", "emissionLatitude",
    "emissionRange", "spin", "spinRange", "rotation", "rotationRange",
    "beginTime", "duration", "timeOffset", "mass", "massRange", "contentsScale",
]
CELL_INTS = ["contentsFrameCount", "contentsFramesPerRow"]


def parse_cell(el):
    cell = {"name": el.get("name") or "cell", "enabled": el.get("enabled", "1") != "0"}
    for k in CELL_FLOATS:
        if el.get(k) is not None:
            cell[k] = f(el, k)
    for k in CELL_INTS:
        if el.get(k) is not None:
            cell[k] = int(f(el, k, 1))
    cell["color"] = color_of(el)

    contents = el.find(NS + "contents")
    if contents is not None and contents.get("src"):
        cell["image"] = os.path.basename(contents.get("src"))
    if el.get("contentsRect"):
        cell["contentsRect"] = nums(el.get("contentsRect"))
    if el.get("contentsFrameMode"):
        cell["contentsFrameMode"] = el.get("contentsFrameMode")

    behaviors = []
    for b in el.findall(f"{NS}emitterBehaviors/{NS}CAEmitterBehavior"):
        bd = {"behavior": b.get("behavior"), "keyPath": b.get("keyPath"),
              "enabled": b.get("enabled", "1") != "0"}
        vals = values_of(b)
        if vals:
            bd["values"] = vals
        for k in ("force", "frequency", "falloff", "falloffDistance",
                  "orientationLatitude", "orientationLongitude"):
            if b.get(k) is not None:
                bd[k] = f(b, k)
        if b.get("position"):
            bd["position"] = nums(b.get("position"))
        behaviors.append(bd)
    if behaviors:
        cell["behaviors"] = behaviors
    return cell


def parse_emitter(el):
    return {
        "type": "emitter",
        "id": el.get("id"),
        "name": el.get("name") or "emitter",
        "birthRate": f(el, "birthRate", 1.0),
        "speed": f(el, "speed", 1.0),
        "scale": f(el, "scale", 1.0),
        "shape": el.get("emitterShape", "point"),
        "mode": el.get("emitterMode", "volume"),
        "emitterPosition": nums(el.get("emitterPosition"), [0.0, 0.0]),
        "emitterSize": nums(el.get("emitterSize"), [0.0, 0.0]),
        "cullRect": nums(el.get("cullRect")),
        "cells": [parse_cell(c) for c in el.findall(f"{NS}emitterCells/{NS}CAEmitterCell")],
    }


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


def collect(el, out, ox=0.0, oy=0.0):
    """Walk the layer tree in draw order, accumulating parent offsets."""
    for child in el.findall(f"{NS}sublayers/*"):
        t = tag(child)
        if t == "CAEmitterLayer":
            em = parse_emitter(child)
            em["emitterPosition"] = [em["emitterPosition"][0] + ox,
                                     em["emitterPosition"][1] + oy]
            out.append(em)
            continue
        if t != "CALayer":
            continue

        contents = child.find(NS + "contents")
        if contents is not None and contents.get("src"):
            layer = parse_image_layer(child, contents)
            layer["frame"][0] += ox
            layer["frame"][1] += oy
            if child.get("hidden") != "1":
                out.append(layer)

        bounds = nums(child.get("bounds"), [0, 0, 0, 0])
        pos = nums(child.get("position"), [0, 0])
        anchor = nums(child.get("anchorPoint"), [0.5, 0.5])
        collect(child, out,
                ox + pos[0] - anchor[0] * bounds[2],
                oy + pos[1] - anchor[1] * bounds[3])


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
    """Core Animation authors these scenes y-up with a bottom-left origin;
    convert to the y-down space renderers expect.

    Confirmed by the Mini state: it culls the emitter to design y 846..2046,
    which flips to the top 290px of the screen -- the collapsed header.
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
            if n.get("cullRect"):
                cx, cy, cw, ch = n["cullRect"]
                # Unbounded axes are stored as +/-DBL_MAX; flipping those
                # arithmetically collapses them to 0, which would cull the whole
                # scene. Keep them unbounded instead.
                if abs(cy) > 1e30 or abs(ch) > 1e30:
                    top, ch = -1e9, 2e9
                else:
                    top = height - (cy + ch)
                n["cullRect"] = [cx, top, cw, ch]


def convert(path):
    root = ET.parse(path).getroot()
    root_layer = root.find(NS + "CALayer") if tag(root) != "CALayer" else root
    rotation = root_layer.find(f"{NS}sublayers/{NS}CALayer")
    if rotation is None:
        raise SystemExit(f"{path}: no design-space layer found")

    bounds = nums(rotation.get("bounds"), [0, 0, 640, 1136])
    nodes = []
    collect(rotation, nodes)
    flip_y(nodes, bounds[3])

    return {
        "name": os.path.basename(path).replace(".caml", ""),
        "designSize": [bounds[2], bounds[3]],
        "deviceScale": scale_of(rotation.get("transform")),
        # Cells carry no emissionLongitude, so travel direction comes entirely
        # from the container the app rotates at runtime (the layer is named
        # "Rotation"; it is also how the app tilts precipitation with wind).
        # In the flipped, y-down space we emit, +pi/2 points straight down.
        "rotation": 1.5707963267948966,
        "nodes": nodes,
        # States hang off the root layer, not the design-space layer.
        "states": parse_states(root_layer),
    }


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    mica, want = sys.argv[1], sys.argv[2]
    out_dir = sys.argv[3] if len(sys.argv) > 3 else "assets/scenes"
    sprite_dir = os.path.join(os.path.dirname(out_dir) or ".", "sprites")
    os.makedirs(out_dir, exist_ok=True)
    os.makedirs(sprite_dir, exist_ok=True)

    matches = sorted(glob.glob(os.path.join(mica, f"{want}@*.caml")))
    if not matches:
        sys.exit(f"no .caml matching {want}@* in {mica}")
    # Highest-resolution variant carries the most complete layer set.
    src = max(matches, key=os.path.getsize)

    scene = convert(src)
    dest = os.path.join(out_dir, f"{want}.json")
    json.dump(scene, open(dest, "w"), indent=1)

    used = sorted({n["image"] for n in scene["nodes"] if "image" in n} |
                  {c["image"] for n in scene["nodes"] if n["type"] == "emitter"
                   for c in n["cells"] if "image" in c})
    for img in used:
        s = os.path.join(mica, img)
        if os.path.exists(s):
            shutil.copy2(s, os.path.join(sprite_dir, img))
        else:
            print("  ! missing sprite:", img)

    emitters = [n for n in scene["nodes"] if n["type"] == "emitter"]
    print(f"{os.path.basename(src)} -> {dest}")
    print(f"  design {scene['designSize']}  scale {scene['deviceScale']}")
    print(f"  {len(scene['nodes'])} nodes, {len(emitters)} emitters, "
          f"{sum(len(e['cells']) for e in emitters)} cells")
    print(f"  states: {', '.join(scene['states'])}")
    print(f"  sprites -> {sprite_dir}: {', '.join(used)}")


if __name__ == "__main__":
    main()
