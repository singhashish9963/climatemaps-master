import { Injectable } from '@angular/core';
import { LeafletMouseEvent, Map as LeafletMap } from 'leaflet';
import {
  ClimateMapService,
  ColorbarConfigResponse,
} from '../../core/climatemap.service';
import {
  RasterColorExtractorService,
  RasterColor,
} from './raster-color-extractor.service';
import { TooltipManagerService } from './tooltip-manager.service';
import {
  TemperatureUnitService,
  TemperatureUnit,
} from '../../core/temperature-unit.service';
import {
  PrecipitationUnitService,
  PrecipitationUnit,
} from '../../core/precipitation-unit.service';
import { TemperatureUtils } from '../../utils/temperature-utils';
import { PrecipitationUtils } from '../../utils/precipitation-utils';
import { ClimateVarKey } from '../../utils/enum';
import { UnitUtils } from '../../utils/unit-utils';
import { LayerOption } from './layer-builder.service';
import {
  OpenMeteoService,
  CurrentWeather,
  CurrentConditions,
} from '../../core/open-meteo.service';
import { Subscription } from 'rxjs';

@Injectable({
  providedIn: 'root',
})
export class RasterTooltipService {
  private colorbarConfigCache: Record<string, ColorbarConfigResponse> = {};
  private weatherCache = new Map<string, CurrentConditions>();
  private hoverDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private hoverSub: Subscription | null = null;

  constructor(
    private rasterColorExtractor: RasterColorExtractorService,
    private tooltipManager: TooltipManagerService,
    private climateMapService: ClimateMapService,
    private temperatureUnitService: TemperatureUnitService,
    private precipitationUnitService: PrecipitationUnitService,
    private openMeteoService: OpenMeteoService,
  ) {}

  handleMouseMove(
    event: LeafletMouseEvent,
    map: LeafletMap,
    rasterLayer: any,
    selectedOption: LayerOption | undefined,
    monthSelected: number,
    variableType: ClimateVarKey,
  ): void {
    if (!selectedOption?.metadata?.dataType) {
      this.tooltipManager.removeHoverTooltip(map);
      return;
    }

    // Cancel any pending debounced fetch
    if (this.hoverDebounceTimer) {
      clearTimeout(this.hoverDebounceTimer);
      this.hoverDebounceTimer = null;
    }
    if (this.hoverSub) {
      this.hoverSub.unsubscribe();
      this.hoverSub = null;
    }

    const lat = event.latlng.lat;
    const lon = event.latlng.lng;

    // Check cache first (grid rounded to 0.1°)
    const cacheKey = `${Math.round(lat * 10) / 10},${Math.round(lon * 10) / 10}`;
    const cached = this.weatherCache.get(cacheKey);

    if (cached) {
      const html = this.buildHoverHtml(cached);
      this.tooltipManager.createHoverTooltip(html, event.latlng, map);
      return;
    }

    // Show raster value immediately as fallback while we fetch
    const color = this.rasterColorExtractor.extractColorFromRasterLayer(
      event,
      map,
      rasterLayer,
      selectedOption,
      monthSelected,
    );

    if (!color || this.isBlackColor(color)) {
      this.tooltipManager.removeHoverTooltip(map);
      return;
    }

    const dataType = selectedOption.metadata.dataType;
    const cachedConfig = this.colorbarConfigCache[dataType];

    if (cachedConfig) {
      this.showTooltip(event, color, cachedConfig, map, variableType, false);
    } else {
      this.climateMapService.getColorbarConfig(dataType).subscribe({
        next: (colorbarConfig: ColorbarConfigResponse) => {
          this.colorbarConfigCache[dataType] = colorbarConfig;
          this.showTooltip(event, color, colorbarConfig, map, variableType, false);
        },
        error: () => {
          this.tooltipManager.removeHoverTooltip(map);
        },
      });
    }

    // Debounce: after 400ms of no movement, fetch live data and cache it
    this.hoverDebounceTimer = setTimeout(() => {
      this.hoverSub = this.openMeteoService.getCurrentConditions(lat, lon).subscribe({
        next: (conditions) => {
          this.weatherCache.set(cacheKey, conditions);
          // Limit cache to 200 entries
          if (this.weatherCache.size > 200) {
            const firstKey = this.weatherCache.keys().next().value;
            if (firstKey !== undefined) this.weatherCache.delete(firstKey);
          }
          const html = this.buildHoverHtml(conditions);
          this.tooltipManager.createHoverTooltip(html, event.latlng, map);
        },
      });
    }, 400);
  }

  handleMapClick(
    event: LeafletMouseEvent | { latlng: { lat: number; lng: number } },
    map: LeafletMap,
    rasterLayer: any,
    selectedOption: LayerOption | undefined,
    monthSelected: number,
    variableType: ClimateVarKey,
  ): void {
    if (!selectedOption?.metadata?.dataType) {
      return;
    }

    const color = this.rasterColorExtractor.extractColorFromRasterLayer(
      event,
      map,
      rasterLayer,
      selectedOption,
      monthSelected,
    );

    // Show loading popup immediately
    const lat = event.latlng.lat;
    const lon = event.latlng.lng;
    this.tooltipManager.createPersistentTooltip(
      '<div class="wp-loading">Loading weather data…</div>',
      event.latlng,
      map,
    );

    // Resolve raster value (if available)
    let rasterHtml = '';
    if (color && !this.isBlackColor(color)) {
      const dataType = selectedOption.metadata.dataType;
      const config = this.colorbarConfigCache[dataType];
      if (config) {
        rasterHtml = this.buildRasterHtml(color, config, variableType);
      } else {
        this.climateMapService.getColorbarConfig(dataType).subscribe({
          next: (cfg) => {
            this.colorbarConfigCache[dataType] = cfg;
            // Will be included once weather data arrives
          },
        });
      }
    }

    // Fetch live weather data from Open-Meteo
    this.openMeteoService.getWeatherDashboard(lat, lon).subscribe({
      next: (weather) => {
        // Re-check raster value if config arrived late
        if (!rasterHtml && color && !this.isBlackColor(color)) {
          const dataType = selectedOption.metadata!.dataType;
          const config = this.colorbarConfigCache[dataType];
          if (config) {
            rasterHtml = this.buildRasterHtml(color, config, variableType);
          }
        }
        const popupHtml = this.buildWeatherPopup(weather.current, rasterHtml, lat, lon);
        this.tooltipManager.updatePersistentTooltipContent(popupHtml, map);
      },
      error: () => {
        // If weather fetch fails, show raster value only (or error)
        const fallback = rasterHtml
          ? `<div class="wp-body">${rasterHtml}</div>`
          : '<div class="wp-loading">Weather data unavailable</div>';
        this.tooltipManager.updatePersistentTooltipContent(fallback, map);
      },
    });
  }

  private buildRasterHtml(
    color: RasterColor,
    config: ColorbarConfigResponse,
    variableType: ClimateVarKey,
  ): string {
    const value = this.rasterColorExtractor.getValueFromColor(color, config);
    if (value === null) return '';
    const { convertedValue, unit } = this.convertValueAndUnit(value, config.unit, variableType);
    return `<div class="wp-row"><span class="wp-label">Map Value</span><span class="wp-val">${convertedValue.toFixed(1)} ${unit}</span></div>`;
  }

  private buildWeatherPopup(
    c: CurrentWeather,
    rasterHtml: string,
    lat: number,
    lon: number,
  ): string {
    const tempUnit = this.temperatureUnitService.getUnit();
    const isFahrenheit = tempUnit === TemperatureUnit.FAHRENHEIT;

    const fmt = (v: number | null, decimals = 1): string =>
      v !== null ? v.toFixed(decimals) : '—';

    const convertTemp = (v: number | null): string => {
      if (v === null) return '—';
      const converted = isFahrenheit ? TemperatureUtils.celsiusToFahrenheit(v) : v;
      return converted.toFixed(1);
    };

    const tUnit = isFahrenheit ? '°F' : '°C';
    const desc = this.getWeatherDesc(c.weather_code);
    const icon = this.getWeatherIcon(c.weather_code, c.is_day);
    const windDir = this.windDirectionLabel(c.wind_direction);

    return `
<div class="wp-container">
  <div class="wp-header">
    <span class="wp-icon">${icon}</span>
    <span class="wp-temp">${convertTemp(c.temperature)}${tUnit}</span>
    <span class="wp-desc">${desc}</span>
  </div>
  <div class="wp-feels">Feels like ${convertTemp(c.apparent_temperature)}${tUnit}</div>
  <div class="wp-coords">${lat.toFixed(3)}°, ${lon.toFixed(3)}°</div>
  <div class="wp-divider"></div>
  <div class="wp-body">
    ${rasterHtml}
    <div class="wp-row"><span class="wp-label">💧 Humidity</span><span class="wp-val">${fmt(c.relative_humidity, 0)}%</span></div>
    <div class="wp-row"><span class="wp-label">🌧️ Precipitation</span><span class="wp-val">${fmt(c.precipitation)} mm</span></div>
    <div class="wp-row"><span class="wp-label">💨 Wind</span><span class="wp-val">${fmt(c.wind_speed)} km/h ${windDir}</span></div>
    <div class="wp-row"><span class="wp-label">💨 Gusts</span><span class="wp-val">${fmt(c.wind_gusts)} km/h</span></div>
    <div class="wp-row"><span class="wp-label">☁️ Cloud Cover</span><span class="wp-val">${fmt(c.cloud_cover, 0)}%</span></div>
    <div class="wp-row"><span class="wp-label">🌡️ Pressure</span><span class="wp-val">${fmt(c.pressure_msl, 0)} hPa</span></div>
  </div>
</div>`;
  }

  private getWeatherDesc(code: number | null): string {
    if (code === null) return 'Unknown';
    if (code === 0) return 'Clear sky';
    if (code === 1) return 'Mainly clear';
    if (code === 2) return 'Partly cloudy';
    if (code === 3) return 'Overcast';
    if (code <= 48) return 'Fog';
    if (code <= 55) return 'Drizzle';
    if (code <= 57) return 'Freezing drizzle';
    if (code <= 65) return 'Rain';
    if (code <= 67) return 'Freezing rain';
    if (code <= 75) return 'Snowfall';
    if (code <= 77) return 'Snow grains';
    if (code <= 82) return 'Rain showers';
    if (code <= 86) return 'Snow showers';
    if (code === 95) return 'Thunderstorm';
    if (code <= 99) return 'Thunderstorm with hail';
    return 'Unknown';
  }

  private getWeatherIcon(code: number | null, isDay: number | null): string {
    if (code === null) return '🌡️';
    const day = isDay !== 0;
    if (code === 0) return day ? '☀️' : '🌙';
    if (code <= 2) return day ? '⛅' : '☁️';
    if (code === 3) return '☁️';
    if (code <= 48) return '🌫️';
    if (code <= 57) return '🌦️';
    if (code <= 67) return '🌧️';
    if (code <= 77) return '❄️';
    if (code <= 86) return '🌨️';
    return '⛈️';
  }

  private windDirectionLabel(deg: number | null): string {
    if (deg === null) return '';
    const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
    return dirs[Math.round(deg / 22.5) % 16];
  }

  private buildHoverHtml(c: CurrentConditions): string {
    const tempUnit = this.temperatureUnitService.getUnit();
    const isFahrenheit = tempUnit === TemperatureUnit.FAHRENHEIT;
    const tUnit = isFahrenheit ? '°F' : '°C';

    const convertTemp = (v: number | null): string => {
      if (v === null) return '—';
      const converted = isFahrenheit ? TemperatureUtils.celsiusToFahrenheit(v) : v;
      return converted.toFixed(1);
    };

    const icon = this.getWeatherIcon(c.weather_code, c.is_day);
    const desc = this.getWeatherDesc(c.weather_code);
    const windDir = this.windDirectionLabel(c.wind_direction);
    const humidity = c.humidity !== null ? `${c.humidity}%` : '—';
    const wind = c.wind_speed !== null ? `${c.wind_speed.toFixed(0)} km/h ${windDir}` : '—';

    return `<span class="hover-live">${icon} ${convertTemp(c.temperature)}${tUnit} · ${desc} · 💧${humidity} · 💨${wind}</span>`;
  }

  private showTooltip(
    event: LeafletMouseEvent | { latlng: { lat: number; lng: number } },
    color: RasterColor,
    colorbarConfig: ColorbarConfigResponse,
    map: LeafletMap,
    variableType: ClimateVarKey,
    isPersistent: boolean,
  ): void {
    const value = this.rasterColorExtractor.getValueFromColor(
      color,
      colorbarConfig,
    );

    if (value === null) {
      if (isPersistent) {
        this.tooltipManager.createPersistentTooltip(
          'No data available',
          event.latlng,
          map,
        );
      } else {
        this.tooltipManager.removeHoverTooltip(map);
      }
      return;
    }

    const { convertedValue, unit } = this.convertValueAndUnit(
      value,
      colorbarConfig.unit,
      variableType,
    );

    let tooltipContent: string;
    const unitSpan = `<span class="tooltip-unit">${unit}</span>`;
    if (value >= colorbarConfig.level_upper) {
      tooltipContent = `>${convertedValue.toFixed(1)} ${unitSpan}`;
    } else if (value <= colorbarConfig.level_lower) {
      tooltipContent = `<${convertedValue.toFixed(1)} ${unitSpan}`;
    } else {
      tooltipContent = `${convertedValue.toFixed(1)} ${unitSpan}`;
    }

    if (isPersistent) {
      this.tooltipManager.createPersistentTooltip(
        tooltipContent,
        event.latlng,
        map,
      );
    } else {
      this.tooltipManager.createHoverTooltip(tooltipContent, event.latlng, map);
    }
  }

  private convertValueAndUnit(
    value: number,
    originalUnit: string,
    variableType: ClimateVarKey,
  ): { convertedValue: number; unit: string } {
    let convertedValue = value;
    let unit = UnitUtils.normalizeUnit(originalUnit, variableType);

    const isTemperature = TemperatureUtils.isTemperatureVariable(variableType);

    if (isTemperature && unit === TemperatureUnit.CELSIUS) {
      const currentUnit = this.temperatureUnitService.getUnit();
      if (currentUnit === TemperatureUnit.FAHRENHEIT) {
        convertedValue = TemperatureUtils.celsiusToFahrenheit(value);
        unit = TemperatureUnit.FAHRENHEIT;
      }
    }

    const isPrecipitation =
      PrecipitationUtils.isPrecipitationVariable(variableType);

    if (isPrecipitation && unit.startsWith(PrecipitationUnit.MM)) {
      const currentUnit = this.precipitationUnitService.getUnit();
      if (currentUnit === PrecipitationUnit.INCHES) {
        convertedValue = PrecipitationUtils.mmToInches(value);
        unit = unit.replace(PrecipitationUnit.MM, PrecipitationUnit.INCHES);
      }
    }

    return { convertedValue, unit };
  }

  private isBlackColor(color: RasterColor): boolean {
    return color.r === 0 && color.g === 0 && color.b === 0;
  }

  clearCache(): void {
    this.colorbarConfigCache = {};
  }
}
