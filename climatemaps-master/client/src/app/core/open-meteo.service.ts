import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';

export interface YearlyTrendPoint {
  year: number;
  temp_max_avg: number | null;
  temp_min_avg: number | null;
  precip_total: number | null;
  rain_total: number | null;
  snowfall_total: number | null;
}

export interface TimeseriesResponse {
  latitude: number;
  longitude: number;
  trends: YearlyTrendPoint[];
}

export interface ForecastDay {
  date: string;
  temp_max: number | null;
  temp_min: number | null;
  precip_sum: number | null;
  rain_sum: number | null;
  snowfall_sum: number | null;
  weather_code: number | null;
  wind_speed_max: number | null;
}

export interface ForecastResponse {
  latitude: number;
  longitude: number;
  timezone: string;
  days: ForecastDay[];
}

// ── Lightweight current conditions (for hover tooltips) ──

export interface CurrentConditions {
  temperature: number | null;
  apparent_temperature: number | null;
  humidity: number | null;
  weather_code: number | null;
  wind_speed: number | null;
  wind_direction: number | null;
  cloud_cover: number | null;
  is_day: number | null;
}

// ── Comprehensive Weather Dashboard types ──

export interface CurrentWeather {
  temperature: number | null;
  apparent_temperature: number | null;
  relative_humidity: number | null;
  precipitation: number | null;
  rain: number | null;
  showers: number | null;
  snowfall: number | null;
  weather_code: number | null;
  cloud_cover: number | null;
  pressure_msl: number | null;
  surface_pressure: number | null;
  wind_speed: number | null;
  wind_direction: number | null;
  wind_gusts: number | null;
  is_day: number | null;
}

export interface HourlyWeather {
  time: string;
  temperature: number | null;
  apparent_temperature: number | null;
  relative_humidity: number | null;
  dew_point: number | null;
  precipitation_probability: number | null;
  precipitation: number | null;
  rain: number | null;
  showers: number | null;
  snowfall: number | null;
  snow_depth: number | null;
  weather_code: number | null;
  cloud_cover: number | null;
  cloud_cover_low: number | null;
  cloud_cover_mid: number | null;
  cloud_cover_high: number | null;
  visibility: number | null;
  pressure_msl: number | null;
  surface_pressure: number | null;
  wind_speed: number | null;
  wind_direction: number | null;
  wind_gusts: number | null;
  uv_index: number | null;
  is_day: number | null;
  soil_temperature_0cm: number | null;
  soil_temperature_6cm: number | null;
  soil_moisture_0_to_1cm: number | null;
  soil_moisture_1_to_3cm: number | null;
}

export interface DailyWeather {
  date: string;
  weather_code: number | null;
  temp_max: number | null;
  temp_min: number | null;
  apparent_temp_max: number | null;
  apparent_temp_min: number | null;
  sunrise: string | null;
  sunset: string | null;
  daylight_duration: number | null;
  sunshine_duration: number | null;
  uv_index_max: number | null;
  precipitation_sum: number | null;
  rain_sum: number | null;
  showers_sum: number | null;
  snowfall_sum: number | null;
  precipitation_hours: number | null;
  precipitation_probability_max: number | null;
  wind_speed_max: number | null;
  wind_gusts_max: number | null;
  wind_direction_dominant: number | null;
  shortwave_radiation_sum: number | null;
  et0_fao_evapotranspiration: number | null;
}

export interface WeatherDashboardResponse {
  latitude: number;
  longitude: number;
  elevation: number | null;
  timezone: string;
  timezone_abbreviation: string;
  current: CurrentWeather;
  hourly: HourlyWeather[];
  daily: DailyWeather[];
}

@Injectable({ providedIn: 'root' })
export class OpenMeteoService {
  constructor(private http: HttpClient) {}

  /** Yearly aggregated historical data from 1950 to 2024 (Open-Meteo ERA5 archive). */
  getTimeSeries(
    lat: number,
    lon: number,
    startYear = 1950,
    endYear = 2024,
  ): Observable<TimeseriesResponse> {
    return this.http.get<TimeseriesResponse>(
      `${environment.apiBaseUrl}/timeseries`,
      {
        params: {
          lat: lat.toString(),
          lon: lon.toString(),
          start_year: startYear.toString(),
          end_year: endYear.toString(),
        },
      },
    );
  }

  /** 7-day daily weather forecast (Open-Meteo forecast API). */
  getForecast(lat: number, lon: number): Observable<ForecastResponse> {
    return this.http.get<ForecastResponse>(
      `${environment.apiBaseUrl}/forecast`,
      {
        params: { lat: lat.toString(), lon: lon.toString() },
      },
    );
  }

  /** Comprehensive weather dashboard: current + hourly + 7-day daily. */
  getWeatherDashboard(
    lat: number,
    lon: number,
  ): Observable<WeatherDashboardResponse> {
    return this.http.get<WeatherDashboardResponse>(
      `${environment.apiBaseUrl}/weather`,
      {
        params: { lat: lat.toString(), lon: lon.toString() },
      },
    );
  }

  /** Lightweight current conditions for hover tooltips. */
  getCurrentConditions(
    lat: number,
    lon: number,
  ): Observable<CurrentConditions> {
    return this.http.get<CurrentConditions>(
      `${environment.apiBaseUrl}/current`,
      {
        params: { lat: lat.toString(), lon: lon.toString() },
      },
    );
  }
}
