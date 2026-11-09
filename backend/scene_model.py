"""The projection scene: one or more surfaces, each with its own corners, warp points, shape and content.

Coordinates
- corners: the four corners of a surface on the output screen, as fractions (0 = left/top, 1 = right/bottom),
  in order 1 top-left, 2 top-right, 3 bottom-right, 4 bottom-left.
- mesh and mask points are in the surface's own square (u, v from 0 to 1), so they move with the corners.
  mesh: a grid of warp points that bends the picture (for curved or uneven objects).
  mask: the outline of the surface, any shape with 3 or more points; outside it nothing is shown.

The selected surface is also copied to the top level of the scene (corners, content, fit, grid, image_url),
because hand gestures edit those fields. A gesture change is written back into the selected surface.
Everything that arrives from the phone or from scene.json passes through normalize(), so a broken or
very old scene can never break the TV or the gestures.
"""

import copy
import math

MAX_SURFACES = 8
MAX_MESH = 6        # at most 6 x 6 warp cells per surface
MAX_MASK = 32       # at most 32 outline points per surface
CONTENTS = ("pattern", "grid", "color", "image", "blank")
FITS = ("contain", "cover")
DEFAULT_CORNERS = [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]]
DEFAULT_COLOR = "#4D7CFE"
MIRRORED = ("corners", "content", "fit", "grid", "image_url")


def default_surface(index: int = 1) -> dict:
    return {
        "id": f"s{index}", "name": f"Surface {index}", "corners": copy.deepcopy(DEFAULT_CORNERS),
        "mesh": None, "mask": None, "content": "pattern", "color": DEFAULT_COLOR, "image_url": None,
        "fit": "contain", "grid": False, "opacity": 1.0, "feather": 0.0,
        "flipX": False, "flipY": False, "visible": True, "locked": False,
    }


def _num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _point(p, lo: float, hi: float):
    if isinstance(p, (list, tuple)) and len(p) == 2 and all(_num(v) for v in p):
        return [min(hi, max(lo, float(p[0]))), min(hi, max(lo, float(p[1])))]
    return None


def _corners(c):
    if isinstance(c, (list, tuple)) and len(c) == 4:
        pts = [_point(p, 0.0, 1.0) for p in c]
        if all(pts):
            return pts
    return None


def _mesh(m):
    if not isinstance(m, dict):
        return None
    cols, rows, pts = m.get("cols"), m.get("rows"), m.get("pts")
    if not (isinstance(cols, int) and isinstance(rows, int) and 1 <= cols <= MAX_MESH and 1 <= rows <= MAX_MESH):
        return None
    if not isinstance(pts, list) or len(pts) != (cols + 1) * (rows + 1):
        return None
    clean = [_point(p, -0.5, 1.5) for p in pts]
    return {"cols": cols, "rows": rows, "pts": clean} if all(clean) else None


def _mask(m):
    if not isinstance(m, list) or not 3 <= len(m) <= MAX_MASK:
        return None
    clean = [_point(p, 0.0, 1.0) for p in m]
    return clean if all(clean) else None


def _color(c) -> bool:
    return isinstance(c, str) and len(c) == 7 and c[0] == "#" and all(ch in "0123456789abcdefABCDEF" for ch in c[1:])


def clean_surface(raw, index: int) -> dict:
    """A valid surface built from raw (anything missing or wrong gets its default)."""
    s = default_surface(index)
    if not isinstance(raw, dict):
        return s
    if isinstance(raw.get("id"), str) and 0 < len(raw["id"]) <= 32:
        s["id"] = raw["id"]
    if isinstance(raw.get("name"), str):
        s["name"] = raw["name"][:40] or s["name"]
    s["corners"] = _corners(raw.get("corners")) or s["corners"]
    s["mesh"] = _mesh(raw.get("mesh"))
    s["mask"] = _mask(raw.get("mask"))
    if raw.get("content") in CONTENTS:
        s["content"] = raw["content"]
    if _color(raw.get("color")):
        s["color"] = raw["color"]
    if raw.get("image_url") is None or isinstance(raw.get("image_url"), str):
        s["image_url"] = raw.get("image_url")
    if raw.get("fit") in FITS:
        s["fit"] = raw["fit"]
    for key in ("grid", "flipX", "flipY", "visible", "locked"):
        if isinstance(raw.get(key), bool):
            s[key] = raw[key]
    if _num(raw.get("opacity")):
        s["opacity"] = min(1.0, max(0.0, float(raw["opacity"])))
    if _num(raw.get("feather")):
        s["feather"] = min(0.25, max(0.0, float(raw["feather"])))
    return s


def normalize(raw: dict, prev: dict | None = None) -> dict:
    """A complete, valid scene. An old-style scene (only top-level corners/content, from before surfaces
    existed, or from an old test) changes the selected surface of prev instead."""
    raw = raw if isinstance(raw, dict) else {}
    if isinstance(raw.get("surfaces"), list) and raw["surfaces"]:
        surfaces = [clean_surface(s, i + 1) for i, s in enumerate(raw["surfaces"][:MAX_SURFACES])]
        selected = raw.get("selected")
        blackout = raw.get("blackout") is True
    else:
        base = normalize(prev) if prev and prev.get("surfaces") else None
        surfaces = base["surfaces"] if base else [default_surface(1)]
        selected = base["selected"] if base else surfaces[0]["id"]
        blackout = base["blackout"] if base else False
        surfaces = [dict(s) for s in surfaces]
        i = next((k for k, s in enumerate(surfaces) if s["id"] == selected), 0)
        old = {k: raw[k] for k in MIRRORED if k in raw}
        surfaces[i] = clean_surface({**surfaces[i], **old}, i + 1)
    # Ids must be unique (they are used to match surfaces between phone and TV).
    seen = set()
    for i, s in enumerate(surfaces):
        while s["id"] in seen:
            s["id"] = f"{s['id']}x"
        seen.add(s["id"])
    if selected not in seen:
        selected = surfaces[0]["id"]
    scene = {"type": "scene", "surfaces": surfaces, "selected": selected, "blackout": blackout}
    return _mirror(scene)


def _mirror(scene: dict) -> dict:
    cur = next(s for s in scene["surfaces"] if s["id"] == scene["selected"])
    for k in MIRRORED:
        scene[k] = copy.deepcopy(cur[k])
    return scene


def apply_changes(scene: dict, changes: dict) -> dict:
    """Used by gestures: changes top-level fields (corners, content...) of the selected surface.
    A locked surface keeps its corners."""
    scene = normalize(scene)
    i = next(k for k, s in enumerate(scene["surfaces"]) if s["id"] == scene["selected"])
    cur = dict(scene["surfaces"][i])
    for k in MIRRORED:
        if k in changes and not (k == "corners" and cur["locked"]):
            cur[k] = changes[k]
    scene["surfaces"][i] = clean_surface(cur, i + 1)
    return _mirror(scene)
