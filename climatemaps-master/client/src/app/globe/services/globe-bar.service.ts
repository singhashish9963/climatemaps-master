import { Injectable } from '@angular/core';
import { Observable, forkJoin, map } from 'rxjs';
import {
  ClimateMapService,
  ClimateValueResponse,
  ColorbarConfigResponse,
} from '../../core/climatemap.service';
import { CoordinateUtils } from '../../utils/coordinate-utils';

export interface GridPoint {
  lat: number;
  lon: number;
}

export interface GridSample {
  lat: number;
  lon: number;
  value: number;
}

export interface BarRenderData {
  lat: number;
  lon: number;
  value: number;
  normalizedHeight: number; // 0..1
  color: [number, number, number]; // RGB 0-255
}

// Grid configuration
const GRID_SIZE = 5; // 5×5 = 25 sample points
const HALF = Math.floor(GRID_SIZE / 2);
const DEFAULT_SPACING_DEG = 0.5; // degrees between sample points
const MIN_BAR_HEIGHT_METERS = 20000; // Minimum bar height so small values are visible
const MAX_BAR_HEIGHT_METERS = 500000; // Maximum bar height in meters

@Injectable({
  providedIn: 'root',
})
export class GlobeBarService {
  constructor(private climateMapService: ClimateMapService) {}

  /**
   * Generate a grid of sample points around a center lat/lon.
   * Spacing adapts to camera height for appropriate density.
   */
  generateGrid(
    centerLat: number,
    centerLon: number,
    cameraHeight: number,
  ): GridPoint[] {
    const spacing = this.computeSpacing(cameraHeight);
    const points: GridPoint[] = [];

    for (let row = -HALF; row <= HALF; row++) {
      for (let col = -HALF; col <= HALF; col++) {
        const lat = Math.max(-85, Math.min(85, centerLat + row * spacing));
        const lon = CoordinateUtils.normalizeLongitude(
          centerLon + col * spacing,
        );
        points.push({ lat, lon });
      }
    }

    return points;
  }

  /**
   * Compute grid spacing in degrees based on camera altitude.
   * Closer zoom → finer grid, farther → coarser.
   */
  private computeSpacing(cameraHeight: number): number {
    if (cameraHeight < 500000) return 0.2;
    if (cameraHeight < 2000000) return 0.5;
    if (cameraHeight < 5000000) return 1.0;
    if (cameraHeight < 10000000) return 2.0;
    return 3.0;
  }

  /**
   * Fetch climate values for all grid points in parallel.
   */
  fetchGridValues(
    grid: GridPoint[],
    dataType: string,
    month: number,
  ): Observable<GridSample[]> {
    const requests: Record<string, Observable<ClimateValueResponse>> = {};

    grid.forEach((pt, i) => {
      requests[`p${i}`] = this.climateMapService.getClimateValue(
        dataType,
        month,
        pt.lat,
        pt.lon,
      );
    });

    return forkJoin(requests).pipe(
      map((results) => {
        return grid
          .map((pt, i) => {
            const resp = results[`p${i}`];
            if (!resp || resp.value == null || isNaN(resp.value)) return null;
            return { lat: pt.lat, lon: pt.lon, value: resp.value };
          })
          .filter((s): s is GridSample => s !== null);
      }),
    );
  }

  /**
   * Convert sampled grid values into bar render data with
   * normalized heights and colors from the colorbar config.
   */
  buildBarData(
    samples: GridSample[],
    colorbarConfig: ColorbarConfigResponse,
  ): BarRenderData[] {
    if (samples.length === 0) return [];

    const values = samples.map((s) => s.value);
    const minVal = Math.min(...values);
    const maxVal = Math.max(...values);
    const range = maxVal - minVal || 1; // avoid division by zero

    return samples.map((s) => ({
      lat: s.lat,
      lon: s.lon,
      value: s.value,
      normalizedHeight: (s.value - minVal) / range,
      color: this.valueToColor(s.value, colorbarConfig),
    }));
  }

  /**
   * Get bar height in meters from normalized value (0..1).
   */
  getBarHeightMeters(normalizedHeight: number): number {
    return (
      MIN_BAR_HEIGHT_METERS +
      normalizedHeight * (MAX_BAR_HEIGHT_METERS - MIN_BAR_HEIGHT_METERS)
    );
  }

  /**
   * Get cell size in degrees for bar width, based on camera height.
   */
  getCellSizeDeg(cameraHeight: number): number {
    const spacing = this.computeSpacing(cameraHeight);
    return spacing * 0.8; // slightly smaller than spacing to create gaps
  }

  /**
   * Map a climate value to an RGB color using the colorbar config levels/colors.
   */
  private valueToColor(
    value: number,
    config: ColorbarConfigResponse,
  ): [number, number, number] {
    const { levels, colors } = config;

    // API returns colors as 0.0–1.0 floats (matplotlib RGBA).
    // Convert a single color array to 0–255 RGB.
    const to255 = (c: number[]): [number, number, number] => [
      Math.round(c[0] * 255),
      Math.round(c[1] * 255),
      Math.round(c[2] * 255),
    ];

    // Below lowest level
    if (value <= levels[0]) {
      return to255(colors[0]);
    }

    // Above highest level
    if (value >= levels[levels.length - 1]) {
      return to255(colors[colors.length - 1]);
    }

    // Find which level bin the value falls into
    for (let i = 0; i < levels.length - 1; i++) {
      if (value >= levels[i] && value < levels[i + 1]) {
        // Interpolate between the two colors (in 0-1 space, then convert)
        const t =
          (value - levels[i]) / (levels[i + 1] - levels[i]);
        const c1 = colors[i];
        const c2 = colors[Math.min(i + 1, colors.length - 1)];
        return [
          Math.round((c1[0] + t * (c2[0] - c1[0])) * 255),
          Math.round((c1[1] + t * (c2[1] - c1[1])) * 255),
          Math.round((c1[2] + t * (c2[2] - c1[2])) * 255),
        ];
      }
    }

    // Fallback
    return to255(colors[colors.length - 1]);
  }
}
