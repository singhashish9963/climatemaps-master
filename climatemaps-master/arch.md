# Architecture & Technical Overview

This document describes the architecture, data sources, workflow, and methods/optimizations used in the ClimateMAPS project — an interactive web application for visualizing global historical climate data and future climate projections.

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Repository Structure](#2-repository-structure)
3. [Code Architecture](#3-code-architecture)
   - [Python Core Package (`climatemaps/`)](#31-python-core-package-climatemaps)
   - [FastAPI Backend (`api/`)](#32-fastapi-backend-api)
   - [Angular Frontend (`client/`)](#33-angular-frontend-client)
   - [Data Processing Scripts (`scripts/`)](#34-data-processing-scripts-scripts)
4. [Data Sources & Formats](#4-data-sources--formats)
5. [End-to-End Workflow](#5-end-to-end-workflow)
6. [Methods & Optimizations](#6-methods--optimizations)
7. [Configuration](#7-configuration)
8. [How to Build, Run & Test](#8-how-to-build-run--test)

---

## 1. Project Overview

**ClimateMAPS** displays global climate data on an interactive Leaflet map. It supports:

- **Historical** climate variables (1961-1990, 1970-2000)
- **Future projections** (2021-2100) under four Shared Socioeconomic Pathways: SSP1-2.6, SSP2-4.5, SSP3-7.0, SSP5-8.5
- **Anomaly / difference maps** (future minus historical) for temperature and precipitation
- **Ensemble statistics** across 10 diverse CMIP6 models (mean + standard deviation)

Live demo: **[openclimatemap.org](https://openclimatemap.org)**

---

## 2. Repository Structure

```
climatemaps-master/
├── climatemaps/              # Core Python package
│   ├── config.py             # ClimateMap model and app-level config
│   ├── contour.py            # ContourTileBuilder: matplotlib → mbtiles
│   ├── contour_config.py     # ContourPlotConfig (levels, colormap, norms)
│   ├── data.py               # Data loading and conversion entry points
│   ├── datasets.py           # Enums, data configs, contour configs (545 lines)
│   ├── download.py           # Auto-download raw data from WorldClim/CRU
│   ├── ensemble.py           # Ensemble mean/std-dev computation
│   ├── geogrid.py            # GeoGrid: core geographic grid data structure
│   ├── geotiff.py            # rasterio-based GeoTIFF readers
│   ├── logger.py             # Logger setup
│   ├── tile.py               # Tile utilities
│   ├── settings/             # Runtime settings (DEV_MODE, URLs, etc.)
│   └── tests/                # Unit tests (pytest)
│       ├── test_geogrid.py
│       ├── test_geotiff.py
│       ├── test_download.py
│       └── test_contour.py
├── api/
│   ├── main.py               # FastAPI application + all endpoints (247 lines)
│   ├── cache.py              # Thread-safe LRU in-memory cache
│   ├── middleware.py         # Sliding-window rate limiter
│   └── Dockerfile            # Docker image for the API
├── client/                   # Angular 18 frontend
│   └── src/app/
│       ├── map/              # Map and layer components
│       ├── core/             # Services (tooltip, layer filter, color extractor)
│       └── utils/            # Utility functions
├── scripts/
│   ├── create_contour.py     # Orchestrates tile generation for all datasets
│   ├── create_ensemble_mean.py  # Computes ensemble mean/std-dev files
│   ├── create_tileserver_config.py  # Generates tileserver-gl JSON config
│   └── deploy*.sh            # Deployment helpers
├── data/
│   ├── raw/                  # Downloaded source files (GeoTIFF, zips)
│   ├── tiles/                # Generated map tiles (mbtiles, colorbars)
│   └── images/               # Example screenshots
├── docker-compose.yml        # Runs TileServer + API together
├── requirements.txt          # Python runtime dependencies
├── requirements-dev.txt      # Python dev/test dependencies
├── pyproject.toml            # pytest and black configuration
└── setup.py                  # climatemaps package metadata
```

---

## 3. Code Architecture

### 3.1 Python Core Package (`climatemaps/`)

#### `GeoGrid` — core data structure (`geogrid.py`)

`GeoGrid` is a **Pydantic frozen model** that holds a geographic 2D data grid:

| Field | Type | Description |
|---|---|---|
| `lon_range` | `NDArray[float]` | Monotonically increasing longitude values |
| `lat_range` | `NDArray[float]` | Monotonically decreasing latitude values |
| `values` | `NDArray[float]` | 2D array shaped `(len(lat_range), len(lon_range))` |

Validators enforce array monotonicity and shape consistency at construction time.

Key methods:
- `zoom(factor)` — upsample via spline interpolation (`scipy.ndimage.zoom`, order=1)
- `difference(other)` — subtract another GeoGrid's values (used for anomaly maps)
- `get_value_at_coordinate(lon, lat)` — bilinear interpolation at a point
- `clipped_values(lower, upper)` — clip for visualization bounds
- Geometric helpers: `lat_min/max`, `lon_min/max`, `bin_width`, corner coordinates

#### `data.py` — data loading

`load_climate_data(config, month)`:
1. Calls `ensure_data_available` (downloads if missing)
2. Dispatches to the right reader based on `DataFormat`:
   - `GEOTIFF_WORLDCLIM_HISTORY` → `read_geotiff_history`
   - `GEOTIFF_WORLDCLIM_CMIP6` → `read_geotiff_future`
   - `CRU_TS` → `read_geotiff_cru_ts`
3. Applies `conversion_factor` (scalar multiply)
4. Applies optional `conversion_function` (e.g., per-day normalization)
5. Returns a `GeoGrid`

`load_climate_data_for_difference(historical_config, future_config, month)`:
- Loads both grids, verifies matching coordinate arrays, returns `future.difference(historical)`
- For `ENSEMBLE_STD_DEV`, skips subtraction (std-dev is already a difference metric)

#### `ensemble.py` — multi-model aggregation

Uses **10 CMIP6 models** selected for institutional and physical diversity, covering low/medium/high effective climate sensitivity (ECS) values (per IPCC AR6 Table 7.SM.5):

```
BCC-CSM2-MR, CMCC-ESM2, EC-Earth3-Veg, GFDL-ESM4, GISS-E2-1-G,
IPSL-CM6A-LR, MIROC6, MPI-ESM1-2-HR, MRI-ESM2-0, UKESM1-0-LL
```

`compute_ensemble_mean` and `compute_ensemble_std_dev` both call `_compute_ensemble_statistic`, which:
1. Collects available model files (downloading any that are missing)
2. Reads each GeoTIFF band-by-band using `rasterio`
3. Stacks all models into a `(n_models, height, width)` array
4. Applies `np.nanmean` or `np.nanstd` across the model axis
5. Writes the result as a new GeoTIFF (float32, LZW-compressed)

#### `contour.py` — tile generation (`ContourTileBuilder`)

`create_tiles(data_dir_out, name, month, figure_dpi, zoom_factor)`:

1. **Optionally zoom** the GeoGrid (2× upsampling by default)
2. **Raster tile pipeline:**
   - Render a matplotlib `contourf` on a Cartopy `PlateCarree` projection
   - Save as PNG at high DPI (3000 in production, 1000 in dev)
   - `gdal_translate` converts the PNG to an MBTiles raster file
   - `gdaladdo` adds zoom-level overviews (factors 2, 4, 8, 16)
   - Temp files are used and atomically replaced to avoid partial writes
3. **Vector tile pipeline:**
   - Render matplotlib `contour` (iso-lines)
   - Convert to GeoJSON with `geojsoncontour`
   - Merge with world bounding box GeoJSON
   - Run `tippecanoe` (via `togeojsontiles`) to build vector MBTiles (zoom 0–8, layer=`contours`)
4. **Colorbar** — saved as a separate PNG using matplotlib's `figure.colorbar`

#### `datasets.py` — configuration catalog

All enumerations and data configs live here:

- `DataFormat` — `GEOTIFF_WORLDCLIM_CMIP6`, `GEOTIFF_WORLDCLIM_HISTORY`, `CRU_TS`
- `SpatialResolution` — 2.5m, 5m, 10m, 30m arc-minute
- `ClimateVarKey` — 10 variables (precipitation, Tmax, Tmin, cloud cover, wet days, frost days, wind speed, radiation, diurnal temperature range, vapour pressure)
- `ClimateScenario` — SSP126, SSP245, SSP370, SSP585
- `ClimateModel` — 16 models + `ENSEMBLE_MEAN` + `ENSEMBLE_STD_DEV`

Data config classes:
- `ClimateDataConfig` — base config (variable, filepath, format, resolution, year range, conversion)
- `FutureClimateDataConfig(ClimateDataConfig)` — adds climate model and scenario
- `ClimateDifferenceDataConfig` — pairs a historical and future config for anomaly maps

Contour configs (`ContourPlotConfig`) define per-variable level ranges, colormaps, and log-scale flags. Separate configs exist for absolute values, difference maps, and std-dev maps.

---

### 3.2 FastAPI Backend (`api/`)

**`main.py`** mounts a versioned sub-application at `/v1`:

| Endpoint | Method | Description |
|---|---|---|
| `/v1/climatemap` | GET | List all available climate maps (metadata) |
| `/v1/colorbar/{data_type}/{month}` | GET | Serve pre-generated colorbar PNG |
| `/v1/colorbar-config/{data_type}` | GET | Return colorbar levels, colors, range, log-scale flag as JSON |
| `/v1/value/{data_type}/{month}?lat=&lon=` | GET | Return interpolated climate value at a coordinate |
| `/v1/nearest-city?lat=&lon=` | GET | Nearest city/country using `citipy` |
| `/v1/geocode?query=` | GET | Forward geocoding via Photon (OSM-based) |

**Startup:** All datasets defined in `settings.DATA_SETS_API` are instantiated as `ClimateMap` objects. A `data_config_map` dict is built for O(1) lookup by `data_type_slug`.

**Rate limiting** (middleware): 1 000 requests/minute per client IP using a sliding-window counter (thread-safe). Returns HTTP 429 on breach.

**Caching** (`GeoGridCache`): Loaded `GeoGrid` objects are cached in-memory (max 128 entries, FIFO eviction). Cache key: `{data_type}_{month}`. Thread-safe via `Lock`. Valid only for single-worker deployments.

---

### 3.3 Angular Frontend (`client/`)

Built with **Angular 18**, key libraries:

| Library | Role |
|---|---|
| Leaflet | Interactive map rendering |
| Leaflet Vector Grid | Vector tile layer for contour lines |
| Chart.js | Monthly time-series charts |
| Angular Material | UI components |
| Proj4 | Coordinate reprojection |

Key components and services:
- **`MapComponent`** — hosts the Leaflet map, manages layer switching
- **`MonthlyGridComponent`** — month selector
- **`ScenarioGridComponent`** — SSP scenario selector
- **`YearRangeGridComponent`** — time-period selector
- **`TooltipManagerService`** — fetches and displays click-location climate values
- **`LayerFilterService`** — applies dataset filter state
- **`RasterColorExtractorService`** — extracts pixel color from raster tiles for the legend

---

### 3.4 Data Processing Scripts (`scripts/`)

| Script | Purpose |
|---|---|
| `create_contour.py` | Main orchestration: iterate over all dataset configs, load data, call `ContourTileBuilder`. Supports `--test`, `--force`, `--variable`, `--model` flags. |
| `create_ensemble_mean.py` | Compute and save ensemble mean/std-dev TIFFs for all variable/scenario/resolution combinations. |
| `create_tileserver_config.py` | Generate `tileserver_config.json` from the tiles directory. |

---

## 4. Data Sources & Formats

### 4.1 Historical Climate Data

| Source | Variables | Period | Resolution | Format |
|---|---|---|---|---|
| **WorldClim 2.1** | Tmax, Tmin, Precipitation | 1970-2000 | 5m, 10m | Multi-band GeoTIFF (12 bands = 12 months) |
| **CRU TS** (Climatic Research Unit) | Cloud cover, wet days, frost days, diurnal temp range, vapour pressure | 1961-1990 | 30m | GeoTIFF |

WorldClim URL pattern:
```
https://geodata.ucdavis.edu/climate/worldclim/2_1/base/wc2.1_{resolution}_{variable}.zip
```

### 4.2 Future Climate Projections

| Source | Variables | Periods | Scenarios | Models |
|---|---|---|---|---|
| **WorldClim CMIP6** (downscaled) | Tmax, Tmin, Precipitation | 2021-40, 2041-60, 2061-80, 2081-2100 | SSP1-2.6, SSP2-4.5, SSP3-7.0, SSP5-8.5 | 10 individual + ensemble mean/std-dev |

CMIP6 URL pattern:
```
https://geodata.ucdavis.edu/cmip6/{resolution}/{model}/wc2.1_{resolution}_{variable}_{model}_{scenario}_{year_start}-{year_end}.tif
```

### 4.3 File Naming Conventions

```
# Historical WorldClim
data/raw/worldclim/history/wc2.1_{resolution}_{variable}/wc2.1_{resolution}_{variable}_{month}.tif

# Future CMIP6
data/raw/worldclim/future/wc2.1_{resolution}_{variable}_{model}_{scenario}_{year_start}-{year_end}.tif

# Ensemble output
data/raw/worldclim/future/wc2.1_{resolution}_{variable}_{ENSEMBLE-MEAN|ENSEMBLE-STD-DEV}_{scenario}_{year_start}-{year_end}.tif

# CRU TS
data/raw/cruts/cru_{abbreviation}_clim_{year_start}-{year_end}/...
```

### 4.4 Output Tile Structure

For each `{data_type}` (e.g., `tmax_2041_2060_10m_ssp245_ensemble_mean`) and each `{month}` (1–12):

```
data/tiles/{data_type}/
    {month}_raster.mbtiles   # Raster tile pyramid (zoom 0-4)
    {month}_vector.mbtiles   # Vector contour lines (zoom 0-8)
    {month}_colorbar.png     # Colorbar legend image
```

---

## 5. End-to-End Workflow

### 5.1 Offline Data Preparation (run once)

```
┌─────────────────────────────────────────────────────────────────────────┐
│  1. Download raw data                                                   │
│     WorldClim historical zips → extract to data/raw/worldclim/history/ │
│     WorldClim CMIP6 TIFFs  → data/raw/worldclim/future/               │
│     CRU TS TIFFs           → data/raw/cruts/                           │
│                                                                         │
│  2. Compute ensemble statistics (scripts/create_ensemble_mean.py)       │
│     For each (variable, scenario, year_range, resolution):              │
│       rasterio reads 10 model GeoTIFFs                                  │
│       np.nanmean / np.nanstd across models → new ENSEMBLE GeoTIFF      │
│                                                                         │
│  3. Generate map tiles (scripts/create_contour.py)                      │
│     For each dataset config × 12 months:                                │
│       Load GeoGrid (data.py)                                            │
│       Optional: compute difference map (future − historical)            │
│       GeoGrid.zoom(2×) → higher resolution via spline interpolation     │
│       matplotlib contourf → high-DPI PNG                                │
│       gdal_translate + gdaladdo → {month}_raster.mbtiles               │
│       matplotlib contour → GeoJSON → tippecanoe → {month}_vector.mbtiles│
│       matplotlib colorbar → {month}_colorbar.png                        │
│                                                                         │
│  4. Generate tileserver config (scripts/create_tileserver_config.py)   │
│     Scans data/tiles/ → writes tileserver_config.json                  │
└─────────────────────────────────────────────────────────────────────────┘
```

### 5.2 Runtime Request Flow

```
User clicks on map
       │
       ▼
Angular MapComponent
  ├── Requests vector/raster tiles from TileServer (port 8080)
  │     TileServer serves mbtiles from data/tiles/
  │
  └── Requests climate value from FastAPI (port 8000)
        GET /v1/value/{data_type}/{month}?lat=X&lon=Y
              │
              ├─ Check GeoGridCache (128-entry LRU, key: data_type_month)
              │     HIT  → use cached GeoGrid
              │     MISS → load_climate_data(config, month)
              │               read_geotiff_*(filepath, month)  [rasterio]
              │               apply conversion_factor
              │               apply conversion_function
              │               return GeoGrid
              │               → store in cache
              │
              └─ GeoGrid.get_value_at_coordinate(lon, lat)
                    RegularGridInterpolator (bilinear, scipy)
                    → return float value
              │
              ▼
        ClimateValueResponse { value, unit, variable_name, ... }
              │
              ▼
  Tooltip shown on map (value + nearest city)
```

---

## 6. Methods & Optimizations

### 6.1 Spatial Interpolation

| Use case | Method | Library |
|---|---|---|
| Point value query | Bilinear (linear `RegularGridInterpolator`) | `scipy.interpolate` |
| Grid upsampling (zoom) | Linear spline (`ndimage.zoom`, order=1) | `scipy.ndimage` |
| Value clipping for display | Clip to contour level bounds | `numpy.clip` |

### 6.2 In-Memory Caching

`GeoGridCache` (FIFO eviction, max 128 entries) prevents reloading GeoTIFF files on every request. Since a single dataset/month pair is typically a ~20 MB array, 128 entries covers the full monthly matrix of many datasets without excessive RAM.

> **Note:** Cache is per-process. Multiple uvicorn workers each maintain their own cache; there is no shared cache layer.

### 6.3 Rate Limiting

`RateLimitMiddleware` (1 000 requests/min per IP) uses a per-IP list of UNIX timestamps. On each request it prunes entries older than 60 seconds and checks whether the resulting list length is within the limit. This implements a **sliding window** algorithm without external dependencies.

### 6.4 Ensemble Modeling

Ten CMIP6 models were chosen to minimize inter-model correlation and span the assessed ECS range from IPCC AR6:

- Low ECS: GFDL-ESM4, GISS-E2-1-G
- Medium ECS: BCC-CSM2-MR, CMCC-ESM2, EC-Earth3-Veg, IPSL-CM6A-LR, MIROC6, MPI-ESM1-2-HR, MRI-ESM2-0
- High ECS: UKESM1-0-LL

Using `np.nanmean`/`np.nanstd` (NaN-aware) across a stacked `(n_models, height, width)` array in a single pass is both vectorised and tolerant of missing model pixels.

### 6.5 Tile Generation

- **High-DPI rendering:** Figure DPI 3000 (production) / 1000 (dev) ensures sub-pixel precision at high zoom.
- **2× spatial upsampling:** Applied before rendering to make tile seams smoother at low zoom levels.
- **Zoom-level overviews:** `gdaladdo` pre-computes downsampled tile pyramids so the tile server never rescales on-the-fly.
- **Atomic file replacement:** Both raster and vector tile pipelines write to a `.tmp` file, then rename it atomically (`os.replace`), preventing corrupted tiles from being served if a build fails mid-way.
- **Memory management:** `plt.close(figure)` + `del` + `gc.collect()` after each render prevents matplotlib memory accumulation during batch processing.

### 6.6 Colormap / Normalization

| Variable | Colormap | Normalization |
|---|---|---|
| Temperature (day/night) | `jet` | Linear |
| Precipitation (absolute) | `RdYlBu` | `SymLogNorm` (log scale) |
| Cloud Cover, Wet/Frost Days | `RdYlBu` | Linear |
| Radiation | `RdYlBu_r` | Linear |
| Precipitation anomaly | `RdBu` | Linear (diverging) |
| Temperature anomaly | `RdYlBu_r` | Linear (diverging) |
| Std-dev anomaly | `RdYlGn_r` | Log scale for precipitation |

### 6.7 Geocoding with Retry

The `/v1/geocode` endpoint retries up to 3 times with **exponential back-off** (0.5 s, 1 s, 2 s) on `GeocoderTimedOut` and `GeocoderServiceError`, improving resilience to transient network issues.

### 6.8 Pydantic Validation

- `GeoGrid` uses Pydantic v2 frozen model with field validators to enforce data integrity at construction time (monotonicity, array shape).
- API request/response models use Pydantic for automatic validation, serialization, and OpenAPI doc generation.

---

## 7. Configuration

| File | Purpose |
|---|---|
| `climatemaps/settings/settings.py` | Runtime settings: `DEV_MODE`, tile server URL, API URL, tippecanoe path, process count |
| `climatemaps/config.py` | Tile generation config: zoom range, DPI, zoom factor, output directory |
| `pyproject.toml` | pytest (min 7.0, log-level WARNING) + black (line-length 100) |
| `docker-compose.yml` | Orchestrates tileserver-gl (8080) + FastAPI (8000); mounts `data/` volumes |
| `api/Dockerfile` | `python:3.11-slim` image; runs uvicorn on port 8000 |
| `tileserver_config.json` | Auto-generated tileserver-gl config; lists all mbtiles sources |

Key settings values (production defaults):

```python
DEV_MODE = False
TILE_SERVER_URL = "http://localhost:8080/data"
API_BASE_URL = "http://localhost:8000/v1"
ZOOM_MAX_RASTER = 4
TIPPECANOE_DIR = "/usr/local/bin/"
CREATE_CONTOUR_PROCESSES = 1
```

---

## 8. How to Build, Run & Test

### System dependencies

```bash
# GDAL (via conda to avoid system library conflicts)
conda install -c conda-forge gdal==3.11.0

# Tippecanoe 1.19.1 (last version with valid GeoJSON output; see https://github.com/mapbox/tippecanoe/issues/652)
sudo apt install libsqlite3-dev
git clone https://github.com/mapbox/tippecanoe.git
cd tippecanoe && git checkout tags/1.19.1 && make -j && make install

# TileServer GL
npm install -g tileserver-gl
```

### Python dependencies

```bash
pip install -r requirements.txt
pip install -r requirements-dev.txt  # test dependencies
```

### Generate tiles (one-time)

```bash
python scripts/create_ensemble_mean.py     # build ensemble TIFFs
python scripts/create_contour.py           # build all mbtiles
python scripts/create_tileserver_config.py # write tileserver_config.json
```

### Run all services locally

```bash
# Terminal 1 – FastAPI backend
uvicorn api.main:app --reload

# Terminal 2 – TileServer GL
tileserver-gl --config tileserver_config_dev.json --port 8080

# Terminal 3 – Angular dev server
cd client && ng serve
# Visit http://localhost:4200
```

Or use Docker Compose:

```bash
docker-compose up
```

### Tests

```bash
pytest                  # runs climatemaps/tests/
```

Test files:
- `test_geogrid.py` — GeoGrid construction, validators, interpolation
- `test_geotiff.py` — GeoTIFF reader outputs
- `test_download.py` — download helpers
- `test_contour.py` — ContourTileBuilder

### Code style

```bash
black --check .         # line-length 100, target py310
```
