"""Fear state file format, shared by the server and scripts/set_fear.py.

Mirrors extension/fear-tracker@local/state.js; keep the two in sync.
"""

import json
import os
import tempfile
import time
from pathlib import Path

DEFAULT_MAX = 12
MAX_LIMIT = 30
JSON_NAME = "fear.json"
TXT_NAME = "fear.txt"


def default_state_dir() -> Path:
    if env := os.environ.get("FEAR_STATE_DIR"):
        return Path(env).expanduser()
    config = os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config"
    return Path(config) / "fear-tracker"


def default_state() -> dict:
    return {"fear": 0, "max": DEFAULT_MAX, "updated": 0}


def _is_int(value) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def clamp(value: int, lo: int, hi: int) -> int:
    return max(lo, min(hi, value))


def normalize(raw) -> dict | None:
    """Return a clamped {fear, max, updated} dict, or None if unusable."""
    if not isinstance(raw, dict) or not _is_int(raw.get("fear")):
        return None
    max_ = clamp(raw["max"], 1, MAX_LIMIT) if _is_int(raw.get("max")) else DEFAULT_MAX
    updated = raw.get("updated")
    return {
        "fear": clamp(raw["fear"], 0, max_),
        "max": max_,
        "updated": updated if _is_int(updated) else 0,
    }


def read_state(state_dir: Path) -> dict | None:
    try:
        raw = json.loads((state_dir / JSON_NAME).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return normalize(raw)


def pip_text(fear: int, max_: int) -> str:
    return "●" * fear + "○" * (max_ - fear)


def _write_atomic(path: Path, text: str) -> None:
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp, 0o644)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def write_state(state_dir: Path, fear: int, max_: int) -> dict:
    """Clamp and atomically write fear.json and fear.txt. Returns the state."""
    max_ = clamp(max_, 1, MAX_LIMIT)
    state = {"fear": clamp(fear, 0, max_), "max": max_, "updated": int(time.time() * 1000)}
    state_dir.mkdir(parents=True, exist_ok=True)
    _write_atomic(state_dir / JSON_NAME, json.dumps(state, separators=(",", ":")) + "\n")
    _write_atomic(state_dir / TXT_NAME, pip_text(state["fear"], state["max"]))
    return state
