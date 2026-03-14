"""
Globe API — FastAPI server (multi-dataset)
==========================================
Exposes the pipeline as a REST API for 3D globe frontends.

Dataset lifecycle
-----------------
  POST /datasets/upload      — upload .nc file, auto-detect config, register
  POST /datasets/{id}/build  — launch 3-stage pipeline in background
  GET  /datasets             — list all datasets with status
  GET  /datasets/{id}        — dataset detail

Query endpoints (scoped to a dataset)
--------------------------------------
  GET  /health
  GET  /meta?dataset_id=
  GET  /point?dataset_id=&lat=&lon=…
  GET  /region?dataset_id=…
  GET  /region/h3?dataset_id=…
  GET  /global?dataset_id=…
  GET  /global/h3?dataset_id=…

Run
---
  uvicorn api.server:app --reload --host 0.0.0.0 --port 8000
"""

from __future__ import annotations

import shutil
import threading
import traceback
import warnings
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Annotated, Any

import pandas as pd
import xarray as xr
from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from pipeline.config import DATA_ROOT, DatasetConfig, LOD_STRIDES
from pipeline import registry
from pipeline.inspector import inspect_nc
from pipeline.zarr_chunker import convert_to_zarr
from pipeline.lod_builder import build_lod
from pipeline.h3_indexer import build_h3_index
from pipeline.query import get_engine
from api.tiles import to_geojson_grid, to_h3_hexes, to_compact

app = FastAPI(
    title="Globe API",
    description="Multi-dataset NetCDF pipeline served for 3D globe visualisation.",
    version="2.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

MAX_UPLOAD_BYTES = 20 * 1024 * 1024 * 1024  # 20 GB

# ── helpers ────────────────────────────────────────────────────────────────────

def _resolve_dataset(dataset_id: str | None) -> str:
    """Return a valid dataset_id or raise 400."""
    if dataset_id:
        entry = registry.get(dataset_id)
        if entry is None:
            raise HTTPException(404, f"Dataset '{dataset_id}' not found.")
        if entry["status"] != "ready":
            raise HTTPException(409, f"Dataset '{dataset_id}' is not ready (status={entry['status']}).")
        return dataset_id
    # Fall back to the first ready dataset
    for did, entry in registry.list_all().items():
        if entry["status"] == "ready":
            return did
    raise HTTPException(404, "No ready datasets. Upload and build one first.")


def _validate_lod(lod: str) -> None:
    if lod not in LOD_STRIDES:
        raise HTTPException(400, f"Unknown LoD '{lod}'. Valid: L0 L1 L2 L3.")


# ── dataset lifecycle endpoints ───────────────────────────────────────────────

@app.post("/datasets/upload")
async def upload_dataset(file: UploadFile = File(...)) -> JSONResponse:
    """Upload a .nc file, auto-detect config, register the dataset."""
    if not file.filename or not file.filename.endswith(".nc"):
        raise HTTPException(400, "Only .nc files are accepted.")

    dataset_id = Path(file.filename).stem
    dest_dir = DATA_ROOT / dataset_id
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest_path = dest_dir / "source.nc"

    # Stream to disk
    size = 0
    with open(dest_path, "wb") as f:
        while chunk := await file.read(8 * 1024 * 1024):
            size += len(chunk)
            if size > MAX_UPLOAD_BYTES:
                dest_path.unlink(missing_ok=True)
                raise HTTPException(413, "File too large (>20 GB).")
            f.write(chunk)

    try:
        cfg = inspect_nc(str(dest_path), dataset_id=dataset_id)
    except ValueError as exc:
        dest_path.unlink(missing_ok=True)
        raise HTTPException(422, str(exc)) from exc

    entry = registry.register(cfg)
    return JSONResponse(status_code=201, content={
        "dataset_id": dataset_id,
        "variable": cfg.variable,
        "time_dim": cfg.time_dim,
        "lat_dim": cfg.lat_dim,
        "lon_dim": cfg.lon_dim,
        "status": entry["status"],
    })


def _run_pipeline(cfg: DatasetConfig) -> None:
    """Run the 3-stage pipeline in a background thread."""
    try:
        registry.update_status(cfg.dataset_id, "building")
        convert_to_zarr(cfg)
        build_lod(cfg)
        build_h3_index(cfg)
        registry.update_status(cfg.dataset_id, "ready")
    except Exception:
        registry.update_status(cfg.dataset_id, "failed", error=traceback.format_exc())


@app.post("/datasets/{dataset_id}/build")
def build_dataset(dataset_id: str) -> JSONResponse:
    """Launch the pipeline asynchronously for a registered dataset."""
    entry = registry.get(dataset_id)
    if entry is None:
        raise HTTPException(404, f"Dataset '{dataset_id}' not found.")
    if entry["status"] in ("building",):
        raise HTTPException(409, "Build already in progress.")

    cfg = DatasetConfig.from_dict(entry["config"])
    thread = threading.Thread(target=_run_pipeline, args=(cfg,), daemon=True)
    thread.start()
    registry.update_status(dataset_id, "building")
    return JSONResponse(content={"dataset_id": dataset_id, "status": "building"})


@app.get("/datasets")
def list_datasets() -> JSONResponse:
    """List all registered datasets with their status."""
    out = {}
    for did, entry in registry.list_all().items():
        out[did] = {
            "status": entry["status"],
            "variable": entry["config"].get("variable"),
            "created_at": entry.get("created_at"),
            "error": entry.get("error"),
        }
    return JSONResponse(content=out)


@app.get("/datasets/{dataset_id}")
def dataset_detail(dataset_id: str) -> JSONResponse:
    """Full detail for a single dataset."""
    entry = registry.get(dataset_id)
    if entry is None:
        raise HTTPException(404, f"Dataset '{dataset_id}' not found.")
    cfg = DatasetConfig.from_dict(entry["config"])
    # Collect artefact sizes
    artefacts = {}
    for name, path in [
        ("zarr_store", cfg.zarr_store),
        *[(f"lod_{lv}", cfg.lod_store(lv)) for lv in ("L2", "L1", "L0")],
        ("h3_index", cfg.h3_index_file),
    ]:
        p = Path(path)
        if p.exists():
            size = sum(f.stat().st_size for f in p.rglob("*") if f.is_file()) if p.is_dir() else p.stat().st_size
            artefacts[name] = f"{size / 1e6:.1f} MB"
        else:
            artefacts[name] = None
    return JSONResponse(content={
        "dataset_id": dataset_id,
        "status": entry["status"],
        "config": entry["config"],
        "artefacts": artefacts,
        "created_at": entry.get("created_at"),
        "error": entry.get("error"),
    })


# ── query endpoints ───────────────────────────────────────────────────────────

@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


@app.get("/meta")
def meta(
    dataset_id: Annotated[str | None, Query()] = None,
) -> dict[str, Any]:
    """Return dataset metadata: available time range and LoD levels."""
    did = _resolve_dataset(dataset_id)
    engine = get_engine(did)
    cfg = engine.cfg
    ds = engine._ds("L3")
    times = ds[cfg.time_dim].values
    n_lat = int(ds.sizes[cfg.lat_dim])
    n_lon = int(ds.sizes[cfg.lon_dim])

    import math
    lod_info = {}
    for lv, stride in LOD_STRIDES.items():
        lod_info[lv] = {
            "grid": f"{math.ceil(n_lat / stride)} × {math.ceil(n_lon / stride)}",
        }

    return {
        "dataset_id": did,
        "variable": cfg.variable,
        "time_start": str(times[0]),
        "time_end":   str(times[-1]),
        "n_timesteps": int(len(times)),
        "lod_levels": lod_info,
    }


@app.get("/point")
def point(
    lat: Annotated[float, Query()],
    lon: Annotated[float, Query()],
    time_start: Annotated[str | None, Query()] = None,
    time_end:   Annotated[str | None, Query()] = None,
    lod: Annotated[str, Query()] = "L3",
    dataset_id: Annotated[str | None, Query()] = None,
) -> JSONResponse:
    """Time-series for a single lat/lon point."""
    did = _resolve_dataset(dataset_id)
    _validate_lod(lod)
    try:
        engine = get_engine(did)
        df = engine.query_point(lat=lat, lon=lon, time_start=time_start, time_end=time_end, lod=lod)
    except Exception as exc:
        raise HTTPException(500, str(exc)) from exc

    df["valid_time"] = df["valid_time"].astype(str)
    return JSONResponse(content={
        "dataset_id": did,
        "lod": lod,
        "lat": lat,
        "lon": lon,
        "n_rows": len(df),
        "data": df.to_dict(orient="records"),
    })


@app.get("/region")
def region(
    lat_min: Annotated[float, Query()] = -90.0,
    lat_max: Annotated[float, Query()] = 90.0,
    lon_min: Annotated[float, Query()] = 0.0,
    lon_max: Annotated[float, Query()] = 360.0,
    time_step: Annotated[str | None, Query()] = None,
    lod: Annotated[str, Query()] = "L1",
    vmin: Annotated[float | None, Query()] = None,
    vmax: Annotated[float | None, Query()] = None,
    dataset_id: Annotated[str | None, Query()] = None,
) -> JSONResponse:
    """Spatial snapshot as a GeoJSON FeatureCollection."""
    did = _resolve_dataset(dataset_id)
    _validate_lod(lod)
    try:
        engine = get_engine(did)
        df = engine.query_region(
            lat_min=lat_min, lat_max=lat_max,
            lon_min=lon_min, lon_max=lon_max,
            time_step=time_step, lod=lod,
        )
    except Exception as exc:
        raise HTTPException(500, str(exc)) from exc

    return JSONResponse(content=to_geojson_grid(df, vmin=vmin, vmax=vmax))


@app.get("/region/h3")
def region_h3(
    lat_min: Annotated[float, Query()] = -90.0,
    lat_max: Annotated[float, Query()] = 90.0,
    lon_min: Annotated[float, Query()] = 0.0,
    lon_max: Annotated[float, Query()] = 360.0,
    time_step: Annotated[str | None, Query()] = None,
    lod: Annotated[str, Query()] = "L1",
    vmin: Annotated[float | None, Query()] = None,
    vmax: Annotated[float | None, Query()] = None,
    dataset_id: Annotated[str | None, Query()] = None,
) -> JSONResponse:
    """Spatial snapshot as H3 hex objects."""
    did = _resolve_dataset(dataset_id)
    _validate_lod(lod)
    try:
        engine = get_engine(did)
        df = engine.query_region(
            lat_min=lat_min, lat_max=lat_max,
            lon_min=lon_min, lon_max=lon_max,
            time_step=time_step, lod=lod,
        )
    except Exception as exc:
        raise HTTPException(500, str(exc)) from exc

    return JSONResponse(content=to_h3_hexes(df, vmin=vmin, vmax=vmax))


@app.get("/global")
def global_snapshot(
    time_step: Annotated[str | None, Query()] = None,
    lod: Annotated[str, Query()] = "L1",
    vmin: Annotated[float | None, Query()] = None,
    vmax: Annotated[float | None, Query()] = None,
    dataset_id: Annotated[str | None, Query()] = None,
) -> JSONResponse:
    """Full global snapshot as compact flat arrays."""
    did = _resolve_dataset(dataset_id)
    _validate_lod(lod)
    try:
        engine = get_engine(did)
        df = engine.query_region(
            lat_min=-90, lat_max=90, lon_min=0, lon_max=360,
            time_step=time_step, lod=lod,
        )
    except Exception as exc:
        raise HTTPException(500, str(exc)) from exc

    return JSONResponse(content=to_compact(df, vmin=vmin, vmax=vmax))


@app.get("/global/h3")
def global_h3(
    time_step: Annotated[str | None, Query()] = None,
    lod: Annotated[str, Query()] = "L1",
    vmin: Annotated[float | None, Query()] = None,
    vmax: Annotated[float | None, Query()] = None,
    dataset_id: Annotated[str | None, Query()] = None,
) -> JSONResponse:
    """Full global snapshot as H3 hex objects."""
    did = _resolve_dataset(dataset_id)
    _validate_lod(lod)
    try:
        engine = get_engine(did)
        df = engine.query_region(
            lat_min=-90, lat_max=90, lon_min=0, lon_max=360,
            time_step=time_step, lod=lod,
        )
    except Exception as exc:
        raise HTTPException(500, str(exc)) from exc

    return JSONResponse(content=to_h3_hexes(df, vmin=vmin, vmax=vmax))


# ── comparison endpoints ──────────────────────────────────────────────────────

@app.get("/compare")
def compare_snapshot(
    dataset_id_a: Annotated[str, Query()],
    dataset_id_b: Annotated[str, Query()],
    time_step: Annotated[str | None, Query()] = None,
    lod: Annotated[str, Query()] = "L1",
) -> JSONResponse:
    """
    Side-by-side global snapshot for two datasets.
    Both colour-normalised to the same shared scale for direct comparison.
    Returns compact flat arrays (not GeoJSON) for fast frontend rendering.
    """
    _validate_lod(lod)
    did_a = _resolve_dataset(dataset_id_a)
    did_b = _resolve_dataset(dataset_id_b)

    def _fetch(did: str):
        return get_engine(did).query_region(
            lat_min=-90, lat_max=90, lon_min=0, lon_max=360,
            time_step=time_step, lod=lod,
        )

    # Run both Zarr reads in parallel — typically halves query time.
    with ThreadPoolExecutor(max_workers=2) as ex:
        fut_a, fut_b = ex.submit(_fetch, did_a), ex.submit(_fetch, did_b)
        try:
            df_a, df_b = fut_a.result(), fut_b.result()
        except Exception as exc:
            raise HTTPException(500, str(exc)) from exc

    all_vals = pd.concat([df_a["value_C"], df_b["value_C"]])
    shared_vmin = float(all_vals.min())
    shared_vmax = float(all_vals.max())

    return JSONResponse(content={
        "dataset_a": to_compact(df_a, vmin=shared_vmin, vmax=shared_vmax),
        "dataset_b": to_compact(df_b, vmin=shared_vmin, vmax=shared_vmax),
        "meta": {
            "vmin": shared_vmin,
            "vmax": shared_vmax,
            "valid_time": str(df_a["valid_time"].iloc[0]) if len(df_a) else None,
            "lod": lod,
        },
    })


@app.get("/compare/point")
def compare_point(
    lat: Annotated[float, Query()],
    lon: Annotated[float, Query()],
    dataset_id_a: Annotated[str, Query()],
    dataset_id_b: Annotated[str, Query()],
    time_start: Annotated[str | None, Query()] = None,
    time_end:   Annotated[str | None, Query()] = None,
    lod: Annotated[str, Query()] = "L3",
) -> JSONResponse:
    """
    Time-series for two datasets at the same lat/lon point.
    Returns: { lat, lon, dataset_a: {id, data: [...]}, dataset_b: {id, data: [...]} }
    """
    _validate_lod(lod)
    did_a = _resolve_dataset(dataset_id_a)
    did_b = _resolve_dataset(dataset_id_b)
    try:
        df_a = get_engine(did_a).query_point(
            lat=lat, lon=lon, time_start=time_start, time_end=time_end, lod=lod
        )
        df_b = get_engine(did_b).query_point(
            lat=lat, lon=lon, time_start=time_start, time_end=time_end, lod=lod
        )
    except Exception as exc:
        raise HTTPException(500, str(exc)) from exc

    df_a["valid_time"] = df_a["valid_time"].astype(str)
    df_b["valid_time"] = df_b["valid_time"].astype(str)

    return JSONResponse(content={
        "lat": lat,
        "lon": lon,
        "dataset_a": {"id": did_a, "data": df_a.to_dict(orient="records")},
        "dataset_b": {"id": did_b, "data": df_b.to_dict(orient="records")},
    })
