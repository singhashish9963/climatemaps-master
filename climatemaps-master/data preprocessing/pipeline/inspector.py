"""
NC file inspector — auto-detect variable names and dimensions.
"""

from __future__ import annotations

import warnings
from pathlib import Path

import xarray as xr

from pipeline.config import DatasetConfig

# Common aliases for time / lat / lon dimension names in NetCDF files.
_TIME_ALIASES = {"time", "valid_time", "date", "datetime", "t"}
_LAT_ALIASES  = {"latitude", "lat", "y", "nav_lat", "rlat"}
_LON_ALIASES  = {"longitude", "lon", "x", "nav_lon", "rlon"}


def _find_dim(ds: xr.Dataset, aliases: set[str]) -> str | None:
    """Return the first dimension name that matches any alias (case-insensitive)."""
    lower_map = {d.lower(): d for d in ds.dims}
    for alias in aliases:
        if alias in lower_map:
            return lower_map[alias]
    return None


def _pick_variable(ds: xr.Dataset, time_dim: str, lat_dim: str, lon_dim: str) -> str | None:
    """Pick the first data variable that spans all three spatial/time dims."""
    coord_names = set(ds.coords)
    for name in ds.data_vars:
        if name in coord_names:
            continue
        dims = set(ds[name].dims)
        if {time_dim, lat_dim, lon_dim}.issubset(dims):
            return name
    return None


def inspect_nc(nc_path: str, dataset_id: str | None = None) -> DatasetConfig:
    """
    Open a NetCDF file, detect dimensions + variable, and return a DatasetConfig.

    Parameters
    ----------
    nc_path    : Path to the .nc file.
    dataset_id : Optional ID. If None, derived from the filename stem.

    Raises
    ------
    ValueError : If required dimensions or a suitable variable cannot be found.
    """
    if dataset_id is None:
        dataset_id = Path(nc_path).stem

    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        ds = xr.open_dataset(nc_path, engine="netcdf4")

    time_dim = _find_dim(ds, _TIME_ALIASES)
    lat_dim  = _find_dim(ds, _LAT_ALIASES)
    lon_dim  = _find_dim(ds, _LON_ALIASES)

    if time_dim is None:
        raise ValueError(f"Cannot detect time dimension. Found dims: {list(ds.dims)}")
    if lat_dim is None:
        raise ValueError(f"Cannot detect latitude dimension. Found dims: {list(ds.dims)}")
    if lon_dim is None:
        raise ValueError(f"Cannot detect longitude dimension. Found dims: {list(ds.dims)}")

    variable = _pick_variable(ds, time_dim, lat_dim, lon_dim)
    if variable is None:
        raise ValueError(
            f"No data variable spans ({time_dim}, {lat_dim}, {lon_dim}). "
            f"Variables: {list(ds.data_vars)}"
        )

    return DatasetConfig(
        dataset_id=dataset_id,
        nc_path=nc_path,
        variable=variable,
        time_dim=time_dim,
        lat_dim=lat_dim,
        lon_dim=lon_dim,
    )
