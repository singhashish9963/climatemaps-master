"""
Step 1 - Zarr Chunking (with progress bar + resume)

Converts a monolithic NetCDF into a chunked Zarr store.
  - Selects only the configured data variable
  - Initialises the store schema first (coordinates + empty arrays),
    then fills data variable chunk-by-chunk via region writes
  - Tracks completed chunks in a progress JSON file
  - On resume, skips already-written chunks
  - tqdm progress bar with live ETA
"""

import math
import json
import time
import warnings
from pathlib import Path

import dask
import xarray as xr
from tqdm import tqdm

from pipeline.config import DatasetConfig


def _load_progress(progress_file: str) -> set:
    p = Path(progress_file)
    if p.exists():
        return set(json.loads(p.read_text()).get("done", []))
    return set()


def _scan_done_chunks(zarr_store: str, variable: str, n_chunks: int) -> set:
    """Recover completed time chunks by inspecting on-disk Zarr chunk files."""
    done = set()
    var_chunks = Path(zarr_store) / variable / "c"
    if not var_chunks.exists():
        return done
    for i in range(n_chunks):
        if (var_chunks / str(i) / "0" / "0").exists():
            done.add(i)
    return done


def _save_progress(progress_file: str, done: set) -> None:
    Path(progress_file).parent.mkdir(parents=True, exist_ok=True)
    Path(progress_file).write_text(json.dumps({"done": sorted(done)}))


def convert_to_zarr(cfg: DatasetConfig) -> str:
    """Convert NetCDF -> chunked Zarr with resume support. Returns store path."""
    nc_file = cfg.nc_path
    zarr_store = cfg.zarr_store
    variable = cfg.variable
    time_dim = cfg.time_dim
    time_chunk = cfg.time_chunk
    progress_file = cfg.progress_file

    print(f"[Step 1] Zarr Chunking: {nc_file} -> {zarr_store}")
    Path(zarr_store).parent.mkdir(parents=True, exist_ok=True)

    print("  Opening NC file (lazy)...")
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        ds = xr.open_dataset(nc_file, chunks=cfg.chunks, engine="netcdf4")

    # Keep only the configured data variable
    ds_clean = ds[[variable]]
    total_time = ds_clean.sizes[time_dim]
    n_chunks = math.ceil(total_time / time_chunk)

    print(f"  Dimensions : {time_dim}={total_time}, "
          f"{cfg.lat_dim}={ds_clean.sizes[cfg.lat_dim]}, "
          f"{cfg.lon_dim}={ds_clean.sizes[cfg.lon_dim]}")
    print(f"  Total chunks: {n_chunks}  ({time_chunk} time steps each, "
          f"last chunk has {total_time - (n_chunks-1)*time_chunk} steps)")

    done = _load_progress(progress_file)
    store_exists = Path(zarr_store).exists()
    progress_exists = Path(progress_file).exists()

    if not store_exists:
        print("  Initialising Zarr schema (coordinates + empty arrays)...")
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            ds_clean.to_zarr(zarr_store, mode="w", compute=False)
        done = set()
        _save_progress(progress_file, done)
    elif not progress_exists:
        done = _scan_done_chunks(zarr_store, variable, n_chunks)
        print(f"  Progress file missing -- recovered {len(done)}/{n_chunks} "
              f"chunks from on-disk scan.")
        _save_progress(progress_file, done)

    remaining = n_chunks - len(done)
    if remaining == 0:
        print(f"  Already complete ({n_chunks}/{n_chunks} chunks). Skipping.")
        return zarr_store

    pct_done = 100 * len(done) / n_chunks
    print(f"  Progress: {len(done)}/{n_chunks} chunks done ({pct_done:.1f}%) "
          f"-- {remaining} remaining")

    t0 = time.time()
    with tqdm(
        total=n_chunks,
        initial=len(done),
        unit="chunk",
        desc="  Writing",
        bar_format=(
            "{desc}: {percentage:3.0f}%|{bar}| "
            "{n_fmt}/{total_fmt} chunks "
            "[{elapsed} elapsed, ETA {remaining}, {rate_fmt}]"
        ),
        ncols=110,
    ) as pbar:
        for i in range(n_chunks):
            if i in done:
                continue

            t_start = i * time_chunk
            t_end = min((i + 1) * time_chunk, total_time)

            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                chunk = ds_clean.isel(**{time_dim: slice(t_start, t_end)})
                drop = [v for v in chunk.coords if time_dim not in chunk[v].dims]
                with dask.config.set(scheduler="synchronous"):
                    chunk.drop_vars(drop).to_zarr(
                        zarr_store,
                        region={time_dim: slice(t_start, t_end)},
                    )

            done.add(i)
            _save_progress(progress_file, done)
            pbar.update(1)

    elapsed = time.time() - t0
    size_mb = sum(
        f.stat().st_size for f in Path(zarr_store).rglob("*") if f.is_file()
    ) / 1e6
    print(f"  Done in {elapsed:.1f}s | store size: {size_mb:.0f} MB")
    return zarr_store
