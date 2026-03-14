import {
  Component,
  OnInit,
  OnDestroy,
  ViewChild,
  ElementRef,
  HostListener,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatCardModule } from '@angular/material/card';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { FormsModule } from '@angular/forms';
import { LeafletModule } from '@bluehalo/ngx-leaflet';
import {
  Control,
  latLng,
  Layer,
  Map,
  tileLayer,
} from 'leaflet';
import 'leaflet.vectorgrid';
import { forkJoin, Subscription } from 'rxjs';

import { ClimateMapService, ClimateValueResponse, NearestCityResponse } from '../core/climatemap.service';
import { ClimateMap } from '../core/climatemap';
import { MetadataService, YearRange } from '../core/metadata.service';
import { LayerBuilderService, LayerOption } from '../map/services/layer-builder.service';
import { SeoService } from '../core/seo.service';
import { TemperatureUnitService, TemperatureUnit } from '../core/temperature-unit.service';
import { TemperatureUtils } from '../utils/temperature-utils';
import { PrecipitationUnitService } from '../core/precipitation-unit.service';
import {
  ClimateVarKey,
  CLIMATE_VAR_KEY_TO_NAME,
  CLIMATE_VAR_DISPLAY_NAMES,
  CLIMATE_VAR_UNITS,
  SpatialResolution,
} from '../utils/enum';

import { CLIMATE_STORIES, ClimateStory } from './climate-stories';

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

@Component({
  selector: 'app-story-mode',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatButtonModule,
    MatIconModule,
    MatCardModule,
    MatSlideToggleModule,
    LeafletModule,
  ],
  templateUrl: './story-mode.component.html',
  styleUrl: './story-mode.component.scss',
})
export class StoryModeComponent implements OnInit, OnDestroy {
  stories = CLIMATE_STORIES;
  selectedIndex = 0;
  autoPlay = false;
  isMobile = false;

  // Map state
  private map: Map | null = null;
  private rasterLayer: Layer | null = null;
  private baseLayer = tileLayer(
    'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    { maxZoom: 20, attribution: '&copy; OpenStreetMap' },
  );
  mapOptions: any;

  // Data loaded from API
  private climateMaps: ClimateMap[] = [];
  private layerOptions: LayerOption[] = [];
  private yearRanges: YearRange[] = [];
  private climateVariables: Record<ClimateVarKey, { name: string; displayName: string }> =
    {} as any;

  // Info card data
  climateValue: number | null = null;
  nearestCity: NearestCityResponse | null = null;
  isLoading = false;
  valueUnit = '';

  // Auto-play
  private autoPlayInterval: ReturnType<typeof setInterval> | null = null;
  private subscriptions: Subscription[] = [];

  // Unit state
  private temperatureUnit: TemperatureUnit = TemperatureUnit.CELSIUS;

  constructor(
    private climateMapService: ClimateMapService,
    private metadataService: MetadataService,
    private layerBuilder: LayerBuilderService,
    private seoService: SeoService,
    private temperatureUnitService: TemperatureUnitService,
    private precipitationUnitService: PrecipitationUnitService,
  ) {
    this.mapOptions = {
      layers: [this.baseLayer],
      zoom: 3,
      center: latLng(20, 5),
      zoomControl: false,
    };
  }

  ngOnInit(): void {
    this.checkMobile();
    this.seoService.updateMetaTags({
      title: 'Climate Stories - Guided Climate Tour | OpenClimateMap',
      description:
        'Explore major climate events through an interactive guided tour. ' +
        'From the 2003 European heatwave to Arctic ice loss and Amazon droughts.',
      keywords: 'climate stories, climate tour, heatwave, drought, Arctic ice, climate events',
      url: '/stories',
    });

    this.subscriptions.push(
      this.temperatureUnitService.unit$.subscribe((unit) => {
        this.temperatureUnit = unit;
        if (this.climateValue !== null) {
          this.formatDisplayValue();
        }
      }),
    );

    this.climateMapService.getClimateMapList().subscribe({
      next: (maps) => {
        this.climateMaps = maps;
        this.climateVariables = this.metadataService.getClimateVariables(maps);
        this.yearRanges = this.metadataService.getYearRanges(maps);
        this.layerOptions = this.layerBuilder.buildLayerOptions(maps);
        this.selectStory(0);
      },
    });
  }

  ngOnDestroy(): void {
    this.stopAutoPlay();
    this.subscriptions.forEach((s) => s.unsubscribe());
  }

  @HostListener('window:resize')
  onResize(): void {
    this.checkMobile();
  }

  private checkMobile(): void {
    this.isMobile = window.innerWidth <= 768;
  }

  get selectedStory(): ClimateStory {
    return this.stories[this.selectedIndex];
  }

  selectStory(index: number): void {
    this.selectedIndex = index;
    const story = this.selectedStory;
    this.flyToStory(story);
    this.updateMapLayer(story);
    this.fetchStoryData(story);
  }

  nextStory(): void {
    const next = (this.selectedIndex + 1) % this.stories.length;
    this.selectStory(next);
  }

  prevStory(): void {
    const prev = (this.selectedIndex - 1 + this.stories.length) % this.stories.length;
    this.selectStory(prev);
  }

  toggleAutoPlay(): void {
    this.autoPlay = !this.autoPlay;
    if (this.autoPlay) {
      this.startAutoPlay();
    } else {
      this.stopAutoPlay();
    }
  }

  onMapReady(map: Map): void {
    this.map = map;
    new Control.Zoom({ position: 'topleft' }).addTo(map);
    setTimeout(() => map.invalidateSize(), 0);
  }

  getMonthName(month: number): string {
    return MONTH_NAMES[month - 1] || '';
  }

  getVariableDisplayName(variable: ClimateVarKey): string {
    return CLIMATE_VAR_DISPLAY_NAMES[variable] || variable;
  }

  // ---- private helpers ----

  private flyToStory(story: ClimateStory): void {
    if (!this.map) return;
    this.map.flyTo([story.lat, story.lon], story.zoom, {
      animate: true,
      duration: 1.5,
    });
  }

  private updateMapLayer(story: ClimateStory): void {
    if (this.rasterLayer && this.map) {
      this.map.removeLayer(this.rasterLayer);
      this.rasterLayer = null;
    }

    const option = this.findLayerForStory(story);
    if (!option || !this.map) return;

    this.rasterLayer = tileLayer(
      `${option.rasterUrl}_${story.month}/{z}/{x}/{y}.png`,
      {
        minZoom: 0,
        maxNativeZoom: option.rasterMaxZoom,
        maxZoom: 12,
        tileSize: 256,
        opacity: 0.8,
        crossOrigin: 'anonymous',
      },
    );
    this.map.addLayer(this.rasterLayer);
  }

  private findLayerForStory(story: ClimateStory): LayerOption | undefined {
    const expectedName = CLIMATE_VAR_KEY_TO_NAME[story.variable];
    const historicalRange = this.yearRanges.find((yr) =>
      this.metadataService.isHistoricalYearRange(yr.value),
    );
    if (!historicalRange) return undefined;

    return this.layerOptions.find((opt) => {
      if (!opt.metadata) return false;
      const m = opt.metadata;
      return (
        m.variableType === expectedName &&
        m.resolution === SpatialResolution.MIN10 &&
        m.yearRange[0] === historicalRange.value[0] &&
        m.yearRange[1] === historicalRange.value[1] &&
        !m.climateScenario &&
        !m.climateModel &&
        !m.isDifferenceMap
      );
    });
  }

  private rawValue: number | null = null;
  displayValue = '';

  private fetchStoryData(story: ClimateStory): void {
    this.isLoading = true;
    this.climateValue = null;
    this.nearestCity = null;
    this.displayValue = '';

    const option = this.findLayerForStory(story);
    if (!option?.metadata?.dataType) {
      this.isLoading = false;
      return;
    }

    const value$ = this.climateMapService.getClimateValue(
      option.metadata.dataType,
      story.month,
      story.lat,
      story.lon,
    );
    const city$ = this.climateMapService.getNearestCity(story.lat, story.lon);

    forkJoin({ value: value$, city: city$ }).subscribe({
      next: ({ value, city }) => {
        this.rawValue = value.value;
        this.climateValue = value.value;
        this.valueUnit = value.unit;
        this.nearestCity = city;
        this.formatDisplayValue();
        this.isLoading = false;
      },
      error: () => {
        this.isLoading = false;
      },
    });
  }

  private formatDisplayValue(): void {
    if (this.rawValue === null) return;
    const story = this.selectedStory;
    if (
      story.variable === ClimateVarKey.T_MAX ||
      story.variable === ClimateVarKey.T_MIN
    ) {
      const converted =
        this.temperatureUnit === TemperatureUnit.FAHRENHEIT
          ? TemperatureUtils.celsiusToFahrenheit(this.rawValue)
          : this.rawValue;
      const unit = this.temperatureUnit === TemperatureUnit.FAHRENHEIT ? '°F' : '°C';
      this.displayValue = `${converted.toFixed(1)} ${unit}`;
    } else if (story.variable === ClimateVarKey.PRECIPITATION) {
      const converted = this.precipitationUnitService.convertPrecipitation(this.rawValue);
      const unitLabel = this.precipitationUnitService.getUnit() === 'in' ? 'in/month' : 'mm/month';
      this.displayValue = `${converted.toFixed(1)} ${unitLabel}`;
    } else {
      this.displayValue = `${this.rawValue.toFixed(1)} ${this.valueUnit}`;
    }
  }

  private startAutoPlay(): void {
    this.stopAutoPlay();
    this.autoPlayInterval = setInterval(() => {
      this.nextStory();
    }, 8000);
  }

  private stopAutoPlay(): void {
    if (this.autoPlayInterval) {
      clearInterval(this.autoPlayInterval);
      this.autoPlayInterval = null;
    }
  }

  @HostListener('window:keydown', ['$event'])
  onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'ArrowRight') {
      this.nextStory();
    } else if (event.key === 'ArrowLeft') {
      this.prevStory();
    }
  }
}
