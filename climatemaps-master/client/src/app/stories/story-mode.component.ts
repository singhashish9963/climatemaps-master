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
import { MatButtonToggleModule } from '@angular/material/button-toggle';
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

import {
  Viewer,
  UrlTemplateImageryProvider,
  ImageryLayer,
  Cartesian3,
  SceneMode,
  Color,
  EllipsoidTerrainProvider,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  Math as CesiumMath,
} from 'cesium';

import { ClimateMapService, ClimateValueResponse, NearestCityResponse } from '../core/climatemap.service';
import { ClimateMap } from '../core/climatemap';
import { MetadataService, YearRange } from '../core/metadata.service';
import { LayerBuilderService, LayerOption } from '../map/services/layer-builder.service';
import { GlobeLayerService } from '../globe/services/globe-layer.service';
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
    MatButtonToggleModule,
    MatIconModule,
    MatCardModule,
    MatSlideToggleModule,
    LeafletModule,
  ],
  templateUrl: './story-mode.component.html',
  styleUrl: './story-mode.component.scss',
})
export class StoryModeComponent implements OnInit, OnDestroy {
  @ViewChild('cesiumContainer') cesiumContainer!: ElementRef<HTMLDivElement>;

  stories = CLIMATE_STORIES;
  selectedIndex = 0;
  autoPlay = false;
  isMobile = false;
  viewMode: 'map' | 'globe' = 'map';

  // Leaflet map state
  private map: Map | null = null;
  private rasterLayer: Layer | null = null;
  private baseLayer = tileLayer(
    'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    { maxZoom: 20, attribution: '&copy; OpenStreetMap' },
  );
  mapOptions: any;

  // Cesium globe state
  private viewer: Viewer | null = null;
  private climateLayer: ImageryLayer | null = null;
  private cesiumHandler: ScreenSpaceEventHandler | null = null;

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
    private globeLayerService: GlobeLayerService,
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
      title: 'Climate Stories - Guided Climate Tour | ClimateGO',
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
    this.destroyCesium();
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

  switchViewMode(mode: 'map' | 'globe'): void {
    if (mode === this.viewMode) return;
    this.viewMode = mode;

    if (mode === 'globe') {
      // Destroy Leaflet raster layer reference (the div will be hidden)
      if (this.rasterLayer && this.map) {
        this.map.removeLayer(this.rasterLayer);
        this.rasterLayer = null;
      }
      // Init Cesium after the DOM element is rendered
      setTimeout(() => {
        this.initCesium();
        const story = this.selectedStory;
        this.updateGlobeLayer(story);
        this.flyToStoryGlobe(story);
      }, 0);
    } else {
      this.destroyCesium();
      // Re-invalidate the leaflet map after it becomes visible
      setTimeout(() => {
        this.map?.invalidateSize();
        const story = this.selectedStory;
        this.flyToStory(story);
        this.updateMapLayer(story);
      }, 0);
    }
  }

  getMonthName(month: number): string {
    return MONTH_NAMES[month - 1] || '';
  }

  getVariableDisplayName(variable: ClimateVarKey): string {
    return CLIMATE_VAR_DISPLAY_NAMES[variable] || variable;
  }

  // ---- private helpers ----

  private flyToStory(story: ClimateStory): void {
    if (this.viewMode === 'globe') {
      this.flyToStoryGlobe(story);
      return;
    }
    if (!this.map) return;
    this.map.flyTo([story.lat, story.lon], story.zoom, {
      animate: true,
      duration: 1.5,
    });
  }

  private flyToStoryGlobe(story: ClimateStory): void {
    if (!this.viewer) return;
    const targetAltitude = 40000000 / Math.pow(2, story.zoom);

    // First zoom out to a high-altitude global view, then zoom into the target
    this.viewer.camera.flyTo({
      destination: Cartesian3.fromDegrees(
        CesiumMath.toDegrees(this.viewer.camera.positionCartographic.longitude),
        CesiumMath.toDegrees(this.viewer.camera.positionCartographic.latitude),
        18000000,
      ),
      duration: 1.0,
      complete: () => {
        this.viewer?.scene.requestRender();
        // Then fly down to the story location
        this.viewer?.camera.flyTo({
          destination: Cartesian3.fromDegrees(story.lon, story.lat, targetAltitude),
          duration: 1.5,
          complete: () => this.viewer?.scene.requestRender(),
        });
      },
    });
  }

  private updateMapLayer(story: ClimateStory): void {
    if (this.viewMode === 'globe') {
      this.updateGlobeLayer(story);
      return;
    }

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

  private updateGlobeLayer(story: ClimateStory): void {
    this.removeGlobeClimateLayer();
    const option = this.findLayerForStory(story);
    if (!option || !this.viewer) return;

    const config = this.globeLayerService.buildLayerConfig(option, story.month);
    const provider = new UrlTemplateImageryProvider({
      url: config.tileUrl,
      minimumLevel: 0,
      maximumLevel: config.maxZoom,
    });
    this.climateLayer = this.viewer.imageryLayers.addImageryProvider(provider);
    this.climateLayer.alpha = config.opacity;
    this.viewer.scene.requestRender();
  }

  private removeGlobeClimateLayer(): void {
    if (this.climateLayer && this.viewer) {
      this.viewer.imageryLayers.remove(this.climateLayer, true);
      this.climateLayer = null;
      this.viewer?.scene.requestRender();
    }
  }

  private initCesium(): void {
    if (!this.cesiumContainer?.nativeElement) return;
    this.viewer = new Viewer(this.cesiumContainer.nativeElement, {
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

    (this.viewer.cesiumWidget.creditContainer as HTMLElement).style.display = 'none';
    if (this.viewer.scene.skyAtmosphere) {
      this.viewer.scene.skyAtmosphere.show = true;
    }
    this.viewer.scene.globe.enableLighting = false;
    this.viewer.scene.backgroundColor = Color.fromCssColorString('#1B2735');
    this.viewer.scene.globe.tileCacheSize = 100;
    this.viewer.scene.globe.maximumScreenSpaceError = 2;

    this.cesiumHandler = new ScreenSpaceEventHandler(this.viewer.scene.canvas);
    this.cesiumHandler.setInputAction(() => {
      this.viewer?.scene.requestRender();
    }, ScreenSpaceEventType.MOUSE_MOVE);
    this.cesiumHandler.setInputAction(() => {
      this.viewer?.scene.requestRender();
    }, ScreenSpaceEventType.WHEEL);
    this.cesiumHandler.setInputAction(() => {
      this.viewer?.scene.requestRender();
    }, ScreenSpaceEventType.LEFT_DOWN);
    this.cesiumHandler.setInputAction(() => {
      this.viewer?.scene.requestRender();
    }, ScreenSpaceEventType.LEFT_UP);
  }

  private destroyCesium(): void {
    this.removeGlobeClimateLayer();
    this.cesiumHandler?.destroy();
    this.cesiumHandler = null;
    if (this.viewer && !this.viewer.isDestroyed()) {
      this.viewer.destroy();
    }
    this.viewer = null;
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
