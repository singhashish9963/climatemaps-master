"""
Dataset registry — JSON-backed store of all uploaded datasets.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from pipeline.config import DATA_ROOT, DatasetConfig

REGISTRY_FILE = DATA_ROOT / "datasets.json"


def _load() -> dict[str, Any]:
    if REGISTRY_FILE.exists():
        return json.loads(REGISTRY_FILE.read_text())
    return {}


def _save(data: dict[str, Any]) -> None:
    REGISTRY_FILE.parent.mkdir(parents=True, exist_ok=True)
    REGISTRY_FILE.write_text(json.dumps(data, indent=2, default=str))


def register(cfg: DatasetConfig) -> dict:
    """Register a new dataset. Returns the registry entry."""
    reg = _load()
    entry = {
        "config": cfg.to_dict(),
        "status": "registered",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "error": None,
    }
    reg[cfg.dataset_id] = entry
    _save(reg)
    return entry


def get(dataset_id: str) -> dict | None:
    return _load().get(dataset_id)


def list_all() -> dict[str, Any]:
    return _load()


def update_status(dataset_id: str, status: str, error: str | None = None) -> None:
    reg = _load()
    if dataset_id in reg:
        reg[dataset_id]["status"] = status
        reg[dataset_id]["error"] = error
        _save(reg)


def get_config(dataset_id: str) -> DatasetConfig | None:
    entry = get(dataset_id)
    if entry is None:
        return None
    return DatasetConfig.from_dict(entry["config"])
