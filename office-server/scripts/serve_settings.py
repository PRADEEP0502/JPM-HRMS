"""Shared: where the install lives and how settings.env is read (values are never printed)."""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def load_settings(path):
    """KEY=VALUE lines; # comments and blank lines are ignored. Returns only non-empty values."""
    values = {}
    if not path.exists():
        return values
    for line in path.read_text(encoding='utf-8-sig').splitlines():
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, value = line.split('=', 1)
        value = value.strip().strip('"').strip("'")
        if value:
            values[key.strip()] = value
    return values
