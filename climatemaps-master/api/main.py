from typing import List, Optional
import time
from pathlib import Path
from collections import defaultdict
from statistics import mean

from fastapi import FastAPI, HTTPException, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
from citipy import citipy
import pycountry
from geopy.geocoders import Photon
from geopy.exc import GeocoderTimedOut, GeocoderServiceError
import httpx

from climatemaps.config import ClimateMap
from climatemaps.settings import settings
from climatemaps.datasets import ClimateDifferenceDataConfig
from climatemaps.data import load_climate_data, load_climate_data_for_difference

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


# ── Open-Meteo Live Data Endpoints ──────────────────────────────────────────

class YearlyTrendPoint(BaseModel):
    year: int
    temp_max_avg: Optional[float]
    temp_min_avg: Optional[float]
    precip_total: Optional[float]
    rain_total: Optional[float]
    snowfall_total: Optional[float]


class TimeseriesResponse(BaseModel):
    latitude: float
    longitude: float
    trends: list[YearlyTrendPoint]


class ForecastDay(BaseModel):
    date: str
    temp_max: Optional[float]
    temp_min: Optional[float]
    precip_sum: Optional[float]
    rain_sum: Optional[float]
    snowfall_sum: Optional[float]
    weather_code: Optional[int]
    wind_speed_max: Optional[float]


class ForecastResponse(BaseModel):
    latitude: float
    longitude: float
    timezone: str
    days: list[ForecastDay]


@api.get("/timeseries", response_model=TimeseriesResponse)
async def get_timeseries(
    lat: float, lon: float, start_year: int = 1950, end_year: int = 2024
):
    """Yearly aggregated historical climate data from Open-Meteo ERA5 archive."""
    if not (-90 <= lat <= 90):
        raise HTTPException(status_code=400, detail="Latitude must be between -90 and 90")
    if not (-180 <= lon <= 180):
        raise HTTPException(status_code=400, detail="Longitude must be between -180 and 180")

    start_year = max(1940, min(int(start_year), 2024))
    end_year = max(start_year, min(int(end_year), 2024))

    params = {
        "latitude": lat,
        "longitude": lon,
        "start_date": f"{start_year}-01-01",
        "end_date": f"{end_year}-12-31",
        "daily": "temperature_2m_max,temperature_2m_min,precipitation_sum,rain_sum,snowfall_sum",
        "timezone": "UTC",
    }

    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.get(
                "https://archive-api.open-meteo.com/v1/archive", params=params
            )
            resp.raise_for_status()
            data = resp.json()
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="Open-Meteo archive API timed out")
    except httpx.HTTPStatusError as e:
        raise HTTPException(status_code=502, detail=f"Open-Meteo API error: {e.response.text[:200]}")

    daily = data.get("daily", {})
    times = daily.get("time", [])
    tmax_vals = daily.get("temperature_2m_max", [])
    tmin_vals = daily.get("temperature_2m_min", [])
    precip_vals = daily.get("precipitation_sum", [])
    rain_vals = daily.get("rain_sum", [])
    snow_vals = daily.get("snowfall_sum", [])

    buckets: dict = defaultdict(lambda: {"tmax": [], "tmin": [], "precip": [], "rain": [], "snow": []})
    for i, date_str in enumerate(times):
        yr = int(date_str[:4])
        if i < len(tmax_vals) and tmax_vals[i] is not None:
            buckets[yr]["tmax"].append(tmax_vals[i])
        if i < len(tmin_vals) and tmin_vals[i] is not None:
            buckets[yr]["tmin"].append(tmin_vals[i])
        if i < len(precip_vals) and precip_vals[i] is not None:
            buckets[yr]["precip"].append(precip_vals[i])
        if i < len(rain_vals) and rain_vals[i] is not None:
            buckets[yr]["rain"].append(rain_vals[i])
        if i < len(snow_vals) and snow_vals[i] is not None:
            buckets[yr]["snow"].append(snow_vals[i])

    trends = [
        YearlyTrendPoint(
            year=yr,
            temp_max_avg=round(mean(b["tmax"]), 2) if b["tmax"] else None,
            temp_min_avg=round(mean(b["tmin"]), 2) if b["tmin"] else None,
            precip_total=round(sum(b["precip"]), 1) if b["precip"] else None,
            rain_total=round(sum(b["rain"]), 1) if b["rain"] else None,
            snowfall_total=round(sum(b["snow"]), 1) if b["snow"] else None,
        )
        for yr, b in sorted(buckets.items())
    ]

    return TimeseriesResponse(
        latitude=data.get("latitude", lat),
        longitude=data.get("longitude", lon),
        trends=trends,
    )


@api.get("/forecast", response_model=ForecastResponse)
async def get_forecast(lat: float, lon: float):
    """7-day weather forecast from Open-Meteo."""
    if not (-90 <= lat <= 90):
        raise HTTPException(status_code=400, detail="Latitude must be between -90 and 90")
    if not (-180 <= lon <= 180):
        raise HTTPException(status_code=400, detail="Longitude must be between -180 and 180")

    params = {
        "latitude": lat,
        "longitude": lon,
        "daily": "temperature_2m_max,temperature_2m_min,precipitation_sum,rain_sum,snowfall_sum,weather_code,wind_speed_10m_max",
        "forecast_days": 7,
        "timezone": "auto",
    }

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get("https://api.open-meteo.com/v1/forecast", params=params)
            resp.raise_for_status()
            data = resp.json()
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="Open-Meteo forecast API timed out")
    except httpx.HTTPStatusError as e:
        raise HTTPException(status_code=502, detail=f"Open-Meteo API error: {e.response.text[:200]}")

    daily = data.get("daily", {})
    times = daily.get("time", [])
    n = len(times)

    def _d(key: str, i: int):
        arr = daily.get(key, [])
        return arr[i] if i < len(arr) else None

    days = [
        ForecastDay(
            date=times[i],
            temp_max=_d("temperature_2m_max", i),
            temp_min=_d("temperature_2m_min", i),
            precip_sum=_d("precipitation_sum", i),
            rain_sum=_d("rain_sum", i),
            snowfall_sum=_d("snowfall_sum", i),
            weather_code=_d("weather_code", i),
            wind_speed_max=_d("wind_speed_10m_max", i),
        )
        for i in range(n)
    ]

    return ForecastResponse(
        latitude=data.get("latitude", lat),
        longitude=data.get("longitude", lon),
        timezone=data.get("timezone", "UTC"),
        days=days,
    )


# ── Comprehensive Weather Dashboard Endpoint ────────────────────────────────

class CurrentWeather(BaseModel):
    temperature: Optional[float]
    apparent_temperature: Optional[float]
    relative_humidity: Optional[int]
    precipitation: Optional[float]
    rain: Optional[float]
    showers: Optional[float]
    snowfall: Optional[float]
    weather_code: Optional[int]
    cloud_cover: Optional[int]
    pressure_msl: Optional[float]
    surface_pressure: Optional[float]
    wind_speed: Optional[float]
    wind_direction: Optional[int]
    wind_gusts: Optional[float]
    is_day: Optional[int]


class HourlyWeather(BaseModel):
    time: str
    temperature: Optional[float]
    apparent_temperature: Optional[float]
    relative_humidity: Optional[int]
    dew_point: Optional[float]
    precipitation_probability: Optional[int]
    precipitation: Optional[float]
    rain: Optional[float]
    showers: Optional[float]
    snowfall: Optional[float]
    snow_depth: Optional[float]
    weather_code: Optional[int]
    cloud_cover: Optional[int]
    cloud_cover_low: Optional[int]
    cloud_cover_mid: Optional[int]
    cloud_cover_high: Optional[int]
    visibility: Optional[float]
    pressure_msl: Optional[float]
    surface_pressure: Optional[float]
    wind_speed: Optional[float]
    wind_direction: Optional[int]
    wind_gusts: Optional[float]
    uv_index: Optional[float]
    is_day: Optional[int]
    soil_temperature_0cm: Optional[float]
    soil_temperature_6cm: Optional[float]
    soil_moisture_0_to_1cm: Optional[float]
    soil_moisture_1_to_3cm: Optional[float]


class DailyWeather(BaseModel):
    date: str
    weather_code: Optional[int]
    temp_max: Optional[float]
    temp_min: Optional[float]
    apparent_temp_max: Optional[float]
    apparent_temp_min: Optional[float]
    sunrise: Optional[str]
    sunset: Optional[str]
    daylight_duration: Optional[float]
    sunshine_duration: Optional[float]
    uv_index_max: Optional[float]
    precipitation_sum: Optional[float]
    rain_sum: Optional[float]
    showers_sum: Optional[float]
    snowfall_sum: Optional[float]
    precipitation_hours: Optional[float]
    precipitation_probability_max: Optional[int]
    wind_speed_max: Optional[float]
    wind_gusts_max: Optional[float]
    wind_direction_dominant: Optional[int]
    shortwave_radiation_sum: Optional[float]
    et0_fao_evapotranspiration: Optional[float]


class WeatherDashboardResponse(BaseModel):
    latitude: float
    longitude: float
    elevation: Optional[float]
    timezone: str
    timezone_abbreviation: str
    current: CurrentWeather
    hourly: list[HourlyWeather]
    daily: list[DailyWeather]


@api.get("/weather", response_model=WeatherDashboardResponse)
async def get_weather_dashboard(lat: float, lon: float):
    """Comprehensive current + hourly + 7-day weather from Open-Meteo."""
    if not (-90 <= lat <= 90):
        raise HTTPException(status_code=400, detail="Latitude must be between -90 and 90")
    if not (-180 <= lon <= 180):
        raise HTTPException(status_code=400, detail="Longitude must be between -180 and 180")

    current_vars = (
        "temperature_2m,apparent_temperature,relative_humidity_2m,"
        "precipitation,rain,showers,snowfall,weather_code,cloud_cover,"
        "pressure_msl,surface_pressure,wind_speed_10m,wind_direction_10m,wind_gusts_10m,is_day"
    )
    hourly_vars = (
        "temperature_2m,apparent_temperature,relative_humidity_2m,dew_point_2m,"
        "precipitation_probability,precipitation,rain,showers,snowfall,snow_depth,"
        "weather_code,cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high,"
        "visibility,pressure_msl,surface_pressure,"
        "wind_speed_10m,wind_direction_10m,wind_gusts_10m,"
        "uv_index,is_day,"
        "soil_temperature_0cm,soil_temperature_6cm,"
        "soil_moisture_0_to_1cm,soil_moisture_1_to_3cm"
    )
    daily_vars = (
        "weather_code,temperature_2m_max,temperature_2m_min,"
        "apparent_temperature_max,apparent_temperature_min,"
        "sunrise,sunset,daylight_duration,sunshine_duration,"
        "uv_index_max,precipitation_sum,rain_sum,showers_sum,snowfall_sum,"
        "precipitation_hours,precipitation_probability_max,"
        "wind_speed_10m_max,wind_gusts_10m_max,wind_direction_10m_dominant,"
        "shortwave_radiation_sum,et0_fao_evapotranspiration"
    )

    params = {
        "latitude": lat,
        "longitude": lon,
        "current": current_vars,
        "hourly": hourly_vars,
        "daily": daily_vars,
        "forecast_days": 7,
        "timezone": "auto",
    }

    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            resp = await client.get("https://api.open-meteo.com/v1/forecast", params=params)
            resp.raise_for_status()
            data = resp.json()
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="Open-Meteo API timed out")
    except httpx.HTTPStatusError as e:
        raise HTTPException(status_code=502, detail=f"Open-Meteo API error: {e.response.text[:200]}")

    # Parse current weather
    cur = data.get("current", {})
    current = CurrentWeather(
        temperature=cur.get("temperature_2m"),
        apparent_temperature=cur.get("apparent_temperature"),
        relative_humidity=cur.get("relative_humidity_2m"),
        precipitation=cur.get("precipitation"),
        rain=cur.get("rain"),
        showers=cur.get("showers"),
        snowfall=cur.get("snowfall"),
        weather_code=cur.get("weather_code"),
        cloud_cover=cur.get("cloud_cover"),
        pressure_msl=cur.get("pressure_msl"),
        surface_pressure=cur.get("surface_pressure"),
        wind_speed=cur.get("wind_speed_10m"),
        wind_direction=cur.get("wind_direction_10m"),
        wind_gusts=cur.get("wind_gusts_10m"),
        is_day=cur.get("is_day"),
    )

    # Parse hourly
    hr = data.get("hourly", {})
    hr_times = hr.get("time", [])
    hourly_list = []
    for i, t in enumerate(hr_times):
        def _h(key, idx=i):
            arr = hr.get(key, [])
            return arr[idx] if idx < len(arr) else None

        hourly_list.append(HourlyWeather(
            time=t,
            temperature=_h("temperature_2m"),
            apparent_temperature=_h("apparent_temperature"),
            relative_humidity=_h("relative_humidity_2m"),
            dew_point=_h("dew_point_2m"),
            precipitation_probability=_h("precipitation_probability"),
            precipitation=_h("precipitation"),
            rain=_h("rain"),
            showers=_h("showers"),
            snowfall=_h("snowfall"),
            snow_depth=_h("snow_depth"),
            weather_code=_h("weather_code"),
            cloud_cover=_h("cloud_cover"),
            cloud_cover_low=_h("cloud_cover_low"),
            cloud_cover_mid=_h("cloud_cover_mid"),
            cloud_cover_high=_h("cloud_cover_high"),
            visibility=_h("visibility"),
            pressure_msl=_h("pressure_msl"),
            surface_pressure=_h("surface_pressure"),
            wind_speed=_h("wind_speed_10m"),
            wind_direction=_h("wind_direction_10m"),
            wind_gusts=_h("wind_gusts_10m"),
            uv_index=_h("uv_index"),
            is_day=_h("is_day"),
            soil_temperature_0cm=_h("soil_temperature_0cm"),
            soil_temperature_6cm=_h("soil_temperature_6cm"),
            soil_moisture_0_to_1cm=_h("soil_moisture_0_to_1cm"),
            soil_moisture_1_to_3cm=_h("soil_moisture_1_to_3cm"),
        ))

    # Parse daily
    dy = data.get("daily", {})
    dy_times = dy.get("time", [])
    daily_list = []
    for i, t in enumerate(dy_times):
        def _dd(key, idx=i):
            arr = dy.get(key, [])
            return arr[idx] if idx < len(arr) else None

        daily_list.append(DailyWeather(
            date=t,
            weather_code=_dd("weather_code"),
            temp_max=_dd("temperature_2m_max"),
            temp_min=_dd("temperature_2m_min"),
            apparent_temp_max=_dd("apparent_temperature_max"),
            apparent_temp_min=_dd("apparent_temperature_min"),
            sunrise=_dd("sunrise"),
            sunset=_dd("sunset"),
            daylight_duration=_dd("daylight_duration"),
            sunshine_duration=_dd("sunshine_duration"),
            uv_index_max=_dd("uv_index_max"),
            precipitation_sum=_dd("precipitation_sum"),
            rain_sum=_dd("rain_sum"),
            showers_sum=_dd("showers_sum"),
            snowfall_sum=_dd("snowfall_sum"),
            precipitation_hours=_dd("precipitation_hours"),
            precipitation_probability_max=_dd("precipitation_probability_max"),
            wind_speed_max=_dd("wind_speed_10m_max"),
            wind_gusts_max=_dd("wind_gusts_10m_max"),
            wind_direction_dominant=_dd("wind_direction_10m_dominant"),
            shortwave_radiation_sum=_dd("shortwave_radiation_sum"),
            et0_fao_evapotranspiration=_dd("et0_fao_evapotranspiration"),
        ))

    return WeatherDashboardResponse(
        latitude=data.get("latitude", lat),
        longitude=data.get("longitude", lon),
        elevation=data.get("elevation"),
        timezone=data.get("timezone", "UTC"),
        timezone_abbreviation=data.get("timezone_abbreviation", ""),
        current=current,
        hourly=hourly_list,
        daily=daily_list,
    )


class CurrentConditionsResponse(BaseModel):
    temperature: Optional[float] = None
    apparent_temperature: Optional[float] = None
    humidity: Optional[int] = None
    weather_code: Optional[int] = None
    wind_speed: Optional[float] = None
    wind_direction: Optional[int] = None
    cloud_cover: Optional[int] = None
    is_day: Optional[int] = None


@api.get("/current", response_model=CurrentConditionsResponse)
async def get_current_conditions(lat: float, lon: float):
    """Lightweight current conditions for hover tooltips."""
    if not (-90 <= lat <= 90):
        raise HTTPException(status_code=400, detail="Latitude must be between -90 and 90")
    if not (-180 <= lon <= 180):
        raise HTTPException(status_code=400, detail="Longitude must be between -180 and 180")

    params = {
        "latitude": lat,
        "longitude": lon,
        "current": "temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,wind_direction_10m,cloud_cover,is_day",
    }

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get("https://api.open-meteo.com/v1/forecast", params=params)
            resp.raise_for_status()
            data = resp.json()
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="Open-Meteo API timed out")
    except httpx.HTTPStatusError as e:
        raise HTTPException(status_code=502, detail=f"Open-Meteo API error: {e.response.text[:200]}")

    cur = data.get("current", {})
    return CurrentConditionsResponse(
        temperature=cur.get("temperature_2m"),
        apparent_temperature=cur.get("apparent_temperature"),
        humidity=cur.get("relative_humidity_2m"),
        weather_code=cur.get("weather_code"),
        wind_speed=cur.get("wind_speed_10m"),
        wind_direction=cur.get("wind_direction_10m"),
        cloud_cover=cur.get("cloud_cover"),
        is_day=cur.get("is_day"),
    )
