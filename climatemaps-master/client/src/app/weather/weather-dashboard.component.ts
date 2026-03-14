import {
  Component,
  OnInit,
  OnDestroy,
  ViewChild,
  ElementRef,
  NgZone,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule, ReactiveFormsModule, FormControl } from '@angular/forms';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatAutocompleteModule } from '@angular/material/autocomplete';
import { MatInputModule } from '@angular/material/input';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatTabsModule } from '@angular/material/tabs';
import {
  Observable,
  Subscription,
  BehaviorSubject,
  of,
} from 'rxjs';
import {
  debounceTime,
  distinctUntilChanged,
  switchMap,
  finalize,
} from 'rxjs/operators';
import { Chart, ChartConfiguration, registerables } from 'chart.js';

import {
  OpenMeteoService,
  WeatherDashboardResponse,
  CurrentWeather,
  HourlyWeather,
  DailyWeather,
} from '../core/open-meteo.service';
import {
  GeocodingService,
  LocationSuggestion,
} from '../core/geocoding.service';
import { ClimateMapService } from '../core/climatemap.service';
import {
  TemperatureUnitService,
  TemperatureUnit,
} from '../core/temperature-unit.service';
import { TemperatureUtils } from '../utils/temperature-utils';

Chart.register(...registerables);

@Component({
  selector: 'app-weather-dashboard',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    ReactiveFormsModule,
    MatCardModule,
    MatIconModule,
    MatButtonModule,
    MatProgressSpinnerModule,
    MatAutocompleteModule,
    MatInputModule,
    MatTooltipModule,
    MatTabsModule,
  ],
  templateUrl: './weather-dashboard.component.html',
  styleUrl: './weather-dashboard.component.scss',
})
export class WeatherDashboardComponent implements OnInit, OnDestroy {
  searchControl = new FormControl('');
  filteredLocations$!: Observable<LocationSuggestion[]>;
  isLoadingSearch$ = new BehaviorSubject<boolean>(false);

  data: WeatherDashboardResponse | null = null;
  cityName = '';
  countryName = '';
  isLoading = false;
  error: string | null = null;

  private tempUnit: TemperatureUnit = TemperatureUnit.CELSIUS;
  private subscriptions = new Subscription();

  // Hourly chart
  private _hourlyCanvas: ElementRef<HTMLCanvasElement> | null = null;
  @ViewChild('hourlyChart', { static: false })
  set hourlyCanvas(el: ElementRef<HTMLCanvasElement>) {
    this._hourlyCanvas = el ?? null;
    if (el && this.data) {
      this._zone.run(() => setTimeout(() => this.renderHourlyChart(), 0));
    }
  }
  private hourlyChartInstance: Chart | null = null;

  // Daily chart
  private _dailyCanvas: ElementRef<HTMLCanvasElement> | null = null;
  @ViewChild('dailyChart', { static: false })
  set dailyCanvas(el: ElementRef<HTMLCanvasElement>) {
    this._dailyCanvas = el ?? null;
    if (el && this.data) {
      this._zone.run(() => setTimeout(() => this.renderDailyChart(), 0));
    }
  }
  private dailyChartInstance: Chart | null = null;

  constructor(
    private openMeteoService: OpenMeteoService,
    private geocodingService: GeocodingService,
    private climateMapService: ClimateMapService,
    private temperatureUnitService: TemperatureUnitService,
    private _zone: NgZone,
  ) {}

  ngOnInit(): void {
    this.setupSearch();

    this.subscriptions.add(
      this.temperatureUnitService.unit$.subscribe((unit) => {
        this.tempUnit = unit;
        if (this.data) {
          this.renderHourlyChart();
          this.renderDailyChart();
        }
      }),
    );

    // Default: load weather for New Delhi
    this.loadWeather(28.6139, 77.209);
    this.cityName = 'New Delhi';
    this.countryName = 'India';
  }

  ngOnDestroy(): void {
    this.subscriptions.unsubscribe();
    this.destroyCharts();
  }

  private setupSearch(): void {
    this.searchControl.valueChanges
      .pipe(debounceTime(10), distinctUntilChanged())
      .subscribe((v) => {
        const q = typeof v === 'string' ? v : '';
        this.isLoadingSearch$.next(q.length >= 2);
      });

    this.filteredLocations$ = this.searchControl.valueChanges.pipe(
      debounceTime(300),
      distinctUntilChanged(),
      switchMap((value) => {
        const query = typeof value === 'string' ? value : '';
        if (!query || query.trim().length < 2) {
          this.isLoadingSearch$.next(false);
          return of([]);
        }
        return this.geocodingService
          .searchLocations(query)
          .pipe(finalize(() => this.isLoadingSearch$.next(false)));
      }),
    ) as Observable<LocationSuggestion[]>;
  }

  onLocationSelected(location: LocationSuggestion): void {
    this.searchControl.setValue(location.displayName, { emitEvent: false });
    this.loadWeather(location.lat, location.lon);
    // Resolve city name
    this.subscriptions.add(
      this.climateMapService.getNearestCity(location.lat, location.lon).subscribe({
        next: (city) => {
          this.cityName = city.city_name;
          this.countryName = city.country_name;
        },
      }),
    );
  }

  displayLocationName(loc: LocationSuggestion | string): string {
    return typeof loc === 'string' ? loc : (loc?.displayName ?? '');
  }

  clearSearch(): void {
    this.searchControl.setValue('');
  }

  private loadWeather(lat: number, lon: number): void {
    this.isLoading = true;
    this.error = null;

    this.subscriptions.add(
      this.openMeteoService.getWeatherDashboard(lat, lon).subscribe({
        next: (res) => {
          this.data = res;
          this.isLoading = false;
          setTimeout(() => {
            this.renderHourlyChart();
            this.renderDailyChart();
          }, 100);
        },
        error: (err) => {
          this.error = err.error?.detail || 'Failed to load weather data';
          this.isLoading = false;
        },
      }),
    );
  }

  // ── Display helpers ──

  convertTemp(val: number | null): string {
    if (val === null) return '—';
    const v =
      this.tempUnit === TemperatureUnit.FAHRENHEIT
        ? TemperatureUtils.celsiusToFahrenheit(val)
        : val;
    return v.toFixed(1);
  }

  tempSuffix(): string {
    return this.tempUnit === TemperatureUnit.FAHRENHEIT ? '°F' : '°C';
  }

  getWeatherIcon(code: number | null): string {
    if (code === null) return 'cloud';
    if (code === 0) return 'wb_sunny';
    if (code <= 3) return 'partly_cloudy_day';
    if (code <= 48) return 'foggy';
    if (code <= 57) return 'grain';
    if (code <= 67) return 'water';
    if (code <= 77) return 'ac_unit';
    if (code <= 82) return 'water';
    if (code <= 86) return 'ac_unit';
    return 'thunderstorm';
  }

  getWeatherDesc(code: number | null): string {
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

  windDirectionLabel(deg: number | null): string {
    if (deg === null) return '—';
    const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
                  'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
    return dirs[Math.round(deg / 22.5) % 16];
  }

  formatTime(iso: string | null): string {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  formatDuration(seconds: number | null): string {
    if (seconds === null) return '—';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${h}h ${m}m`;
  }

  formatDate(dateStr: string): string {
    const d = new Date(dateStr + 'T12:00:00');
    return d.toLocaleDateString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });
  }

  formatHour(timeStr: string): string {
    const d = new Date(timeStr);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  uvLevel(val: number | null): string {
    if (val === null) return '—';
    if (val <= 2) return 'Low';
    if (val <= 5) return 'Moderate';
    if (val <= 7) return 'High';
    if (val <= 10) return 'Very High';
    return 'Extreme';
  }

  uvColor(val: number | null): string {
    if (val === null) return '#999';
    if (val <= 2) return '#4caf50';
    if (val <= 5) return '#ff9800';
    if (val <= 7) return '#f44336';
    if (val <= 10) return '#9c27b0';
    return '#d50000';
  }

  /** Get the 24 hours from "now" out of the hourly data */
  get next24Hours(): HourlyWeather[] {
    if (!this.data) return [];
    const now = new Date();
    return this.data.hourly
      .filter((h) => new Date(h.time) >= now)
      .slice(0, 24);
  }

  get today(): DailyWeather | null {
    return this.data?.daily?.[0] ?? null;
  }

  // ── Charts ──

  private renderHourlyChart(): void {
    if (!this._hourlyCanvas?.nativeElement || !this.data) return;
    if (this.hourlyChartInstance) {
      this.hourlyChartInstance.destroy();
      this.hourlyChartInstance = null;
    }

    const hours = this.next24Hours;
    if (hours.length === 0) return;

    const labels = hours.map((h) => this.formatHour(h.time));
    const isFahrenheit = this.tempUnit === TemperatureUnit.FAHRENHEIT;
    const conv = (v: number | null) =>
      v === null ? null : isFahrenheit ? TemperatureUtils.celsiusToFahrenheit(v) : v;

    const config: ChartConfiguration = {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: `Temperature (${this.tempSuffix()})`,
            data: hours.map((h) => conv(h.temperature)),
            borderColor: '#e65100',
            backgroundColor: 'rgba(230,81,0,0.1)',
            fill: true,
            tension: 0.4,
            yAxisID: 'y',
            pointRadius: 2,
          },
          {
            label: `Feels Like (${this.tempSuffix()})`,
            data: hours.map((h) => conv(h.apparent_temperature)),
            borderColor: 'rgba(230,81,0,0.4)',
            borderDash: [4, 4],
            tension: 0.4,
            yAxisID: 'y',
            pointRadius: 0,
          },
          {
            type: 'bar',
            label: 'Precipitation (mm)',
            data: hours.map((h) => h.precipitation),
            backgroundColor: 'rgba(33,150,243,0.5)',
            yAxisID: 'y1',
          } as any,
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { position: 'top', labels: { boxWidth: 10, font: { size: 11 } } },
        },
        scales: {
          y: { title: { display: true, text: `Temp (${this.tempSuffix()})` }, position: 'left' },
          y1: { title: { display: true, text: 'Precip (mm)' }, position: 'right', grid: { drawOnChartArea: false }, min: 0 },
        },
      },
    };

    this.hourlyChartInstance = new Chart(this._hourlyCanvas.nativeElement, config);
  }

  private renderDailyChart(): void {
    if (!this._dailyCanvas?.nativeElement || !this.data) return;
    if (this.dailyChartInstance) {
      this.dailyChartInstance.destroy();
      this.dailyChartInstance = null;
    }

    const days = this.data.daily;
    if (days.length === 0) return;

    const labels = days.map((d) => this.formatDate(d.date));
    const isFahrenheit = this.tempUnit === TemperatureUnit.FAHRENHEIT;
    const conv = (v: number | null) =>
      v === null ? null : isFahrenheit ? TemperatureUtils.celsiusToFahrenheit(v) : v;

    const config: ChartConfiguration = {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            type: 'line',
            label: `Max Temp (${this.tempSuffix()})`,
            data: days.map((d) => conv(d.temp_max)),
            borderColor: '#e65100',
            backgroundColor: 'rgba(230,81,0,0.1)',
            tension: 0.4,
            yAxisID: 'y',
            pointRadius: 4,
            order: 1,
          } as any,
          {
            type: 'line',
            label: `Min Temp (${this.tempSuffix()})`,
            data: days.map((d) => conv(d.temp_min)),
            borderColor: '#1565c0',
            backgroundColor: 'rgba(21,101,192,0.1)',
            tension: 0.4,
            yAxisID: 'y',
            pointRadius: 4,
            order: 1,
          } as any,
          {
            label: 'Rain (mm)',
            data: days.map((d) => d.rain_sum),
            backgroundColor: 'rgba(33,150,243,0.5)',
            yAxisID: 'y1',
            order: 2,
          },
          {
            label: 'Snowfall (cm)',
            data: days.map((d) => d.snowfall_sum),
            backgroundColor: 'rgba(144,202,249,0.7)',
            yAxisID: 'y1',
            order: 2,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { position: 'top', labels: { boxWidth: 10, font: { size: 11 } } },
        },
        scales: {
          y: { title: { display: true, text: `Temperature (${this.tempSuffix()})` }, position: 'left' },
          y1: { title: { display: true, text: 'Precip (mm) / Snow (cm)' }, position: 'right', grid: { drawOnChartArea: false }, min: 0 },
        },
      },
    };

    this.dailyChartInstance = new Chart(this._dailyCanvas.nativeElement, config);
  }

  private destroyCharts(): void {
    if (this.hourlyChartInstance) {
      this.hourlyChartInstance.destroy();
      this.hourlyChartInstance = null;
    }
    if (this.dailyChartInstance) {
      this.dailyChartInstance.destroy();
      this.dailyChartInstance = null;
    }
  }
}
