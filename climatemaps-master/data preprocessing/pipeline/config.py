"""
Dataset configuration — single source of truth for paths and settings.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from pathlib import Path


DATA_ROOT = Path("data")
LOD_STRIDES: dict[str, int] = {"L0": 8, "L1": 4, "L2": 2, "L3": 1}


@dataclass
class DatasetConfig:
    dataset_id: str
    nc_path: str
    variable: str                         # e.g. "t2m"
    time_dim: str   = "valid_time"
    lat_dim: str    = "latitude"
    lon_dim: str    = "longitude"
    time_chunk: int = 30
    lat_chunk: int  = 181
    lon_chunk: int  = 360
    h3_resolution: int = 4

    # ── derived paths (auto-set) ──────────────────────────────────────────
    base_dir: Path        = field(init=False)
    zarr_store: str       = field(init=False)
    progress_file: str    = field(init=False)
    h3_index_file: str    = field(init=False)

    def __post_init__(self) -> None:
        self.base_dir = DATA_ROOT / self.dataset_id
        self.zarr_store = str(self.base_dir / "store.zarr")
        self.progress_file = str(self.base_dir / ".zarr_progress.json")
        self.h3_index_file = str(self.base_dir / "h3_index.parquet")

    @property
    def chunks(self) -> dict[str, int]:
        return {
            self.time_dim: self.time_chunk,
            self.lat_dim:  self.lat_chunk,
            self.lon_dim:  self.lon_chunk,
        }

    @property
    def lod_stores(self) -> dict[str, str]:
        return {lv: self.lod_store(lv) for lv in ("L0", "L1", "L2", "L3")}

    def lod_store(self, level: str) -> str:
        # Check for explicit path overrides (e.g. legacy datasets at non-standard paths)
        overrides = getattr(self, "_lod_store_overrides", {})
        if level in overrides:
            return overrides[level]
        if level == "L3":
            return self.zarr_store
        return str(self.base_dir / f"store_{level}.zarr")

    def to_dict(self) -> dict:
        d = {
            "dataset_id": self.dataset_id,
            "nc_path": self.nc_path,
            "variable": self.variable,
            "time_dim": self.time_dim,
            "lat_dim": self.lat_dim,
            "lon_dim": self.lon_dim,
            "time_chunk": self.time_chunk,
            "lat_chunk": self.lat_chunk,
            "lon_chunk": self.lon_chunk,
            "h3_resolution": self.h3_resolution,
            # Persist resolved paths so non-standard (legacy) paths survive round-trips
            "_zarr_store": self.zarr_store,
            "_progress_file": self.progress_file,
            "_h3_index_file": self.h3_index_file,
        }
        overrides = getattr(self, "_lod_store_overrides", {})
        if overrides:
            d["_lod_store_overrides"] = overrides
        return d

    @classmethod
    def from_dict(cls, d: dict) -> DatasetConfig:
        init_fields = {k for k, f in cls.__dataclass_fields__.items() if f.init}
        obj = cls(**{k: v for k, v in d.items() if k in init_fields})
        # Restore explicit path overrides if present
        if "_zarr_store" in d:
            obj.zarr_store = d["_zarr_store"]
        if "_progress_file" in d:
            obj.progress_file = d["_progress_file"]
        if "_h3_index_file" in d:
            obj.h3_index_file = d["_h3_index_file"]
        if "_lod_store_overrides" in d:
            obj._lod_store_overrides = d["_lod_store_overrides"]
        return obj
