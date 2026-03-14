import {
  Component,
  OnInit,
  OnDestroy,
  ViewChild,
  ElementRef,
  ChangeDetectorRef,
  NgZone,
} from '@angular/core';
import {
  Viewer,
  Cartesian2,
  Cartesian3,
  Math as CesiumMath,
  SceneMode,
  Color,
  EllipsoidTerrainProvider,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  Cartographic,
  defined,
  Entity,
} from 'cesium';
import { CommonModule } from '@angular/common';
import { FormsModule, ReactiveFormsModule, FormControl } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatSelectModule } from '@angular/material/select';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatAutocompleteModule } from '@angular/material/autocomplete';
import { MatInputModule } from '@angular/material/input';
import { MatCardModule } from '@angular/material/card';
import { LeafletModule } from '@bluehalo/ngx-leaflet';
import {
  latLng,
  Map,
  Marker,
  marker,
  tileLayer,
  LeafletMouseEvent,
  DivIcon,
  divIcon,
} from 'leaflet';
import { Chart, ChartConfiguration, registerables } from 'chart.js';
import { Observable, forkJoin, Subscription, BehaviorSubject } from 'rxjs';
import {
  debounceTime,
  distinctUntilChanged,
  switchMap,
  finalize,
} from 'rxjs/operators';

import {
  ClimateMapService,
  NearestCityResponse,
} from '../core/climatemap.service';
import { MetadataService, YearRange } from '../core/metadata.service';
import {
  GeocodingService,
  LocationSuggestion,
} from '../core/geocoding.service';
import {
  TemperatureUnitService,
  TemperatureUnit,
} from '../core/temperature-unit.service';
import { PrecipitationUnitService } from '../core/precipitation-unit.service';
import {
  ClimateVarKey,
  CLIMATE_VAR_KEY_TO_NAME,
} from '../utils/enum';
import { TemperatureUtils } from '../utils/temperature-utils';
import { PrecipitationUtils } from '../utils/precipitation-utils';
import { MonthSliderComponent } from '../map/controls/sliders/month-slider.component';

Chart.register(...registerables);

interface LocationState {
  lat: number;
  lon: number;
  cityName: string;
}

interface MonthlyData {
  tmax: number[];
  tmin: number[];
  precipitation: number[];
}

interface LocationData {
  cityInfo: NearestCityResponse | null;
  monthlyData: MonthlyData | null;
  isLoading: boolean;
  error: string | null;
}

@Component({
  selector: 'app-compare',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    ReactiveFormsModule,
    LeafletModule,
    MatButtonModule,
    MatIconModule,
    MatSelectModule,
    MatProgressSpinnerModule,
    MatAutocompleteModule,
    MatInputModule,
    MatCardModule,
    MonthSliderComponent,
  ],
  templateUrl: './compare.component.html',
  styleUrl: './compare.component.scss',
})
export class CompareComponent implements OnInit, OnDestroy {
  // Setter-based ViewChild so renderChart fires the moment ngIf creates the canvas
  private _chartCanvas: ElementRef<HTMLCanvasElement> | null = null;
  @ViewChild('chartCanvas', { static: false })
  set chartCanvas(el: ElementRef<HTMLCanvasElement>) {
    this._chartCanvas = el ?? null;
    if (el && this.dataA.monthlyData && this.dataB.monthlyData) {
      // Give Angular one tick to finish rendering the element
      this._zone.run(() => setTimeout(() => this.renderChart(), 0));
    }
  }

  private leafletMap: Map | null = null;
  private markerA: Marker | null = null;
  private markerB: Marker | null = null;
  private chart: Chart | null = null;

  // Globe (Cesium) state
  @ViewChild('globeContainer', { static: false })
  private globeContainerRef?: ElementRef<HTMLDivElement>;
  private cesiumViewer: Viewer | null = null;
  private cesiumHandler: ScreenSpaceEventHandler | null = null;
  private cesiumEntityA: Entity | null = null;
  private cesiumEntityB: Entity | null = null;

  viewMode: 'map' | 'globe' = 'map';
  activeMarker: 'A' | 'B' = 'A';
  showBottomBar = true;

  locationA: LocationState | null = null;
  locationB: LocationState | null = null;

  searchControlA = new FormControl('');
  searchControlB = new FormControl('');
  filteredLocationsA$!: Observable<LocationSuggestion[]>;
  filteredLocationsB$!: Observable<LocationSuggestion[]>;
  isLoadingSearchA$ = new BehaviorSubject<boolean>(false);
  isLoadingSearchB$ = new BehaviorSubject<boolean>(false);

  selectedMonth = new Date().getMonth() + 1;
  selectedYearRange: YearRange | null = null;
  yearRanges: YearRange[] = [];

  dataA: LocationData = {
    cityInfo: null,
    monthlyData: null,
    isLoading: false,
    error: null,
  };
  dataB: LocationData = {
    cityInfo: null,
    monthlyData: null,
    isLoading: false,
    error: null,
  };

  private currentTempUnit: TemperatureUnit = TemperatureUnit.CELSIUS;
  private subscriptions = new Subscription();

  mapOptions: any;

  readonly MONTHS = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];
  readonly MONTH_NAMES = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];

  constructor(
    private climateMapService: ClimateMapService,
    private metadataService: MetadataService,
    private geocodingService: GeocodingService,
    private temperatureUnitService: TemperatureUnitService,
    private precipitationUnitService: PrecipitationUnitService,
    private cdr: ChangeDetectorRef,
    private _zone: NgZone,
  ) {}

  ngOnInit(): void {
    this.mapOptions = {
      layers: [
        tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 18,
          attribution:
            '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        }),
      ],
      zoom: 5,
      center: latLng(25.0, 80.0),
    };

    this.setupSearchControls();

    this.climateMapService.getClimateMapList().subscribe({
      next: (climateMaps) => {
        const all = this.metadataService.getYearRanges(climateMaps);
        this.yearRanges = all.filter((r) => r.value[0] < 2000);
        if (this.yearRanges.length > 0) {
          this.selectedYearRange = this.yearRanges[0];
          // Retry any locations that were placed before year ranges loaded
          if (this.locationA) this.loadData('A');
          if (this.locationB) this.loadData('B');
        }
      },
    });

    this.subscriptions.add(
      this.temperatureUnitService.unit$.subscribe((unit) => {
        this.currentTempUnit = unit;
        if (this.dataA.monthlyData && this.dataB.monthlyData) {
          this.renderChart();
        }
      }),
    );

    this.subscriptions.add(
      this.precipitationUnitService.unit$.subscribe(() => {
        if (this.dataA.monthlyData && this.dataB.monthlyData) {
          this.renderChart();
        }
      }),
    );
  }

  ngOnDestroy(): void {
    this.subscriptions.unsubscribe();
    this.destroyChart();
    this.destroyGlobe();
  }

  private setupSearchControls(): void {
    const makeStream = (
      control: FormControl,
      loading$: BehaviorSubject<boolean>,
    ): Observable<LocationSuggestion[]> => {
      control.valueChanges
        .pipe(debounceTime(10), distinctUntilChanged())
        .subscribe((v) => {
          const q = typeof v === 'string' ? v : '';
          loading$.next(q.length >= 2);
        });

      return control.valueChanges.pipe(
        debounceTime(300),
        distinctUntilChanged(),
        switchMap((value) => {
          const query = typeof value === 'string' ? value : '';
          if (!query || query.trim().length < 2) {
            loading$.next(false);
            return [];
          }
          return this.geocodingService
            .searchLocations(query)
            .pipe(finalize(() => loading$.next(false)));
        }),
      ) as Observable<LocationSuggestion[]>;
    };

    this.filteredLocationsA$ = makeStream(
      this.searchControlA,
      this.isLoadingSearchA$,
    );
    this.filteredLocationsB$ = makeStream(
      this.searchControlB,
      this.isLoadingSearchB$,
    );
  }

  onMapReady(map: Map): void {
    this.leafletMap = map;
    // Re-place markers when Leaflet map is re-created (e.g. after switching back from globe)
    if (this.locationA) {
      const lbl = this.locationA.cityName ? `📍 A: ${this.locationA.cityName}` : undefined;
      this.placeMarker('A', this.locationA.lat, this.locationA.lon, lbl);
    }
    if (this.locationB) {
      const lbl = this.locationB.cityName ? `📍 B: ${this.locationB.cityName}` : undefined;
      this.placeMarker('B', this.locationB.lat, this.locationB.lon, lbl);
    }
  }

  onMapClick(event: LeafletMouseEvent): void {
    const { lat, lng } = event.latlng;
    if (this.activeMarker === 'A') {
      // updateSearch=true: after city resolves, populate the search box
      this.setLocationA(lat, lng, true);
    } else {
      this.setLocationB(lat, lng, true);
    }
  }

  private setLocationA(lat: number, lon: number, updateSearch = false): void {
    this.locationA = { lat, lon, cityName: '' };
    this.placeMarker('A', lat, lon);
    this.placeGlobeMarker('A', lat, lon);
    if (updateSearch) {
      // Clear search so we don't show stale previous query
      this.searchControlA.setValue('', { emitEvent: false });
    }
    this.loadData('A', updateSearch);
  }

  private setLocationB(lat: number, lon: number, updateSearch = false): void {
    this.locationB = { lat, lon, cityName: '' };
    this.placeMarker('B', lat, lon);
    this.placeGlobeMarker('B', lat, lon);
    if (updateSearch) {
      this.searchControlB.setValue('', { emitEvent: false });
    }
    this.loadData('B', updateSearch);
  }

  private placeMarker(which: 'A' | 'B', lat: number, lon: number, tooltipText?: string): void {
    if (!this.leafletMap) return;
    const color = which === 'A' ? '#1565c0' : '#e65100';
    const initialTooltip = tooltipText ?? `📍 ${which}: Loading…`;
    const markerIcon: DivIcon = divIcon({
      className: '',
      html: `<div style="background:${color};color:white;border-radius:50%;width:28px;height:28px;display:flex;align-items:center;justify-content:center;font-weight:bold;font-size:14px;border:2px solid white;box-shadow:0 2px 6px rgba(0,0,0,0.4);">${which}</div>`,
      iconSize: [28, 28],
      iconAnchor: [14, 14],
    });

    if (which === 'A') {
      if (this.markerA) this.leafletMap.removeLayer(this.markerA);
      this.markerA = marker([lat, lon], { icon: markerIcon, draggable: true })
        .bindTooltip(initialTooltip, {
          permanent: true,
          direction: 'top',
          offset: [0, -18],
          className: 'compare-marker-tooltip compare-marker-a',
        })
        .addTo(this.leafletMap)
        .on('dragend', (e) => {
          const pos = (e.target as Marker).getLatLng();
          this.setLocationA(pos.lat, pos.lng, true);
        });
    } else {
      if (this.markerB) this.leafletMap.removeLayer(this.markerB);
      this.markerB = marker([lat, lon], { icon: markerIcon, draggable: true })
        .bindTooltip(initialTooltip, {
          permanent: true,
          direction: 'top',
          offset: [0, -18],
          className: 'compare-marker-tooltip compare-marker-b',
        })
        .addTo(this.leafletMap)
        .on('dragend', (e) => {
          const pos = (e.target as Marker).getLatLng();
          this.setLocationB(pos.lat, pos.lng, true);
        });
    }
  }

  onLocationSelectedA(location: LocationSuggestion): void {
    this.searchControlA.setValue(location.displayName, { emitEvent: false });
    // fromSearch=false so the search control value is NOT overwritten by the city API result
    this.setLocationA(location.lat, location.lon, false);
    if (this.leafletMap) {
      this.leafletMap.setView(
        [location.lat, location.lon],
        Math.max(this.leafletMap.getZoom(), 6),
      );
    }
  }

  onLocationSelectedB(location: LocationSuggestion): void {
    this.searchControlB.setValue(location.displayName, { emitEvent: false });
    this.setLocationB(location.lat, location.lon, false);
    if (this.leafletMap) {
      this.leafletMap.setView(
        [location.lat, location.lon],
        Math.max(this.leafletMap.getZoom(), 6),
      );
    }
  }

  displayLocationName(loc: LocationSuggestion | string): string {
    return typeof loc === 'string' ? loc : (loc?.displayName ?? '');
  }

  clearSearchA(): void {
    this.searchControlA.setValue('');
  }

  clearSearchB(): void {
    this.searchControlB.setValue('');
  }

  onMonthChange(month: number): void {
    this.selectedMonth = month;
  }

  onYearRangeChange(): void {
    if (this.locationA) this.loadData('A');
    if (this.locationB) this.loadData('B');
  }

  yearRangeCompare(a: YearRange, b: YearRange): boolean {
    return a?.value[0] === b?.value[0] && a?.value[1] === b?.value[1];
  }

  private loadData(which: 'A' | 'B', updateSearch = false): void {
    const location = which === 'A' ? this.locationA : this.locationB;
    // If year ranges haven't loaded yet, store the intent — the getClimateMapList
    // subscriber will call loadData again once selectedYearRange is populated.
    if (!location || !this.selectedYearRange) return;

    if (which === 'A') {
      this.dataA = { cityInfo: null, monthlyData: null, isLoading: true, error: null };
    } else {
      this.dataB = { cityInfo: null, monthlyData: null, isLoading: true, error: null };
    }

    const dt = (v: ClimateVarKey) => this.getDataType(v);
    const allRequests: Observable<any>[] = [];

    for (let m = 1; m <= 12; m++) {
      allRequests.push(
        this.climateMapService.getClimateValue(
          dt(ClimateVarKey.T_MAX),
          m,
          location.lat,
          location.lon,
        ),
      );
      allRequests.push(
        this.climateMapService.getClimateValue(
          dt(ClimateVarKey.T_MIN),
          m,
          location.lat,
          location.lon,
        ),
      );
      allRequests.push(
        this.climateMapService.getClimateValue(
          dt(ClimateVarKey.PRECIPITATION),
          m,
          location.lat,
          location.lon,
        ),
      );
    }

    forkJoin({
      values: forkJoin(allRequests),
      city: this.climateMapService.getNearestCity(location.lat, location.lon),
    }).subscribe({
      next: (results) => {
        const tmax: number[] = [];
        const tmin: number[] = [];
        const precipitation: number[] = [];

        for (let i = 0; i < 12; i++) {
          tmax.push(results.values[i * 3].value);
          tmin.push(results.values[i * 3 + 1].value);
          precipitation.push(results.values[i * 3 + 2].value);
        }

        const newData: LocationData = {
          cityInfo: results.city,
          monthlyData: { tmax, tmin, precipitation },
          isLoading: false,
          error: null,
        };

        const cityLabel = `${results.city.city_name}, ${results.city.country_code}`;

        if (which === 'A') {
          this.dataA = newData;
          if (this.locationA) this.locationA.cityName = cityLabel;
          // Update the permanent tooltip on the map marker
          if (this.markerA) this.markerA.setTooltipContent(`📍 A: ${cityLabel}`);
          this.placeGlobeMarker('A', location.lat, location.lon, cityLabel);
          // Populate the search box when placed by map click
          if (updateSearch) {
            this.searchControlA.setValue(cityLabel, { emitEvent: false });
          }
        } else {
          this.dataB = newData;
          if (this.locationB) this.locationB.cityName = cityLabel;
          if (this.markerB) this.markerB.setTooltipContent(`📍 B: ${cityLabel}`);
          this.placeGlobeMarker('B', location.lat, location.lon, cityLabel);
          if (updateSearch) {
            this.searchControlB.setValue(cityLabel, { emitEvent: false });
          }
        }

        this.cdr.detectChanges();
        if (this.dataA.monthlyData && this.dataB.monthlyData) {
          // _chartCanvas setter fires if both were already loaded;
          // if this is the second location to load, trigger manually
          setTimeout(() => this.renderChart(), 50);
        }
      },
      error: (err) => {
        const errMsg = err.error?.detail || 'Failed to load climate data';
        if (which === 'A') {
          this.dataA = { ...this.dataA, isLoading: false, error: errMsg };
        } else {
          this.dataB = { ...this.dataB, isLoading: false, error: errMsg };
        }
        this.cdr.detectChanges();
      },
    });
  }

  private getDataType(variable: ClimateVarKey): string {
    if (!this.selectedYearRange) return '';
    const name = CLIMATE_VAR_KEY_TO_NAME[variable];
    const [s, e] = this.selectedYearRange.value;
    return `${name}_${s}_${e}_10m`;
  }

  getMonthValue(
    data: LocationData,
    variable: 'tmax' | 'tmin' | 'precipitation',
  ): string {
    if (!data.monthlyData) return '—';
    const idx = this.selectedMonth - 1;
    const raw = data.monthlyData[variable][idx];
    if (variable === 'tmax' || variable === 'tmin') {
      const val =
        this.currentTempUnit === TemperatureUnit.FAHRENHEIT
          ? TemperatureUtils.celsiusToFahrenheit(raw)
          : raw;
      return `${val.toFixed(1)} ${this.currentTempUnit}`;
    }
    const precipUnit = this.precipitationUnitService.getUnit();
    const val =
      precipUnit === 'in' ? PrecipitationUtils.mmToInches(raw) : raw;
    return `${val.toFixed(1)} ${precipUnit === 'in' ? 'in' : 'mm'}`;
  }

  getMonthName(): string {
    return this.MONTH_NAMES[this.selectedMonth - 1];
  }

  getLocationLabel(loc: LocationState | null, which: 'A' | 'B'): string {
    if (!loc) return `Location ${which} not set`;
    if (loc.cityName) return loc.cityName;
    return `(${loc.lat.toFixed(2)}, ${loc.lon.toFixed(2)})`;
  }

  private renderChart(): void {
    if (
      !this._chartCanvas?.nativeElement ||
      !this.dataA.monthlyData ||
      !this.dataB.monthlyData
    )
      return;
    this.destroyChart();

    const nameA = this.locationA?.cityName || 'Location A';
    const nameB = this.locationB?.cityName || 'Location B';
    const tempUnit = this.currentTempUnit;

    const convertTemp = (vals: number[]) =>
      vals.map((v) =>
        tempUnit === TemperatureUnit.FAHRENHEIT
          ? TemperatureUtils.celsiusToFahrenheit(v)
          : v,
      );

    const precipUnit = this.precipitationUnitService.getUnit();
    const convertPrecip = (vals: number[]) =>
      vals.map((v) =>
        precipUnit === 'in' ? PrecipitationUtils.mmToInches(v) : v,
      );

    const tmaxA = convertTemp(this.dataA.monthlyData.tmax);
    const tminA = convertTemp(this.dataA.monthlyData.tmin);
    const precipA = convertPrecip(this.dataA.monthlyData.precipitation);
    const tmaxB = convertTemp(this.dataB.monthlyData.tmax);
    const tminB = convertTemp(this.dataB.monthlyData.tmin);
    const precipB = convertPrecip(this.dataB.monthlyData.precipitation);

    const precipLabel = precipUnit === 'in' ? 'in/month' : 'mm/month';

    const config: ChartConfiguration = {
      type: 'line',
      data: {
        labels: this.MONTHS,
        datasets: [
          {
            label: `Tmax – ${nameA}`,
            data: tmaxA,
            borderColor: 'rgb(21,101,192)',
            backgroundColor: 'rgba(21,101,192,0.08)',
            tension: 0.4,
            yAxisID: 'y',
            pointRadius: 3,
          },
          {
            label: `Tmin – ${nameA}`,
            data: tminA,
            borderColor: 'rgba(21,101,192,0.55)',
            backgroundColor: 'rgba(21,101,192,0.04)',
            tension: 0.4,
            yAxisID: 'y',
            borderDash: [4, 4],
            pointRadius: 3,
          },
          {
            label: `Tmax – ${nameB}`,
            data: tmaxB,
            borderColor: 'rgb(230,81,0)',
            backgroundColor: 'rgba(230,81,0,0.08)',
            tension: 0.4,
            yAxisID: 'y',
            pointRadius: 3,
          },
          {
            label: `Tmin – ${nameB}`,
            data: tminB,
            borderColor: 'rgba(230,81,0,0.55)',
            backgroundColor: 'rgba(230,81,0,0.04)',
            tension: 0.4,
            yAxisID: 'y',
            borderDash: [4, 4],
            pointRadius: 3,
          },
          {
            type: 'bar',
            label: `Precip – ${nameA}`,
            data: precipA,
            backgroundColor: 'rgba(21,101,192,0.35)',
            borderColor: 'rgba(21,101,192,0.7)',
            borderWidth: 1,
            yAxisID: 'y1',
          } as any,
          {
            type: 'bar',
            label: `Precip – ${nameB}`,
            data: precipB,
            backgroundColor: 'rgba(230,81,0,0.35)',
            borderColor: 'rgba(230,81,0,0.7)',
            borderWidth: 1,
            yAxisID: 'y1',
          } as any,
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: {
            display: true,
            position: 'top',
            labels: { boxWidth: 12, font: { size: 11 } },
          },
          tooltip: {
            callbacks: {
              label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y?.toFixed(1)}`,
            },
          },
        },
        scales: {
          y: {
            title: { display: true, text: `Temperature (${tempUnit})` },
            position: 'left',
          },
          y1: {
            title: { display: true, text: `Precipitation (${precipLabel})` },
            position: 'right',
            grid: { drawOnChartArea: false },
          },
        },
      },
    };

    this.chart = new Chart(this._chartCanvas!.nativeElement, config);
  }

  private destroyChart(): void {
    if (this.chart) {
      this.chart.destroy();
      this.chart = null;
    }
  }

  // ─── View toggle ───────────────────────────────────────────────────────────

  toggleBottomBar(): void {
    this.showBottomBar = !this.showBottomBar;
  }

  switchView(mode: 'map' | 'globe'): void {
    if (this.viewMode === mode) return;
    this.viewMode = mode;
    this.cdr.detectChanges(); // flush template so *ngIf creates the container
    if (mode === 'globe') {
      // Wait until the container has been laid out (non-zero dimensions)
      // before passing it to Cesium — a zero-size canvas causes a DeveloperError.
      requestAnimationFrame(() => this.initGlobeWhenReady());
    } else {
      this.destroyGlobe();
      // leafletMapReady will fire automatically and re-place existing markers
    }
  }

  // ─── Cesium Globe ──────────────────────────────────────────────────────────
  /** Retry via rAF until the container has real pixel dimensions, then init. */
  private initGlobeWhenReady(retries = 30): void {
    const el = this.globeContainerRef?.nativeElement;
    if (!el) {
      // ViewChild not resolved yet — retry
      if (retries > 0) {
        this.cdr.detectChanges();
        requestAnimationFrame(() => this.initGlobeWhenReady(retries - 1));
      }
      return;
    }
    if (el.clientWidth > 0 && el.clientHeight > 0) {
      this.initGlobe();
    } else if (retries > 0) {
      requestAnimationFrame(() => this.initGlobeWhenReady(retries - 1));
    }
  }
  private initGlobe(): void {
    if (!this.globeContainerRef?.nativeElement) return;

    this.cesiumViewer = new Viewer(this.globeContainerRef.nativeElement, {
      terrainProvider: new EllipsoidTerrainProvider(),
      animation: false,
      baseLayerPicker: false,
      fullscreenButton: false,
      vrButton: false,
      geocoder: false,
      homeButton: false,
      infoBox: false,
      sceneModePicker: false,
      selectionIndicator: false,
      timeline: false,
      navigationHelpButton: false,
      navigationInstructionsInitiallyVisible: false,
      requestRenderMode: true,
      maximumRenderTimeChange: Infinity,
      sceneMode: SceneMode.SCENE3D,
    });

    (this.cesiumViewer.cesiumWidget.creditContainer as HTMLElement).style.display = 'none';
    this.cesiumViewer.scene.globe.enableLighting = false;
    this.cesiumViewer.scene.backgroundColor = Color.fromCssColorString('#1B2735');
    this.cesiumViewer.scene.globe.tileCacheSize = 100;
    this.cesiumViewer.scene.globe.maximumScreenSpaceError = 2;
    this.cesiumViewer.camera.setView({
      destination: Cartesian3.fromDegrees(10, 30, 20000000),
    });

    this.cesiumHandler = new ScreenSpaceEventHandler(this.cesiumViewer.scene.canvas);
    this.cesiumHandler.setInputAction(
      () => this.cesiumViewer?.scene.requestRender(),
      ScreenSpaceEventType.MOUSE_MOVE,
    );
    this.cesiumHandler.setInputAction(
      () => this.cesiumViewer?.scene.requestRender(),
      ScreenSpaceEventType.WHEEL,
    );
    this.cesiumHandler.setInputAction(
      () => this.cesiumViewer?.scene.requestRender(),
      ScreenSpaceEventType.LEFT_DOWN,
    );
    this.cesiumHandler.setInputAction(
      (e: { position: Cartesian2 }) => this.onGlobeClick(e.position),
      ScreenSpaceEventType.LEFT_CLICK,
    );

    // Re-add markers for already-chosen locations
    if (this.locationA) {
      this.placeGlobeMarker('A', this.locationA.lat, this.locationA.lon, this.locationA.cityName);
    }
    if (this.locationB) {
      this.placeGlobeMarker('B', this.locationB.lat, this.locationB.lon, this.locationB.cityName);
    }
  }

  private destroyGlobe(): void {
    this.cesiumHandler?.destroy();
    this.cesiumHandler = null;
    if (this.cesiumViewer && !this.cesiumViewer.isDestroyed()) {
      this.cesiumViewer.destroy();
    }
    this.cesiumViewer = null;
    this.cesiumEntityA = null;
    this.cesiumEntityB = null;
  }

  private onGlobeClick(screenPos: Cartesian2): void {
    if (!this.cesiumViewer) return;
    const ray = this.cesiumViewer.camera.getPickRay(screenPos);
    if (!ray) return;
    const cartesian = this.cesiumViewer.scene.globe.pick(ray, this.cesiumViewer.scene);
    if (!defined(cartesian) || !cartesian) return;
    const carto = Cartographic.fromCartesian(cartesian);
    const lat = CesiumMath.toDegrees(carto.latitude);
    const lon = CesiumMath.toDegrees(carto.longitude);
    if (this.activeMarker === 'A') {
      this.setLocationA(lat, lon, true);
    } else {
      this.setLocationB(lat, lon, true);
    }
  }

  private placeGlobeMarker(which: 'A' | 'B', lat: number, lon: number, cityName?: string): void {
    if (!this.cesiumViewer) return;
    const color =
      which === 'A'
        ? Color.fromCssColorString('#1565c0')
        : Color.fromCssColorString('#e65100');
    const labelText = cityName ? `${which}: ${cityName}` : `Location ${which}`;

    const entityOptions = {
      position: Cartesian3.fromDegrees(lon, lat),
      point: {
        pixelSize: 14,
        color,
        outlineColor: Color.WHITE,
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: {
        text: labelText,
        font: '700 12px sans-serif',
        fillColor: Color.WHITE,
        outlineColor: color,
        outlineWidth: 3,
        style: 2, // LabelStyle.FILL_AND_OUTLINE
        pixelOffset: new Cartesian2(0, -22),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        showBackground: true,
        backgroundColor: color.withAlpha(0.75),
        backgroundPadding: new Cartesian2(6, 4),
      },
    } as any;

    if (which === 'A') {
      if (this.cesiumEntityA) this.cesiumViewer.entities.remove(this.cesiumEntityA);
      this.cesiumEntityA = this.cesiumViewer.entities.add(entityOptions);
    } else {
      if (this.cesiumEntityB) this.cesiumViewer.entities.remove(this.cesiumEntityB);
      this.cesiumEntityB = this.cesiumViewer.entities.add(entityOptions);
    }
    this.cesiumViewer.scene.requestRender();
  }
}
