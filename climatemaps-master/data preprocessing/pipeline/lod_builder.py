"""
Step 2 - Level-of-Detail (LoD) builder (with progress bar + resume)

Builds coarser spatial resolutions from the native Zarr store.
  - Dynamically computes LoD shapes from the actual data
  - Skips completed levels automatically on resume
  - Uses dask.diagnostics.ProgressBar for a live progress bar during writes
"""

import time
import warnings
from pathlib import Path

import xarray as xr
from dask.diagnostics import ProgressBar

from pipeline.config import DatasetConfig, LOD_STRIDES


def _is_complete(path: str, expected_shape: tuple, dims: tuple[str, ...]) -> bool:
    """Return True if the zarr store exists and the data var has the expected shape."""
    if not Path(path).exists():
        return False
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            ds = xr.open_zarr(path)
        actual = tuple(ds.sizes[d] for d in dims)
        return actual == expected_shape
    except Exception:
        return False


def build_lod(cfg: DatasetConfig) -> dict[str, str]:
    """
    Build coarser LoD stores from the native L3 Zarr store.
    Skips any level that already exists and is complete.
    Returns a dict mapping level name -> store path.
    """
    zarr_store = cfg.zarr_store
    variable = cfg.variable
    time_dim = cfg.time_dim
    lat_dim = cfg.lat_dim
    lon_dim = cfg.lon_dim
    dims_order = (time_dim, lat_dim, lon_dim)

    print(f"[Step 2] Building LoD layers from {zarr_store}")

    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        ds = xr.open_zarr(zarr_store, chunks={time_dim: cfg.time_chunk})

    n_time = ds.sizes[time_dim]
    n_lat  = ds.sizes[lat_dim]
    n_lon  = ds.sizes[lon_dim]

    stores: dict[str, str] = {"L3": zarr_store}

    for level in ("L2", "L1", "L0"):
        stride = LOD_STRIDES[level]
        out_path = cfg.lod_store(level)
        stores[level] = out_path

        import math
        expected_shape = (
            n_time,
            math.ceil(n_lat / stride),
            math.ceil(n_lon / stride),
        )

        if _is_complete(out_path, expected_shape, dims_order):
            print(f"  {level} (stride={stride}) -- already complete, skipping.")
            continue

        print(f"  {level} (stride={stride}) -> {out_path}")

        ds_coarse = ds[[variable]].isel(**{
            lat_dim:  slice(None, None, stride),
            lon_dim:  slice(None, None, stride),
        })
        actual_shape = tuple(ds_coarse.sizes[d] for d in dims_order)
        print(f"    Shape: {actual_shape}")

        # Rechunk so Dask chunk boundaries align with Zarr write chunks
        ds_coarse = ds_coarse.chunk({
            time_dim: cfg.time_chunk,
            lat_dim:  cfg.lat_chunk,
            lon_dim:  cfg.lon_chunk,
        })

        t0 = time.time()
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            with ProgressBar(minimum=2, dt=1.0):
                ds_coarse.to_zarr(out_path, mode="w")

        elapsed = time.time() - t0
        size_mb = sum(
            f.stat().st_size for f in Path(out_path).rglob("*") if f.is_file()
        ) / 1e6
        print(f"    Done in {elapsed:.1f}s | size: {size_mb:.0f} MB")

    print(f"  L3 (native) -> {zarr_store}  [already stored]")
    return stores
