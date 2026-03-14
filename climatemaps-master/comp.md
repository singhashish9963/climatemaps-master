# Project Comparison: ClimateMAPS vs PyClimaExplorer

This document compares the existing **ClimateMAPS** project with the proposed **PyClimaExplorer** concept, covering shared ground, key differences, and an honest estimate of the engineering effort required to align the two.

---

## 1. At a Glance

| Dimension | ClimateMAPS (current) | PyClimaExplorer (proposed) |
|---|---|---|
| **Purpose** | Interactive web map of pre-processed global climate datasets | Interactive dashboard for raw multi-dimensional climate model output |
| **Primary frontend** | Angular 18 TypeScript SPA | Streamlit Python dashboard |
| **Map renderer** | Leaflet (2-D, CPU) | PyDeck (2-D/3-D, WebGL / GPU) |
| **3-D visualization** | None | Full 3-D topographical heatmap |
| **Spatial grid model** | Rectangular lat/lon (GeoGrid) | H3 hexagonal DGGS |
| **Data format** | GeoTIFF (multi-band, pre-processed) | NetCDF → Zarr (cloud-native chunked) |
| **Data sources** | WorldClim 2.1, WorldClim CMIP6, CRU TS | ERA5, CESM raw simulation output |
| **Tile strategy** | Pre-generated MBTiles (offline batch) | Dynamic on-demand WebGL rendering |
| **Anomaly/difference** | Difference maps: future − historical | Automated Z-score engine (sliding-window) |
| **Story / guided tour** | Not present | Automated camera-pilot to extreme events |
| **Level of Detail** | Fixed spatial resolution per dataset | Dynamic LoD (bicubic downsample for global view, full-res on zoom) |
| **Backend framework** | FastAPI (Python) | No explicit backend — Streamlit handles serving |
| **Infrastructure** | Docker Compose + tileserver-gl + GDAL + tippecanoe | Single-process Streamlit application |
| **Charting** | Chart.js (via Angular) | Plotly |
| **Multi-model ensemble** | ✅ Yes (10 CMIP6 models, mean + std dev) | Not mentioned |
| **SSP scenarios** | ✅ 4 scenarios (SSP1-2.6 → SSP5-8.5) | Not mentioned |
| **Geocoding / nearest city** | ✅ Yes (Photon + citipy) | Not mentioned |
| **Rate limiting** | ✅ Yes (sliding-window, 1 000 req/min/IP) | Not mentioned |

---

## 2. Similarities

The two projects share a meaningful set of concepts, even though their technical implementations differ.

### 2.1 Domain & Purpose
Both projects:
- Visualize **global climate variables** (temperature, precipitation, and related metrics) on interactive maps.
- Support **temporal exploration** (multiple time periods).
- Target both **researchers and the general public**.
- Present **anomaly / deviation data** alongside absolute values.

### 2.2 Statistical Methods
- **Ensemble aggregation:** ClimateMAPS computes `np.nanmean` and `np.nanstd` across 10 CMIP6 models. PyClimaExplorer proposes a Z-score engine that requires a historical mean (μ) and standard deviation (σ) — the same operations, applied over the time dimension rather than the model dimension.
- **Spatial interpolation for upsampling:** ClimateMAPS uses `scipy.ndimage.zoom` (linear spline) when upsampling grids before tile generation. PyClimaExplorer proposes bicubic spline interpolation for its LoD downsample pass. Both apply spline-family techniques to resample gridded data.

### 2.3 Python Data Processing Pipeline
Both projects are Python-first for data processing:
- Reading raster/array data → applying conversions → producing gridded output for downstream rendering.
- Auto-downloading or cloud-fetching raw source files before processing.
- Logging, error handling, and atomic/safe file writes.

### 2.4 Time-Series Charts Alongside the Map
Both present **monthly/temporal time-series plots** paired with the spatial map (Chart.js in ClimateMAPS, Plotly in PyClimaExplorer).

### 2.5 Point-Value Query
Both provide a way to retrieve the climate value at a specific lat/lon point:
- ClimateMAPS: `GET /v1/value/{data_type}/{month}?lat=&lon=` via `scipy.interpolate.RegularGridInterpolator` (bilinear).
- PyClimaExplorer: clicking the PyDeck canvas queries the underlying xarray/Zarr data at that coordinate.

---

## 3. Differences (Detailed)

### 3.1 Data Format & Source — FUNDAMENTAL difference

| | ClimateMAPS | PyClimaExplorer |
|---|---|---|
| **File format** | GeoTIFF (12-band, one per month) | NetCDF (`.nc`) raw model output |
| **Storage layout** | Flat files on disk | Zarr stores (chunked by variable/time/space) |
| **Data origin** | Downscaled, bias-corrected WorldClim products | Raw CESM/ERA5 simulation output (gigabyte-scale arrays) |
| **Cloud-readiness** | None — local disk only | Native: Zarr is the Pangeo/NCAR standard for cloud-hosted climate data |
| **On-demand loading** | No — entire band read into `GeoGrid` per request | Yes — only the chunks covering the requested spatial/temporal window are loaded |

**Why it matters:** ClimateMAPS pre-processes everything into tiles; the raw data is only read during the offline batch `create_contour.py` run. PyClimaExplorer reads raw data dynamically at query time, which demands a far more efficient data layout.

### 3.2 Spatial Grid Model — FUNDAMENTAL difference

| | ClimateMAPS | PyClimaExplorer |
|---|---|---|
| **Grid type** | Regular rectangular lat/lon | H3 hexagonal DGGS (Discrete Global Grid System) |
| **Core structure** | `GeoGrid` (Pydantic model: `lon_range`, `lat_range`, `values` 2-D numpy array) | H3 cell index → value mapping (dict/DataFrame) |
| **Polar distortion** | Present (Mercator projection) | Eliminated by design (H3 equal-area hexagons) |
| **Neighbor distances** | Unequal at high latitudes | Uniform (center-to-center distance is equal for all 6 neighbors) |

This difference affects the **entire data pipeline** from the data reader through storage, the API response format, and the frontend renderer.

### 3.3 Rendering Stack — FUNDAMENTAL difference

| | ClimateMAPS | PyClimaExplorer |
|---|---|---|
| **Library** | Leaflet | PyDeck (deck.gl wrapper) |
| **Acceleration** | CPU only | GPU (WebGL canvas) |
| **Dimensionality** | 2-D flat map only | 2-D + 3-D topographical heatmap |
| **Tile mechanism** | Pre-generated raster `.mbtiles` + vector `.mbtiles` served by tileserver-gl | H3 indices passed directly to PyDeck's canvas — no pre-generation needed |
| **Rendering location** | Server generates tiles; browser renders | Browser GPU renders millions of H3 cells directly |

### 3.4 Tile Strategy — Architecture-level difference

ClimateMAPS separates concerns: a **batch offline pipeline** (`create_contour.py`) generates all tiles once; at runtime the API only serves cached `GeoGrid` objects for point queries and directs the frontend to the pre-built tile server.

PyClimaExplorer has **no tile server or batch generation step**. Zarr chunking means any spatial/temporal window can be loaded on-demand; PyDeck renders from raw data on the client GPU.

### 3.5 Anomaly Detection — Feature difference

| | ClimateMAPS | PyClimaExplorer |
|---|---|---|
| **What exists** | Difference maps: `future_grid.difference(historical_grid)` (simple subtraction) | Z-score: `Z(x,y,t) = (T(x,y,t) − μ(x,y)) / σ(x,y)` |
| **Trigger** | User selects a "difference" dataset from the dropdown | Automated sliding-window scan over the full 4-D array |
| **Output** | A rendered tile layer showing Δ values | A ranked list of extreme anomaly events (Z > 3) |
| **Story mode** | Not present | Camera auto-pilots to each extreme event location |

ClimateMAPS computes ensemble standard deviation (a spatial field of model uncertainty), which is conceptually related but not the same: it captures **inter-model spread**, not **temporal anomaly relative to a baseline**.

### 3.6 Frontend Framework — Architecture-level difference

| | ClimateMAPS | PyClimaExplorer |
|---|---|---|
| **Language** | TypeScript (Angular 18 SPA) | Python (Streamlit) |
| **Build pipeline** | `ng build` → static assets | No build step; Streamlit runs `app.py` directly |
| **Component model** | Angular modules, services, decorators | Streamlit reactive widgets (top-to-bottom Python script) |
| **Size** | ~61 TypeScript files, Angular Material, Chart.js, Leaflet | Single Python file + PyDeck + Plotly |
| **Deployment** | Separate frontend build + nginx/CDN | `streamlit run app.py` (single process) |

### 3.7 Infrastructure Complexity

| | ClimateMAPS | PyClimaExplorer |
|---|---|---|
| **Services** | FastAPI + tileserver-gl + Angular dev server (3 processes) | `streamlit run` (1 process) |
| **System deps** | GDAL 3.11, tippecanoe 1.19.1, Node.js, libsqlite3-dev | Python + pip (h3, pydeck, zarr, xarray, streamlit) |
| **Containers** | Docker Compose (2 containers) | Docker single container or direct `pip install` |
| **Offline pre-processing** | Required (can take hours for all datasets) | Not required (Zarr is queried live) |

---

## 4. Alignment Effort Estimate

The following table estimates the engineering effort to add each PyClimaExplorer capability to ClimateMAPS. Estimates assume a single experienced Python/GIS developer working full-time.

> **Baseline assumption:** "Align" means adding PyClimaExplorer capabilities to ClimateMAPS (hybrid approach), not a full rewrite.

| # | Feature area | Complexity | Estimated effort | Notes |
|---|---|---|---|---|
| 1 | **NetCDF reader** (xarray-based, alongside existing GeoTIFF readers) | Medium | 1–2 weeks | Add `DataFormat.NETCDF` case to `data.py`; new `read_netcdf()` in `geotiff.py`; add `xarray`, `netcdf4` dependencies |
| 2 | **ERA5 / CESM data download** pipeline | Medium | 1–2 weeks | New `download.py` functions using the CDS API or AWS S3; similar pattern to existing `download_historical_data()` |
| 3 | **Zarr conversion & chunking pipeline** | High | 2–3 weeks | New script `create_zarr.py`; integrate `zarr` + `rechunker`; design chunk layout (time × lat × lon) for efficient access |
| 4 | **Dynamic Level-of-Detail loading** | High | 3–4 weeks | Replace fixed `GeoGrid` load-all-at-once with `xarray.Dataset.sel()` + spatial indexing by bounding box; changes API response contract |
| 5 | **H3 hexagonal spatial indexing** | Very High | 4–6 weeks | Replace `GeoGrid` rectangular model with H3 cell → value mapping throughout the entire pipeline; affects `geogrid.py`, `contour.py`, all tile generation, API response, and frontend |
| 6 | **Z-score anomaly detection engine** (backend) | Medium | 1–2 weeks | New `anomaly.py` module; `scipy`/`numpy` rolling mean + std dev over time axis; new API endpoint `/v1/anomalies` |
| 7 | **Story mode UI** (automated camera tour) | High | 2–3 weeks | Frontend: ranked anomaly list, animated map pan/zoom to anomaly locations; no counterpart exists in Angular today |
| 8 | **PyDeck / WebGL 3-D rendering** | Very High | 4–6 weeks | Either: (a) replace Angular with Streamlit (full frontend rewrite), or (b) embed a PyDeck deck.gl JSON spec inside Angular using the deck.gl JS library directly |
| 9 | **3-D topographical heatmap layer** | High | 2–3 weeks | Depends on #8; add elevation-mapped H3 hexagon layer to PyDeck |
| 10 | **Plotly time-series charts** (replace Chart.js) | Low | 0.5–1 week | Chart.js is already working; only replace if full Streamlit rewrite is chosen |
| 11 | **Streamlit frontend** (full replacement) | Very High | 5–8 weeks | Rewrite all Angular components (map, layer controls, scenario/month/year selectors, tooltips, geocoding search) in Python/Streamlit; high risk of feature regression |

### 4.1 Summary Totals

| Approach | Which items | Total effort |
|---|---|---|
| **Minimal additions only** (anomaly detection + NetCDF/ERA5 support) | #1, #2, #6 | **3–6 weeks** |
| **Hybrid: add Zarr + LoD + story mode, keep Angular** | #1–4, #6–7 | **10–16 weeks** |
| **Partial H3 + 3-D (no frontend replacement)** | #1–4, #5, #6–9 | **18–27 weeks** |
| **Full alignment (all 11 items, Streamlit rewrite)** | #1–11 | **25–40 weeks** |

---

## 5. Reusable Components from ClimateMAPS

Even in a full-alignment scenario, the following existing code is directly reusable or needs only minor adaptation:

| Component | File(s) | Reusability |
|---|---|---|
| Climate variable definitions (names, units, filenames) | `datasets.py` — `ClimateVarKey`, `ClimateVariable`, `CLIMATE_VARIABLES` | ✅ Fully reusable |
| SSP scenario definitions | `datasets.py` — `ClimateScenario` | ✅ Fully reusable |
| Ensemble mean / std dev computation | `ensemble.py` | ✅ Fully reusable (operates on numpy arrays) |
| Download infrastructure patterns | `download.py` | ✅ Reusable as a template for ERA5/CESM downloaders |
| Contour level configs & colormaps | `contour_config.py`, `datasets.py — CLIMATE_*_CONTOUR_CONFIGS` | ✅ Reusable (colormap + level ranges are format-independent) |
| Statistical computation helpers | `geogrid.py — difference()`, `ensemble.py` | ✅ Logic reusable; `GeoGrid` class itself needs extension |
| Rate limiting middleware | `api/middleware.py` | ✅ Reusable as-is if FastAPI is kept |
| In-memory caching | `api/cache.py` | ✅ Reusable; adapt cache key for Zarr chunk windows |
| Geocoding / nearest-city endpoints | `api/main.py` | ✅ Reusable; independent of data format |
| Pydantic validation patterns | `geogrid.py`, `contour_config.py` | ✅ Pattern reusable for new data models |
| Rectangular-grid data readers | `geotiff.py` | 🔶 Partially reusable; new NetCDF reader follows the same return contract |
| ContourTileBuilder (raster + vector tiles) | `contour.py` | 🔶 Reusable only if MBTiles tile serving is retained alongside PyDeck |
| Angular frontend (all components/services) | `client/` | ❌ Not reusable if switching to Streamlit; partially reusable if keeping Angular + adding deck.gl |

---

## 6. Conclusion

ClimateMAPS and PyClimaExplorer are **conceptually aligned** (both visualize global climate data interactively and compute anomalies/statistics), but they make **fundamentally different choices** at almost every architectural layer:

- **Data format:** GeoTIFF (static, pre-processed) vs NetCDF/Zarr (dynamic, cloud-native)
- **Spatial model:** rectangular lat/lon grid vs H3 hexagonal DGGS
- **Rendering:** 2-D CPU Leaflet tiles vs 3-D GPU WebGL via PyDeck
- **Anomaly detection:** manual difference maps vs automated Z-score story engine
- **Frontend:** Angular 18 TypeScript SPA vs Streamlit Python dashboard

A **minimal addition** of NetCDF/ERA5 support and a Z-score anomaly backend would take **3–6 weeks** and delivers the most novel features of PyClimaExplorer with the least disruption to the existing codebase.

A **full alignment** — replacing the spatial model with H3, re-rendering with PyDeck, and switching the frontend to Streamlit — is effectively a new project and would take **25–40 weeks**, while discarding much of what makes ClimateMAPS production-ready today (multi-model ensembles, 4 SSP scenarios, 10+ climate variables, pre-built tile infrastructure, geocoding, and rate limiting).

The recommended path is an incremental approach: add Zarr/NetCDF support and the Z-score engine first, measure their value, and then decide whether the H3 + PyDeck 3-D layer is worth the architectural cost.