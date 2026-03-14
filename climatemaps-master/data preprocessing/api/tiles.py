"""
Tile serializers for 3D globe frontends
---------------------------------------
Converts DataFrames produced by pipeline.query into formats consumed by
common globe renderers (deck.gl / Cesium / Three.js):

  to_geojson_grid   → FeatureCollection of Point features (region snapshot)
  to_h3_hexes       → list of {hex, value, color} dicts (H3 hex-layer)
  colormap          → maps a float in [0,1] to an [R,G,B] list (viridis-like)
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np
import pandas as pd

# ── colour mapping ─────────────────────────────────────────────────────────────
# Simplified 8-stop viridis approximation stored as (r,g,b) 0-255 tuples
_VIRIDIS_STOPS: list[tuple[int, int, int]] = [
    (68,  1,  84),   # 0.00
    (72,  40, 120),  # 0.14
    (62,  74, 137),  # 0.29
    (49, 104, 142),  # 0.43
    (38, 130, 142),  # 0.57
    (53, 183, 121),  # 0.71
    (144, 215, 67),  # 0.86
    (253, 231,  37), # 1.00
]


def colormap(value: float) -> list[int]:
    """Map a normalised value [0,1] to an [R, G, B] list (viridis)."""
    value = max(0.0, min(1.0, value))
    n = len(_VIRIDIS_STOPS) - 1
    lo = int(value * n)
    hi = min(lo + 1, n)
    t = value * n - lo
    r = round(_VIRIDIS_STOPS[lo][0] + t * (_VIRIDIS_STOPS[hi][0] - _VIRIDIS_STOPS[lo][0]))
    g = round(_VIRIDIS_STOPS[lo][1] + t * (_VIRIDIS_STOPS[hi][1] - _VIRIDIS_STOPS[lo][1]))
    b = round(_VIRIDIS_STOPS[lo][2] + t * (_VIRIDIS_STOPS[hi][2] - _VIRIDIS_STOPS[lo][2]))
    return [r, g, b]


def _norm(values: pd.Series, vmin: float | None, vmax: float | None):
    lo = vmin if vmin is not None else float(values.min())
    hi = vmax if vmax is not None else float(values.max())
    span = hi - lo or 1.0
    return (values - lo) / span, lo, hi


_VIRIDIS_NP = np.array(_VIRIDIS_STOPS, dtype=np.float32)  # (8, 3)


def _vectorized_colormap(t_arr: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Vectorized viridis colormap. t_arr must be clipped to [0, 1]."""
    n = len(_VIRIDIS_STOPS) - 1
    lo_idx = np.floor(t_arr * n).astype(np.int32).clip(0, n - 1)
    hi_idx = (lo_idx + 1).clip(0, n)
    f = t_arr * n - lo_idx
    rs = np.round(_VIRIDIS_NP[lo_idx, 0] + f * (_VIRIDIS_NP[hi_idx, 0] - _VIRIDIS_NP[lo_idx, 0])).astype(np.int32)
    gs = np.round(_VIRIDIS_NP[lo_idx, 1] + f * (_VIRIDIS_NP[hi_idx, 1] - _VIRIDIS_NP[lo_idx, 1])).astype(np.int32)
    bs = np.round(_VIRIDIS_NP[lo_idx, 2] + f * (_VIRIDIS_NP[hi_idx, 2] - _VIRIDIS_NP[lo_idx, 2])).astype(np.int32)
    return rs, gs, bs


def to_compact(
    df: pd.DataFrame,
    vmin: float | None = None,
    vmax: float | None = None,
) -> dict[str, Any]:
    """
    Compact flat-array format — far smaller than GeoJSON, fully vectorized.
    Returns: { lats, lons, rs, gs, bs, values, meta }
    Frontend renders this 10-20x faster than a GeoJSON FeatureCollection.
    """
    if df.empty:
        return {"lats": [], "lons": [], "rs": [], "gs": [], "bs": [], "values": [],
                "meta": {"count": 0, "vmin": 0.0, "vmax": 0.0, "valid_time": None}}

    vals = df["value_C"].to_numpy(dtype=np.float32)
    lo = float(vmin) if vmin is not None else float(vals.min())
    hi = float(vmax) if vmax is not None else float(vals.max())
    span = hi - lo if hi != lo else 1.0

    t = np.clip((vals - lo) / span, 0.0, 1.0)
    rs, gs, bs = _vectorized_colormap(t)

    return {
        "lats":   df["latitude"].round(3).tolist(),
        "lons":   df["longitude"].round(3).tolist(),
        "rs":     rs.tolist(),
        "gs":     gs.tolist(),
        "bs":     bs.tolist(),
        "values": vals.round(2).tolist(),
        "meta": {
            "count":      len(df),
            "vmin":       round(lo, 2),
            "vmax":       round(hi, 2),
            "valid_time": str(df["valid_time"].iloc[0]),
        },
    }


# ── GeoJSON grid ──────────────────────────────────────────────────────────────

def to_geojson_grid(
    df: pd.DataFrame,
    vmin: float | None = None,
    vmax: float | None = None,
) -> dict[str, Any]:
    """
    Convert a region-query DataFrame to a GeoJSON FeatureCollection.

    Each grid point becomes a GeoJSON Point feature with properties:
        t2m_C, t2m_K, color ([R,G,B]), norm (0-1)

    Parameters
    ----------
    df   : output of query_region()
    vmin : lower bound for colour normalisation (defaults to df min)
    vmax : upper bound for colour normalisation (defaults to df max)
    """
    norm_vals, lo, hi = _norm(df["value_C"], vmin, vmax)

    features: list[dict] = []
    for i, row in enumerate(df.itertuples(index=False)):
        norm_v = float(norm_vals.iloc[i])
        features.append(
            {
                "type": "Feature",
                "geometry": {
                    "type": "Point",
                    "coordinates": [float(row.longitude), float(row.latitude)],
                },
                "properties": {
                    "value_C": float(row.value_C),
                    "value_raw": float(row.value_raw),
                    "norm": round(norm_v, 4),
                    "color": colormap(norm_v),
                },
            }
        )

    return {
        "type": "FeatureCollection",
        "features": features,
        "meta": {
            "count": len(features),
            "vmin": lo,
            "vmax": hi,
            "valid_time": str(df["valid_time"].iloc[0]) if len(df) else None,
        },
    }


# ── H3 hex layer ──────────────────────────────────────────────────────────────

def to_h3_hexes(
    df: pd.DataFrame,
    vmin: float | None = None,
    vmax: float | None = None,
) -> dict[str, Any]:
    """
    Convert a region-query DataFrame to H3 hex objects for deck.gl H3HexagonLayer.

    Aggregates multiple grid points that fall into the same H3 cell by mean.

    Returns a dict with:
        hexes  : list of {hex, value, color, norm}
        meta   : {count, vmin, vmax, valid_time}
    """
    import h3 as _h3

    H3_RES = 4

    df = df.copy()
    df["h3_id"] = df.apply(
        lambda r: _h3.latlng_to_cell(float(r["latitude"]), float(r["longitude"]), H3_RES),
        axis=1,
    )

    agg = df.groupby("h3_id", sort=False)["value_C"].mean().reset_index()
    agg.columns = ["hex", "value"]

    norm_vals, lo, hi = _norm(agg["value"], vmin, vmax)
    agg["norm"] = norm_vals.round(4)
    agg["color"] = agg["norm"].apply(colormap)
    agg["value"] = agg["value"].round(2)

    return {
        "hexes": agg.to_dict(orient="records"),
        "meta": {
            "count": len(agg),
            "vmin": round(lo, 2),
            "vmax": round(hi, 2),
            "valid_time": str(df["valid_time"].iloc[0]) if len(df) else None,
        },
    }
