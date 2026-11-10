"""Checks the scene format (surfaces, warp points, shapes) and saved scenes. No server needed:
    python test_scene_model.py
"""

import tempfile
from pathlib import Path

import presets
from scene_model import MAX_SURFACES, apply_changes, normalize

failed = 0


def check(name, ok, detail=""):
    global failed
    print(("PASS " if ok else "FAIL ") + name + (f"  ({detail})" if detail else ""))
    failed += not ok


# 1. An old scene.json (one shape, from before surfaces existed) becomes surface 1
old = {"type": "scene", "corners": [[0.2, 0.2], [0.8, 0.2], [0.8, 0.8], [0.2, 0.8]], "content": "image", "image_url": "/assets/a.jpg"}
sc = normalize(old)
check("old scene becomes one surface", len(sc["surfaces"]) == 1 and sc["surfaces"][0]["corners"][0] == [0.2, 0.2])
check("old image kept", sc["surfaces"][0]["content"] == "image" and sc["image_url"] == "/assets/a.jpg")
check("selected surface copied to the top (for gestures)", sc["corners"] == sc["surfaces"][0]["corners"])

# 2. Two surfaces; the second is selected
two = normalize({"surfaces": [{"id": "a", "corners": [[0, 0], [0.4, 0], [0.4, 0.4], [0, 0.4]]},
                              {"id": "b", "corners": [[0.5, 0.5], [1, 0.5], [1, 1], [0.5, 1]], "content": "color", "color": "#45D9F5"}],
                 "selected": "b"})
check("top-level corners are the selected surface's", two["corners"][0] == [0.5, 0.5])

# 3. A gesture drag changes only the selected surface
moved = apply_changes(two, {"corners": [[0.55, 0.5], [1, 0.5], [1, 1], [0.5, 1]]})
check("gesture moves the selected surface", moved["surfaces"][1]["corners"][0] == [0.55, 0.5])
check("other surface unchanged", moved["surfaces"][0]["corners"] == two["surfaces"][0]["corners"])

# 4. A locked surface does not move with gestures
locked = normalize({**two, "surfaces": [two["surfaces"][0], {**two["surfaces"][1], "locked": True}]})
still = apply_changes(locked, {"corners": [[0.6, 0.6], [1, 0.6], [1, 1], [0.6, 1]]})
check("locked surface keeps its corners", still["surfaces"][1]["corners"][0] == [0.5, 0.5])

# 5. An old-style message (a test or an old app) changes the selected surface of the current scene
patched = normalize({"type": "scene", "corners": [[0, 0], [1, 0], [1, 1], [0, 1]]}, two)
check("old-style message edits the selected surface", patched["surfaces"][1]["corners"][2] == [1, 1] and len(patched["surfaces"]) == 2)
check("old-style message keeps the other surface", patched["surfaces"][0] == two["surfaces"][0])

# 6. Broken data is replaced by safe values
bad = normalize({"surfaces": [{"id": "x", "corners": [[5, -3], [1, 0], [1, 1]], "mesh": {"cols": 2, "rows": 2, "pts": [[0, 0]]},
                               "mask": [[0, 0], [1, 1]], "content": "virus", "opacity": 7, "color": "red"},
                              {"id": "x"}], "selected": "nope"})
s0 = bad["surfaces"][0]
check("wrong corners replaced", len(s0["corners"]) == 4 and all(0 <= v <= 1 for p in s0["corners"] for v in p))
check("wrong mesh and mask dropped", s0["mesh"] is None and s0["mask"] is None)
check("wrong content, colour and opacity fixed", s0["content"] == "pattern" and s0["color"] == "#4D7CFE" and s0["opacity"] == 1.0)
check("duplicate ids made unique", bad["surfaces"][0]["id"] != bad["surfaces"][1]["id"])
check("unknown selection falls back to the first surface", bad["selected"] == s0["id"])
many = normalize({"surfaces": [{"id": f"s{i}"} for i in range(20)]})
check("number of surfaces limited", len(many["surfaces"]) == MAX_SURFACES)

# 7. A warp grid and a custom shape survive
mesh = {"cols": 2, "rows": 1, "pts": [[0, 0], [0.5, 0.1], [1, 0], [0, 1], [0.5, 0.9], [1, 1]]}
star = [[0.5, 0], [0.6, 0.4], [1, 0.4], [0.7, 0.6], [0.8, 1], [0.5, 0.75], [0.2, 1], [0.3, 0.6], [0, 0.4], [0.4, 0.4]]
kept = normalize({"surfaces": [{"id": "m", "mesh": mesh, "mask": star, "feather": 0.05}]})
check("warp grid kept", kept["surfaces"][0]["mesh"] == mesh)
check("shape outline kept", kept["surfaces"][0]["mask"] == star and kept["surfaces"][0]["feather"] == 0.05)

# 7b. "Outlines on TV" is kept; anything but true means off
check("guides kept", normalize({"surfaces": [{"id": "g"}], "guides": True})["guides"] is True)
check("guides off by default", normalize({"surfaces": [{"id": "g"}], "guides": "yes"})["guides"] is False)

# 8. Saved scenes in SQLite (a temporary database, so your real saved scenes are not touched)
with tempfile.TemporaryDirectory() as d:
    db = Path(d) / "test.db"
    presets.save_preset("Two surfaces", two, db)
    presets.save_preset("", kept, db)
    items = presets.list_presets(db)
    check("two scenes saved", len(items) == 2, str([i["name"] for i in items]))
    first = next(i for i in items if i["name"] == "Two surfaces")
    check("surface count listed", first["surfaces"] == 2)
    loaded = presets.load_preset(first["id"], db)
    check("loaded scene matches", loaded["surfaces"] == two["surfaces"] and loaded["selected"] == "b")
    presets.delete_preset(first["id"], db)
    check("deleted", len(presets.list_presets(db)) == 1 and presets.load_preset(first["id"], db) is None)

print("\nAll checks passed." if not failed else f"\n{failed} check(s) FAILED.")
