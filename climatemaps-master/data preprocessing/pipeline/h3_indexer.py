"""
Step 3 - H3 Hex Grid Indexing (with progress bar + resume)

Builds a spatial H3 index mapping every (lat, lon) grid point to an H3 cell.
"""

import time
import warnings
from pathlib import Path

import numpy as np
import pandas as pd
import xarray as xr
import h3
from tqdm import tqdm

from pipeline.config import DatasetConfig


def build_h3_index(cfg: DatasetConfig) -> str:
    """
    Build the H3 spatial index and save it as a parquet file.
    Skips the build if the parquet file already exists.
    Returns the path to the parquet file.
    """
    zarr_store = cfg.zarr_store
    out_file = cfg.h3_index_file
    resolution = cfg.h3_resolution
    lat_dim = cfg.lat_dim
    lon_dim = cfg.lon_dim

    print(f"[Step 3] H3 Indexing (resolution={resolution}) -> {out_file}")

    if Path(out_file).exists():
        size_mb = Path(out_file).stat().st_size / 1e6
        print(f"  Already exists ({size_mb:.1f} MB) -- skipping.")
        return out_file

    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        ds = xr.open_zarr(zarr_store)

    lats = ds[lat_dim].values
    lons = ds[lon_dim].values
    n_lat, n_lon = len(lats), len(lons)
    total = n_lat * n_lon
    print(f"  Grid: {n_lat} lats x {n_lon} lons = {total:,} points")

    lat_idx_2d, lon_idx_2d = np.meshgrid(
        np.arange(n_lat), np.arange(n_lon), indexing="ij"
    )
    lat_2d, lon_2d = np.meshgrid(lats, lons, indexing="ij")

    flat_lat = lat_2d.ravel()
    flat_lon = lon_2d.ravel()
    flat_lat_idx = lat_idx_2d.ravel().astype(np.int32)
    flat_lon_idx = lon_idx_2d.ravel().astype(np.int32)

    print(f"  Computing H3 cells for {total:,} points...")
    t0 = time.time()
    h3_ids = [
        h3.latlng_to_cell(float(lat), float(lon), resolution)
        for lat, lon in tqdm(
            zip(flat_lat, flat_lon),
            total=total,
            unit="pt",
            desc="  Indexing",
            bar_format=(
                "{desc}: {percentage:3.0f}%|{bar}| "
                "{n_fmt}/{total_fmt} pts "
                "[{elapsed} elapsed, ETA {remaining}, {rate_fmt}]"
            ),
            ncols=110,
        )
    ]
    elapsed = time.time() - t0

    df = pd.DataFrame(
        {
            "h3_id": h3_ids,
            "lat_idx": flat_lat_idx,
            "lon_idx": flat_lon_idx,
            "lat": flat_lat.astype(np.float32),
            "lon": flat_lon.astype(np.float32),
        }
    )

    Path(out_file).parent.mkdir(parents=True, exist_ok=True)
    df.to_parquet(out_file, index=False)

    n_cells = df["h3_id"].nunique()
    size_mb = Path(out_file).stat().st_size / 1e6
    print(f"  Done in {elapsed:.1f}s | "
          f"{total:,} points -> {n_cells:,} H3 cells | "
          f"saved to {out_file} ({size_mb:.1f} MB)")
    return out_file
