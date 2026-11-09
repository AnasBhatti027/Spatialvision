"""Saved scenes ("Save Scene" / "Load Scene" in the app), stored in SQLite (backend/spatialvision.db).

Uses Python's built-in sqlite3, so nothing extra needs installing. The database file is ignored by git
(*.db in .gitignore). Each saved scene is kept as JSON, exactly as normalize() returns it.
"""

import json
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path

from scene_model import normalize

DB_FILE = Path(__file__).parent / "spatialvision.db"
MAX_PRESETS = 50


@contextmanager
def _db(path: Path = DB_FILE):
    """Opens the database, saves the changes and always closes it again.
    (sqlite3's own "with" only saves; on Windows an unclosed file stays locked.)"""
    con = sqlite3.connect(path)
    try:
        con.execute("CREATE TABLE IF NOT EXISTS presets ("
                    "id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, scene TEXT NOT NULL, created REAL NOT NULL)")
        yield con
        con.commit()
    finally:
        con.close()


def list_presets(path: Path = DB_FILE) -> list[dict]:
    with _db(path) as con:
        rows = con.execute("SELECT id, name, scene, created FROM presets ORDER BY created DESC").fetchall()
    out = []
    for pid, name, scene, created in rows:
        try:
            count = len(json.loads(scene).get("surfaces", []))
        except ValueError:
            count = 0
        out.append({"id": pid, "name": name, "created": created, "surfaces": count})
    return out


def save_preset(name: str, scene: dict, path: Path = DB_FILE) -> None:
    name = (name or "").strip()[:40] or time.strftime("Scene %d %b %H:%M")
    with _db(path) as con:
        con.execute("INSERT INTO presets (name, scene, created) VALUES (?, ?, ?)",
                    (name, json.dumps(normalize(scene)), time.time()))
        # Keep the newest MAX_PRESETS only, so the file cannot grow without limit.
        con.execute("DELETE FROM presets WHERE id NOT IN (SELECT id FROM presets ORDER BY created DESC LIMIT ?)", (MAX_PRESETS,))


def load_preset(pid: int, path: Path = DB_FILE) -> dict | None:
    with _db(path) as con:
        row = con.execute("SELECT scene FROM presets WHERE id = ?", (pid,)).fetchone()
    if not row:
        return None
    try:
        return normalize(json.loads(row[0]))
    except ValueError:
        return None


def delete_preset(pid: int, path: Path = DB_FILE) -> None:
    with _db(path) as con:
        con.execute("DELETE FROM presets WHERE id = ?", (pid,))
