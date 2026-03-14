"""
Real-time query interface
-------------------------
Combines all three pipeline artefacts for fast, low-latency data access:

  1. H3 index  → translate (lat, lon) to nearest grid indices in O(1)
  2. LoD store → pick the coarsest Zarr that satisfies the required precision
  3. Zarr read → pull only the needed chunk(s) from disk

Public API
----------
  QueryEngine(dataset_id)
      .query_point(lat, lon, time_start, time_end, lod)
      .query_region(lat_min, lat_max, lon_min, lon_max, time_step, lod)
"""

from __future__ import annotations

import warnings

import numpy as np
import pandas as pd
import xarray as xr
import h3
from pathlib import Path

from pipeline.config import DatasetConfig, LOD_STRIDES
from pipeline import registry

# ── per-dataset engine cache ──────────────────────────────────────────────────
_engines: dict[str, "QueryEngine"] = {}


def get_engine(dataset_id: str) -> "QueryEngine":
    """Return (and cache) a QueryEngine for the given dataset."""
    if dataset_id not in _engines:
        cfg = registry.get_config(dataset_id)
        if cfg is None:
            raise FileNotFoundError(f"Dataset '{dataset_id}' not found in registry.")
        _engines[dataset_id] = QueryEngine(cfg)
    return _engines[dataset_id]


class QueryEngine:
    """Scoped query interface for a single dataset."""

    def __init__(self, cfg: DatasetConfig) -> None:
        self.cfg = cfg
        self._h3_index: pd.DataFrame | None = None
        self._ds_cache: dict[str, xr.Dataset] = {}

    # ── internal helpers ──────────────────────────────────────────────────

    def _h3_idx(self) -> pd.DataFrame:
        if self._h3_index is None:
            p = Path(self.cfg.h3_index_file)
            if not p.exists():
                raise FileNotFoundError(
                    f"{p} not found — run the pipeline first."
                )
            self._h3_index = pd.read_parquet(p)
        return self._h3_index

    def _ds(self, lod: str) -> xr.Dataset:
        if lod not in self._ds_cache:
            store = self.cfg.lod_store(lod)
            if not Path(store).exists():
                raise FileNotFoundError(f"{store} not found — run the pipeline first.")
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                self._ds_cache[lod] = xr.open_zarr(store)
        return self._ds_cache[lod]

    def _nearest_indices(self, lat: float, lon: float, lod: str) -> tuple[int, int]:
        idx = self._h3_idx()
        stride = LOD_STRIDES[lod]
        lat_dim = self.cfg.lat_dim
        lon_dim = self.cfg.lon_dim

        cell = h3.latlng_to_cell(lat, lon, self.cfg.h3_resolution)
        rows = idx[idx["h3_id"] == cell]

        if rows.empty:
            ds_native = self._ds("L3")
            lat_i = int(np.abs(ds_native[lat_dim].values - lat).argmin())
            lon_i = int(np.abs(ds_native[lon_dim].values - lon).argmin())
        else:
            dists = np.hypot(rows["lat"].values - lat, rows["lon"].values - lon)
            best = rows.iloc[int(dists.argmin())]
            lat_i = int(best["lat_idx"])
            lon_i = int(best["lon_idx"])

        return lat_i // stride, lon_i // stride

    # ── public query methods ──────────────────────────────────────────────

    def query_point(
        self,
        lat: float,
        lon: float,
        time_start: str | None = None,
        time_end: str | None = None,
        lod: str = "L3",
    ) -> pd.DataFrame:
        """
        Return a time-series DataFrame for a single (lat, lon) point.

        Returns
        -------
        DataFrame columns: valid_time | value_raw | value_C | lat | lon | h3_id
        """
        ds = self._ds(lod)
        lat_i, lon_i = self._nearest_indices(lat, lon, lod)
        variable = self.cfg.variable
        time_dim = self.cfg.time_dim
        lat_dim = self.cfg.lat_dim
        lon_dim = self.cfg.lon_dim

        da = ds[variable].isel(**{lat_dim: lat_i, lon_dim: lon_i})

        if time_start or time_end:
            da = da.sel(**{time_dim: slice(time_start, time_end)})

        df = da.to_dataframe(name="value_raw").reset_index()[[time_dim, "value_raw"]]
        df.rename(columns={time_dim: "valid_time"}, inplace=True)
        df = df.dropna(subset=["value_raw"])
        df["value_C"] = (df["value_raw"] - 273.15).round(2)
        df["lat"] = float(ds[lat_dim].values[lat_i])
        df["lon"] = float(ds[lon_dim].values[lon_i])
        df["h3_id"] = h3.latlng_to_cell(
            float(ds[lat_dim].values[lat_i]),
            float(ds[lon_dim].values[lon_i]),
            self.cfg.h3_resolution,
        )
        return df

    def query_region(
        self,
        lat_min: float,
        lat_max: float,
        lon_min: float,
        lon_max: float,
        time_step: str | None = None,
        lod: str = "L1",
    ) -> pd.DataFrame:
        """
        Return a spatial snapshot DataFrame for a bounding-box region.

        Returns
        -------
        DataFrame columns: valid_time | latitude | longitude | value_raw | value_C
        """
        ds = self._ds(lod)
        variable = self.cfg.variable
        time_dim = self.cfg.time_dim
        lat_dim = self.cfg.lat_dim
        lon_dim = self.cfg.lon_dim

        da = ds[variable].sel(**{
            lat_dim:  slice(lat_max, lat_min),   # latitude is stored decreasing
            lon_dim:  slice(lon_min, lon_max),
        })

        if time_step:
            da = da.sel(**{time_dim: time_step}, method="nearest")
        else:
            da = da.isel(**{time_dim: 0})

        df = da.to_dataframe(name="value_raw").reset_index()
        # Normalise column names for the API layer
        df.rename(columns={
            time_dim: "valid_time",
            lat_dim:  "latitude",
            lon_dim:  "longitude",
        }, inplace=True)
        df = df[["valid_time", "latitude", "longitude", "value_raw"]]
        df["value_C"] = (df["value_raw"] - 273.15).round(2)
        df = df.dropna(subset=["value_raw"])
        return df
