from typing import List, Optional
import time
import io
import base64
import uuid
import os
import tempfile
from pathlib import Path

import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.colors as mcolors

from fastapi import FastAPI, HTTPException, Request, UploadFile, File, Form
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
from citipy import citipy
import pycountry
from geopy.geocoders import Photon
from geopy.exc import GeocoderTimedOut, GeocoderServiceError

from climatemaps.config import ClimateMap
from climatemaps.settings import settings
from climatemaps.datasets import ClimateDifferenceDataConfig
from climatemaps.data import load_climate_data, load_climate_data_for_difference
from climatemaps.geogrid import GeoGrid

from .middleware import RateLimitMiddleware
from .cache import GeoGridCache

app = FastAPI()

api = FastAPI()
app.mount("/v1", api)

climate_maps = [ClimateMap.create(maps_config) for maps_config in settings.DATA_SETS_API]

data_config_map = {config.data_type_slug: config for config in settings.DATA_SETS_API}

geocoder = Photon(user_agent="openclimatemap", timeout=10)

geo_grid_cache = GeoGridCache()

api.add_middleware(RateLimitMiddleware, calls_per_minute=1000)


@api.get("/climatemap", response_model=List[ClimateMap])
def list_climate_map():
    return climate_maps


@api.get("/colorbar/{data_type}/{month}")
def get_colorbar(data_type: str, month: int):
    """Serve colorbar image for a specific data type and month."""
    tiles_path = Path("data/tiles")
    colorbar_path = tiles_path / data_type / f"{month}_colorbar.png"

    if colorbar_path.exists():
        return FileResponse(
            colorbar_path, media_type="image/png", filename=f"{data_type}_{month}_colorbar.png"
        )
    else:
        raise HTTPException(status_code=404, detail="Colorbar not found")


class ColorbarConfigResponse(BaseModel):
    title: str
    unit: str
    levels: list[float]
    colors: list[list[float]]
    level_lower: float
    level_upper: float
    log_scale: bool


@api.get("/colorbar-config/{data_type}", response_model=ColorbarConfigResponse)
def get_colorbar_config(data_type: str):
    """Get colorbar configuration (colors and levels) as JSON for a specific data type."""
    if data_type not in data_config_map:
        raise HTTPException(status_code=404, detail=f"Data type '{data_type}' not found")

    data_config = data_config_map[data_type]
    contour_config = data_config.contour_config
    colorbar_data = contour_config.get_colorbar_data()

    return ColorbarConfigResponse(**colorbar_data)


class ClimateValueResponse(BaseModel):
    value: float
    data_type: str
    month: int
    latitude: float
    longitude: float
    unit: str
    variable_name: str


@api.get("/value/{data_type}/{month}", response_model=ClimateValueResponse)
def get_climate_value(data_type: str, month: int, lat: float, lon: float):
    if data_type not in data_config_map:
        raise HTTPException(status_code=404, detail=f"Data type '{data_type}' not found")

    if month < 1 or month > 12:
        raise HTTPException(
            status_code=400, detail=f"Invalid month: {month}. Must be between 1 and 12"
        )

    data_config = data_config_map[data_type]

    try:
        geo_grid = geo_grid_cache.get(data_type, month)

        if geo_grid is None:
            if isinstance(data_config, ClimateDifferenceDataConfig):
                geo_grid = load_climate_data_for_difference(
                    data_config.historical_config, data_config.future_config, month
                )
            else:
                geo_grid = load_climate_data(data_config, month)
            geo_grid_cache.set(data_type, month, geo_grid)

        value = geo_grid.get_value_at_coordinate(lon, lat)

        return ClimateValueResponse(
            value=value,
            data_type=data_type,
            month=month,
            latitude=lat,
            longitude=lon,
            unit=data_config.variable.unit,
            variable_name=data_config.variable.display_name,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error retrieving climate value: {str(e)}")


class NearestCityResponse(BaseModel):
    city_name: str
    country_name: str
    country_code: str
    latitude: float
    longitude: float


@api.get("/nearest-city", response_model=NearestCityResponse)
def get_nearest_city(lat: float, lon: float) -> NearestCityResponse:
    try:
        city = citipy.nearest_city(lat, lon)
        country_code = city.country_code.upper()

        country_name = country_code
        try:
            country = pycountry.countries.get(alpha_2=country_code)
            if country:
                country_name = country.name
        except Exception:
            pass

        return NearestCityResponse(
            city_name=city.city_name,
            country_name=country_name,
            country_code=country_code,
            latitude=lat,
            longitude=lon,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error finding nearest city: {str(e)}")


class GeocodingLocation(BaseModel):
    display_name: str
    latitude: float
    longitude: float
    type: str
    bounding_box: Optional[List[float]] = None


@api.get("/geocode", response_model=List[GeocodingLocation])
def search_locations(query: str, limit: int = 50) -> List[GeocodingLocation]:
    if not query or len(query.strip()) < 2:
        return []

    if limit < 1 or limit > 50:
        raise HTTPException(status_code=400, detail="Limit must be between 1 and 50")

    max_retries = 3
    retry_delay = 0.5

    for attempt in range(max_retries):
        try:
            results = geocoder.geocode(query, exactly_one=False, limit=50, language="en")

            if not results:
                return []

            locations: List[GeocodingLocation] = []

            for result in results:
                if not hasattr(result, "raw"):
                    continue

                raw = result.raw
                properties = raw.get("properties", {})

                if not _is_city_country_or_town_photon(properties):
                    continue

                location_type = properties.get("type", "").lower()
                bounding_box = None
                if "extent" in properties and len(properties["extent"]) == 4:
                    extent = properties["extent"]
                    bounding_box = [extent[1], extent[3], extent[0], extent[2]]

                locations.append(
                    GeocodingLocation(
                        display_name=result.address,
                        latitude=result.latitude,
                        longitude=result.longitude,
                        type=location_type,
                        bounding_box=bounding_box,
                    )
                )

            return locations[:limit]

        except GeocoderTimedOut:
            if attempt < max_retries - 1:
                time.sleep(retry_delay * (2**attempt))
                continue
            raise HTTPException(status_code=504, detail="Geocoding service timed out after retries")
        except GeocoderServiceError as e:
            if attempt < max_retries - 1:
                time.sleep(retry_delay * (2**attempt))
                continue
            raise HTTPException(status_code=503, detail=f"Geocoding service error: {str(e)}")
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Error searching locations: {str(e)}")


def _is_city_country_or_town_photon(properties: dict) -> bool:
    location_type = properties.get("type", "").lower()

    allowed_types = [
        "city",
        "town",
        "village",
        "hamlet",
        "state",
        "country",
    ]

    return location_type in allowed_types


# ── In-memory store for uploaded .nc datasets ─────────────────────────────────
# Maps upload_id  →  {"geo_grid": GeoGrid, "variable": str, "unit": str}
_nc_upload_store: dict = {}

_VARIABLE_COLORMAPS: dict = {
    # temperature-like
    "tas": "RdYlBu_r", "tasmax": "RdYlBu_r", "tasmin": "RdYlBu",
    "tmax": "RdYlBu_r", "tmin": "RdYlBu", "tmp": "RdYlBu_r", "t2m": "RdYlBu_r",
    # precipitation
    "pr": "YlGnBu", "pre": "YlGnBu", "prcp": "YlGnBu", "ppt": "YlGnBu", "tp": "YlGnBu",
    # wind
    "sfcwind": "PuBuGn", "wind": "PuBuGn", "u10": "PuBuGn", "v10": "PuBuGn",
    # humidity / cloud
    "hurs": "Blues", "clt": "Greys",
}


def _choose_colormap(variable: str) -> str:
    key = variable.lower()
    return _VARIABLE_COLORMAPS.get(key, "viridis")


class NcUploadResponse(BaseModel):
    upload_id: str
    variables: list[str]
    selected_variable: str
    unit: str
    time_steps: int
    lat_min: float
    lat_max: float
    lon_min: float
    lon_max: float
    value_min: float
    value_max: float
    image_base64: str


class NcValueResponse(BaseModel):
    upload_id: str
    variable: str
    latitude: float
    longitude: float
    value: float
    unit: str


def _cell_extent(coords: np.ndarray) -> tuple[float, float]:
    """Return (min_edge, max_edge) expanding by half a grid-cell on each side."""
    if len(coords) >= 2:
        half = abs(float(coords[1] - coords[0])) / 2.0
    else:
        half = 0.5
    return float(coords.min()) - half, float(coords.max()) + half


def _render_nc_image(
    values: np.ndarray, lons: np.ndarray, lats: np.ndarray, cmap_name: str,
    lon_extent: tuple[float, float] | None = None,
    lat_extent: tuple[float, float] | None = None,
) -> str:
    """Render a 2-D array as a transparent PNG and return a data-URI."""
    masked = np.ma.masked_invalid(values)
    cmap = plt.cm.get_cmap(cmap_name).copy()
    cmap.set_bad(alpha=0.0)

    lon_min, lon_max = lon_extent or (float(lons.min()), float(lons.max()))
    lat_min, lat_max = lat_extent or (float(lats.min()), float(lats.max()))

    fig, ax = plt.subplots(1, 1, figsize=(18, 9))
    fig.patch.set_alpha(0)
    ax.patch.set_alpha(0)
    ax.imshow(
        masked,
        extent=[lon_min, lon_max, lat_min, lat_max],
        origin="upper",
        cmap=cmap,
        aspect="auto",
        interpolation="bilinear",
    )
    ax.set_xlim(lon_min, lon_max)
    ax.set_ylim(lat_min, lat_max)
    ax.axis("off")
    ax.set_position([0, 0, 1, 1])

    buf = io.BytesIO()
    fig.savefig(buf, format="png", pad_inches=0, transparent=True, dpi=150)
    plt.close(fig)
    buf.seek(0)
    return "data:image/png;base64," + base64.b64encode(buf.read()).decode()


@api.post("/upload-nc", response_model=NcUploadResponse)
async def upload_nc_file(
    file: UploadFile = File(...),
    variable: Optional[str] = Form(default=None),
    time_index: int = Form(default=0),
):
    """Accept a NetCDF (.nc) file, render it as a map overlay, and return metadata."""
    if not file.filename or not file.filename.lower().endswith(".nc"):
        raise HTTPException(status_code=400, detail="Only .nc (NetCDF) files are accepted.")

    content = await file.read()
    if len(content) > 200 * 1024 * 1024:  # 200 MB hard cap
        raise HTTPException(status_code=413, detail="File too large (max 200 MB).")

    tmp_path = None
    try:
        import xarray as xr

        with tempfile.NamedTemporaryFile(suffix=".nc", delete=False) as tmp:
            tmp.write(content)
            tmp_path = tmp.name

        ds = xr.open_dataset(tmp_path, mask_and_scale=True)

        # ── Locate lat/lon coordinates ────────────────────────────────────────
        lat_candidates = ["lat", "latitude", "y", "nav_lat", "rlat", "ylat"]
        lon_candidates = ["lon", "longitude", "x", "nav_lon", "rlon", "xlon"]
        lat_name = next((c for c in lat_candidates if c in ds.coords), None)
        lon_name = next((c for c in lon_candidates if c in ds.coords), None)

        if lat_name is None or lon_name is None:
            raise HTTPException(
                status_code=422,
                detail="Cannot find latitude/longitude coordinates in this NetCDF file.",
            )

        # ── Discover data variables (exclude coord-like dims) ─────────────────
        coord_names = {lat_name, lon_name, "time", "lev", "level", "plev", "depth", "bnds", "bounds"}
        data_vars = [v for v in ds.data_vars if v not in coord_names]
        if not data_vars:
            raise HTTPException(status_code=422, detail="No data variables found in NetCDF file.")

        selected_var = variable if (variable and variable in ds.data_vars) else data_vars[0]

        da = ds[selected_var]

        # ── Handle extra dimensions (time, level, …) ─────────────────────────
        time_dim = next((d for d in da.dims if d in ["time", "t"]), None)
        time_steps = int(da.sizes[time_dim]) if time_dim else 1
        safe_time_index = max(0, min(time_index, time_steps - 1))

        # Drop all dims except lat/lon
        extra_dims = [d for d in da.dims if d not in [lat_name, lon_name]]
        if time_dim and time_dim in extra_dims:
            da = da.isel({time_dim: safe_time_index})
            extra_dims = [d for d in extra_dims if d != time_dim]
        for d in extra_dims:
            da = da.isel({d: 0})

        lats = ds[lat_name].values.astype(float)
        lons = ds[lon_name].values.astype(float)
        values: np.ndarray = da.values.astype(float)

        # ── Ensure lat array is decreasing (north → south) ───────────────────
        if lats.ndim == 1 and lats[0] < lats[-1]:
            lats = lats[::-1]
            values = values[::-1, :]

        # ── Convert 0-360 longitude to -180-180 if needed ────────────────────
        if lons.ndim == 1 and float(lons.max()) > 180:
            shift_idx = int(np.searchsorted(lons, 180.0))
            lons = np.concatenate([lons[shift_idx:] - 360, lons[:shift_idx]])
            values = np.concatenate([values[:, shift_idx:], values[:, :shift_idx]], axis=1)

        if lons.ndim != 1 or lats.ndim != 1:
            raise HTTPException(status_code=422, detail="Only regular (1-D lat/lon) grids are supported.")

        if values.ndim != 2 or values.shape != (len(lats), len(lons)):
            raise HTTPException(
                status_code=422,
                detail=f"Unexpected array shape {values.shape} for lat={len(lats)}, lon={len(lons)}.",
            )

        unit = str(da.attrs.get("units", ""))
        cmap_name = _choose_colormap(selected_var)

        lon_extent = _cell_extent(lons)
        lat_extent = _cell_extent(lats)
        image_b64 = _render_nc_image(values, lons, lats, cmap_name, lon_extent, lat_extent)

        # ── Store grid for point-value queries ────────────────────────────────
        geo_grid = GeoGrid(
            lon_range=lons,
            lat_range=lats,
            values=values,
        )

        upload_id = str(uuid.uuid4())
        _nc_upload_store[upload_id] = {"geo_grid": geo_grid, "variable": selected_var, "unit": unit}

        # Prevent unbounded growth (keep at most 20 uploads)
        if len(_nc_upload_store) > 20:
            oldest = next(iter(_nc_upload_store))
            del _nc_upload_store[oldest]

        ds.close()

        return NcUploadResponse(
            upload_id=upload_id,
            variables=data_vars,
            selected_variable=selected_var,
            unit=unit,
            time_steps=time_steps,
            lat_min=lat_extent[0],
            lat_max=lat_extent[1],
            lon_min=lon_extent[0],
            lon_max=lon_extent[1],
            value_min=float(np.nanmin(values)),
            value_max=float(np.nanmax(values)),
            image_base64=image_b64,
        )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to process NetCDF file: {str(e)}")
    finally:
        if tmp_path and os.path.exists(tmp_path):
            os.unlink(tmp_path)


@api.get("/nc-value/{upload_id}", response_model=NcValueResponse)
def get_nc_point_value(upload_id: str, lat: float, lon: float):
    """Return the interpolated value at (lat, lon) for a previously uploaded .nc dataset."""
    if upload_id not in _nc_upload_store:
        raise HTTPException(status_code=404, detail="Upload not found or has expired.")

    entry = _nc_upload_store[upload_id]
    geo_grid: GeoGrid = entry["geo_grid"]

    try:
        value = geo_grid.get_value_at_coordinate(lon, lat)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    return NcValueResponse(
        upload_id=upload_id,
        variable=entry["variable"],
        latitude=lat,
        longitude=lon,
        value=value,
        unit=entry["unit"],
    )
