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
import copy, glob, json, math, os, re, shutil, sys
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


# -- 3x3 projective matrices, row-major, acting on column vectors (x, y, 1).
# The y-up design space is kept throughout; flip_y conjugates at the end.

IDENT = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]


def mat_mul(a, b):
    return [sum(a[r * 3 + k] * b[k * 3 + c] for k in range(3))
            for r in range(3) for c in range(3)]


def mat_translate(tx, ty):
    return [1.0, 0.0, tx, 0.0, 1.0, ty, 0.0, 0.0, 1.0]


def mat_is_translation(m, tol=1e-9):
    return all(abs(m[i] - IDENT[i]) < tol for i in (0, 1, 3, 4, 6, 7, 8))


def parse_transform(t):
    """A CALayer transform attribute -> 3x3, or None when identity.

    CATransform3D is row-vector: x' = x*m11 + y*m21 + m41, w' = x*m14 + y*m24
    + m44. The drizzle/tornado cloud planes use the perspective terms -- they
    are 3D-tilted so the tile recedes toward the horizon.
    """
    if not t:
        return None
    m = re.match(r"\s*scale\(([^)]*)\)", t)
    if m:
        v = nums(m.group(1), [1.0])
        sx, sy = v[0], v[1] if len(v) > 1 else v[0]
        return None if sx == 1 and sy == 1 else [sx, 0, 0, 0, sy, 0, 0, 0, 1]
    m = re.match(r"\s*rotate\((-?\d+\.?\d*)deg\)", t)
    if m:
        a = math.radians(float(m.group(1)))
        c, s = math.cos(a), math.sin(a)
        return [c, -s, 0, s, c, 0, 0, 0, 1]
    m = re.match(r"\s*matrix\(([^)]*)\)", t)
    if m:
        v = nums(m.group(1))
        if len(v) == 16:
            return [v[0], v[4], v[12],
                    v[1], v[5], v[13],
                    v[3], v[7], v[15]]
    return None


def layer_matrix(el, pos, anchor, bounds):
    """local -> parent: translate(position) . transform . translate(-anchor)."""
    t = parse_transform(el.get("transform"))
    if t is None:
        return None
    ax, ay = anchor[0] * bounds[2], anchor[1] * bounds[3]
    return mat_mul(mat_translate(pos[0], pos[1]),
                   mat_mul(t, mat_translate(-ax, -ay)))


def rotation_of(el):
    """The layer's z-rotation: static transform plus the midpoint of any
    transform.rotation.z keyframe animation (the sunny lens flare aims its
    emission with a wobbling rotation animation; the wobble is subtle, the
    orientation is not)."""
    rot = 0.0
    m = re.match(r"\s*rotate\((-?\d+\.?\d*)deg\)", el.get("transform") or "")
    if m:
        rot += math.radians(float(m.group(1)))
    for a in el.findall(f"{NS}animations/{NS}p"):
        if a.get("keyPath") == "transform.rotation.z":
            vals = values_of(a)
            if vals:
                rot += sum(vals) / len(vals)
    return rot


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


def locations_of(el):
    node = el.find(NS + "locations")
    if node is None:
        return None
    return [float(v.get("value", 0)) for v in node]


def resample(values, locations, n=16):
    """Rebuild a keyframed curve with non-uniform locations as n uniform
    samples, so the runtime's uniform piecewise-linear sampler stays simple.
    The smoke alpha ramp holds 0->1 over [0, 0.1] then 1->0 over [0.9, 1]."""
    out = []
    for i in range(n):
        u = i / (n - 1)
        k = 0
        while k < len(locations) - 2 and locations[k + 1] < u:
            k += 1
        a, b = locations[k], locations[k + 1]
        t = 0.0 if b <= a else (u - a) / (b - a)
        t = min(1.0, max(0.0, t))
        out.append(values[k] + (values[k + 1] - values[k]) * t)
    return out


def parse_behaviors(el):
    out = []
    for b in el.findall(f"{NS}emitterBehaviors/{NS}CAEmitterBehavior"):
        bd = {
            "behavior": b.get("behavior"),
            "keyPath": b.get("keyPath"),
            "enabled": b.get("enabled", "1") != "0",
        }
        vals = values_of(b) or colors_of(b)
        locs = locations_of(b)
        if vals and locs and len(locs) == len(vals):
            vals = resample(vals, locs)
        if vals:
            bd["values"] = vals
        for k in ("force", "frequency", "falloff", "falloffDistance",
                  "orientationLatitude", "orientationLongitude", "stiffness", "radius",
                  "rotation", "ambientIntensity", "diffuseIntensity", "appliesAlpha"):
            if b.get(k) is not None:
                bd[k] = f(b, k)
        if b.get("position"):
            bd["position"] = nums(b.get("position"))
        out.append(bd)
    return out


def parse_cell(el, prefix=""):
    cell = {"name": prefix + (el.get("name") or "cell"), "enabled": el.get("enabled", "1") != "0"}
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


def flatten_cells(el, prefix=""):
    """Parse a cell list, folding nested cells into equivalent top-level ones.

    CAEmitterCells can nest: a carrier cell spawns children from wherever it
    happens to be. The hail and sleet "keyline" emitters use this -- an
    invisible carrier drifting along a line (velocity <= 1) whose children are
    the visible bouncing stones. The runtime simulates one level, so a child
    becomes a top-level cell emitting from the carrier's spawn region at its
    steady-state rate: carriers/sec x children each carrier emits during its
    window (its own `duration`, else the carrier's lifetime).
    """
    out = []
    for c in el.findall(f"{NS}emitterCells/{NS}CAEmitterCell"):
        cell = parse_cell(c, prefix)
        out.append(cell)
        for k in c.findall(f"{NS}emitterCells/{NS}CAEmitterCell"):
            kid = parse_cell(k, cell["name"] + "/")
            if k.find(f"{NS}emitterCells/{NS}CAEmitterCell") is not None:
                print("  ! cells nested deeper than one level; dropping the rest")
            window = kid.get("duration") or cell.get("lifetime") or 1.0
            kid["birthRate"] = cell.get("birthRate", 0.0) * kid.get("birthRate", 0.0) * window
            kid.pop("duration", None)
            kid.pop("beginTime", None)
            out.append(kid)
    return out


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
        "cells": flatten_cells(el),
    }
    if shape == "path":
        em["path"] = parse_path(el.get("emitterPath"))
    # Behaviors can live on the emitter layer as well as on cells -- the smoke
    # scenes keep their alpha-over-life ramp there. They apply to every cell.
    # Deep-copied per cell: flip_y mutates behavior positions, and a dict
    # shared across cells would be flipped once per cell.
    shared = parse_behaviors(el)
    if shared:
        for c in em["cells"]:
            c["behaviors"] = c.get("behaviors", []) + copy.deepcopy(shared)
    return em


def parse_image_layer(el, contents):
    bounds = nums(el.get("bounds"), [0, 0, 0, 0])
    pos = list(nums(el.get("position"), [0, 0]))
    anchor = nums(el.get("anchorPoint"), [0.5, 0.5])
    w, h = bounds[2], bounds[3]

    # A scroll animation's keyframes are *absolute* positions that override the
    # layer's static position attribute (drizzle's tile sits at x -895.9 but
    # animates 0 -> -768). Rebase the frame on the animation's start and keep
    # only the slide vector; the slide distance is a multiple of the tile's
    # image width, which is what makes the loop seamless.
    anim = keyframe_anim(el)
    scroll = None
    if anim:
        axis = 0 if anim["keyPath"] == "position.x" else 1
        delta = anim["to"] - anim["from"]
        pos[axis] = anim["from"]
        scroll = {
            "duration": anim["duration"],
            "speed": anim["speed"],
            "dx": delta if axis == 0 else 0.0,
            "dy": delta if axis == 1 else 0.0,
        }

    return {
        "type": "image",
        "id": el.get("id"),
        "name": el.get("name") or "image",
        "image": os.path.basename(contents.get("src")),
        "frame": [pos[0] - anchor[0] * w, pos[1] - anchor[1] * h, w, h],
        "position": pos,
        "anchor": anchor,
        "opacity": f(el, "opacity", 1.0),
        "tiled": el.get("contentsScaling") == "repeat",
        "contentsScale": f(el, "contentsScale", 1.0),
        "scroll": scroll,
    }


def collect(el, out, ox=0.0, oy=0.0, phase=0.0, tscale=1.0, pduration=0.0,
            prepeat=0, gids=(), opacity=1.0, frames=None, acc=None):
    """Walk the layer tree in draw order, accumulating parent offsets.

    Containers are not always plain CALayers -- the lightning bolts in the
    thunderstorm scenes hang off a CATransformLayer -- so anything ending in
    "Layer" is treated as a group worth descending into.

    Core Animation nests time as well as space: a child's local time is
    (parent_time - beginTime) * speed. Flattening the tree would lose that, so
    we compose it into a single (phase, tscale) per emitter. Without this the
    bolt sub-emitters all inherit beginTime 0 and fire simultaneously instead
    of staggering across the storm.

    Flattening also loses the ancestry LKStates target, so each node records
    the ids of the groups above it (`groups`) -- removing or hiding a group id
    must take its whole subtree with it -- and `frames` collects id ->
    (offset, timing) so layers serialized inside state removal records can be
    positioned as if they still hung off their parent. Group opacity folds
    down for the same reason: an image multiplies it into its own, an
    emitter into its cells' colours.
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
        child_opacity = opacity * f(child, "opacity", 1.0)
        cid = child.get("id")
        child_gids = gids + (cid,) if cid else gids

        if t == "CAEmitterLayer":
            em = parse_emitter(child)
            em["beginTime"] = child_phase
            em["speed"] = child_tscale
            if gids:
                em["groups"] = list(gids)
            if child_opacity != 1.0:
                for c in em["cells"]:
                    c["color"][3] *= child_opacity
            # The emitter layer's own transform: scale multiplies what the
            # cells draw, rotation re-aims their emission (the sunny lens
            # flare points its streak with a transform rotation).
            em["scale"] *= scale_of(child.get("transform"))
            rot = rotation_of(child)
            if rot:
                em["angleOffset"] = rot
            # An infinitely-repeating emitter with no duration anywhere in its
            # chain is driven by the app adding and removing the layer at
            # runtime (the isolated-thunderstorm bolt). Its cells still define
            # burst windows; give the cycle a period so it strikes rather than
            # accumulating forever. ~15s matches the storm scenes' cadence.
            if (em["repeatCount"] == -1 and em["duration"] <= 0 and prepeat != -1
                    and any(c.get("duration", 0) > 0 for c in em["cells"])):
                em["duration"] = 15.0 * (child_tscale or 1.0)
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
            if frames is not None and cid:
                frames[cid] = (base_x, base_y, child_phase, child_tscale,
                               em["duration"], em["repeatCount"])
            # Emitters can host their own sublayers; keep descending.
            collect(child, out, base_x, base_y, child_phase, child_tscale,
                    em["duration"], em["repeatCount"], child_gids, child_opacity, frames)
            continue

        bounds = nums(child.get("bounds"), [0, 0, 0, 0])
        pos = nums(child.get("position"), [0, 0])
        anchor = nums(child.get("anchorPoint"), [0.5, 0.5])

        contents = child.find(NS + "contents")
        if contents is not None and contents.get("src"):
            layer = parse_image_layer(child, contents)
            own_t = parse_transform(child.get("transform"))
            lpos, lanchor = layer.pop("position"), layer.pop("anchor")
            layer["frame"][0] += ox
            layer["frame"][1] += oy
            if own_t is not None or acc is not None:
                # One projective map from where the flat frame math puts the
                # layer to where the transform chain actually lands it. The
                # runtime applies the scroll slide inside this map; that
                # matches Core Animation only after the slide vector is pulled
                # back through the layer's own transform (T.translate(inv(T)v)
                # == translate(v).T), done below.
                a_parent = acc if acc is not None else mat_translate(ox, oy)
                p_self = layer_matrix(child, lpos, lanchor, bounds) \
                    or mat_translate(layer["frame"][0] - ox, layer["frame"][1] - oy)
                m = mat_mul(mat_mul(a_parent, p_self),
                            mat_translate(-layer["frame"][0], -layer["frame"][1]))
                if not mat_is_translation(m, 1e-6) or abs(m[2]) + abs(m[5]) > 1e-6:
                    layer["matrix"] = m
                if own_t is not None and layer["scroll"]:
                    a, b, c, d = own_t[0], own_t[1], own_t[3], own_t[4]
                    det = a * d - b * c or 1.0
                    dx, dy = layer["scroll"]["dx"], layer["scroll"]["dy"]
                    layer["scroll"]["dx"] = (d * dx - b * dy) / det
                    layer["scroll"]["dy"] = (a * dy - c * dx) / det
            layer["opacity"] *= opacity
            if gids:
                layer["groups"] = list(gids)
            out.append(layer)

        child_acc = acc
        own_t = layer_matrix(child, pos, anchor, bounds)
        if own_t is not None:
            child_acc = mat_mul(acc or mat_translate(ox, oy), own_t)
        elif acc is not None:
            child_acc = mat_mul(acc, mat_translate(pos[0] - anchor[0] * bounds[2],
                                                   pos[1] - anchor[1] * bounds[3]))
        cx = ox + pos[0] - anchor[0] * bounds[2]
        cy = oy + pos[1] - anchor[1] * bounds[3]
        if frames is not None and cid:
            frames[cid] = (cx, cy, child_phase, child_tscale, pduration, prepeat)
        collect(child, out, cx, cy, child_phase, child_tscale,
                pduration, prepeat, child_gids, child_opacity, frames, child_acc)


def parse_states(root):
    """Parse LKStates, and pull layers that exist only inside removal records.

    Some layers never appear in the base sublayer tree at all: the hail and
    sleet keyline emitters and the tornado plank debris live solely inside
    `LKStateRemoveElement` records, fully serialized so the state machine can
    restore them on the way out. They are present by default and removed when
    the state (Mini) activates, so they must be parsed into the scene; the
    removal record is retargeted at a synthetic id the runtime can hide.
    """
    states = {}
    removed = {}  # synthetic id -> serialized <object> element
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
                rec = {
                    "targetId": e.get("targetId"),
                    "keyPath": e.get("keyPath"),
                    "name": obj.get("name") if obj is not None else None,
                }
                if e.get("keyPath") == "sublayers":
                    if e.get("objectId"):
                        # References a layer that lives in the base tree (or
                        # inside another removal record); remove it by id.
                        rec["targetId"] = e.get("objectId")
                    elif obj is not None and (obj.get("type") or "").endswith("Layer"):
                        rid = f"#removed:{e.get('targetId')}:{rec['name'] or len(removed)}"
                        removed.setdefault(rid, (e.get("targetId"), obj))
                        rec["targetId"] = rid
                entry["remove"].append(rec)
        states[st.get("name")] = entry
    return states, removed


def backdrop_of(design):
    """Sky colour, when the scene carries one.

    The thunderstorm-family scenes back themselves with a '🔳 Underlying'
    CALayer whose backgroundColor is the sky; every other condition ships no
    backdrop and the app supplies one (src/constants/sky.ts).
    """
    for el in design.findall(f"{NS}sublayers/{NS}CALayer"):
        if el.get("hidden") == "1":
            continue
        value, opacity = el.get("backgroundColor"), 1.0
        if value is None:
            c = el.find(NS + "backgroundColor")
            if c is not None:
                value, opacity = c.get("value"), float(c.get("opacity", 1))
        if value and opacity > 0:
            rgb = (nums(value, [0, 0, 0]) + [0, 0, 0])[:3]
            return "#" + "".join(f"{round(x * 255):02x}" for x in rgb)
    return None


def flip_y(nodes, height):
    """Core Animation authors these scenes y-up with a bottom-left origin.

    Confirmed by the Mini state: it culls the rain emitter to design y
    846..2046, which flips to the top 290px -- the collapsed header.
    """
    F = [1.0, 0.0, 0.0, 0.0, -1.0, height, 0.0, 0.0, 1.0]
    for n in nodes:
        if n["type"] == "image":
            x, y, w, h = n["frame"]
            n["frame"] = [x, height - (y + h), w, h]
            if n["scroll"]:
                n["scroll"]["dy"] = -n["scroll"]["dy"]
            if n.get("matrix"):
                n["matrix"] = mat_mul(F, mat_mul(n["matrix"], F))
        else:
            n["emitterPosition"][1] = height - n["emitterPosition"][1]
            # Behavior anchors (the light cones, the attractors) live in the
            # same y-up space as everything else.
            for c in n["cells"]:
                for b in c.get("behaviors", []):
                    if b.get("position") and len(b["position"]) >= 2:
                        b["position"][1] = height - b["position"][1]
            # Accelerations share the geometry's y-up frame: snow carries +50
            # (air-resistance lift slowing its fall) while the hail and sleet
            # keyline bounces carry -2000/-3500 (gravity). Negate along with y.
            for c in n["cells"]:
                if c.get("yAcceleration"):
                    c["yAcceleration"] = -c["yAcceleration"]
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
    frames = {}
    if design.get("id"):
        frames[design.get("id")] = (0.0, 0.0, 0.0, 1.0, 0.0, 0)
    collect(design, nodes, frames=frames)

    # States hang off the root layer, not the design-space layer.
    states, removed = parse_states(root_layer)

    # Layers serialized inside removal records exist only there: they are
    # present by default and taken out when the state (always Mini in this
    # corpus) activates. Re-wrap each one as a sublayer of its recorded parent
    # so collect() sees it with the right offsets and timing, and tag every
    # node it yields with the synthetic id the retargeted removal points at.
    for rid, (parent, obj) in removed.items():
        ox, oy, phase, tscale, pdur, prep = frames.get(parent, (0, 0, 0, 1, 0, 0))
        wrapper = ET.Element(NS + "CALayer")
        sub = ET.SubElement(wrapper, NS + "sublayers")
        el = copy.deepcopy(obj)
        el.tag = NS + (obj.get("type") or "CALayer")
        sub.append(el)
        collect(wrapper, nodes, ox, oy, phase, tscale, pdur, prep,
                gids=(rid,), frames=frames)

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
        "backgroundColor": backdrop_of(design),
        "nodes": nodes,
        "states": states,
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
