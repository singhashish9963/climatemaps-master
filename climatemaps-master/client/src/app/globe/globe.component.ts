import {
  Component,
  OnInit,
  OnDestroy,
  ElementRef,
  ViewChild,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  HostListener,
} from '@angular/core';
import { CommonModule, Location } from '@angular/common';
import { ActivatedRoute, ParamMap } from '@angular/router';
import { MatSidenavModule } from '@angular/material/sidenav';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';

import {
  Viewer,
  UrlTemplateImageryProvider,
  ImageryLayer,
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
  ConstantPositionProperty,
  PointGraphics,
  BoxGraphics,
  ColorMaterialProperty,
  EllipseGraphics,
  CallbackProperty,
} from 'cesium';

import { forkJoin, Observable } from 'rxjs';
import { map } from 'rxjs/operators';

import {
  ClimateMapService,
  ClimateValueResponse,
  ColorbarConfigResponse,
  NearestCityResponse,
} from '../core/climatemap.service';
import { GlobeBarService, BarRenderData } from './services/globe-bar.service';
import { MetadataService, YearRange, ClimateVariableConfig } from '../core/metadata.service';
import {
  ClimateVarKey,
  SpatialResolution,
  ClimateScenario,
  ClimateModel,
  CLIMATE_VAR_DISPLAY_NAMES,
} from '../utils/enum';
import {
  LayerBuilderService,
  LayerOption,
} from '../map/services/layer-builder.service';
import { LayerFilterService } from '../map/services/layer-filter.service';
import {
  MapControlsComponent,
  MapControlsData,
  MapControlsOptions,
} from '../map/controls/map-controls.component';
import { ColorbarJsonComponent } from '../map/colorbar-json.component';
import { GlobeLayerService } from './services/globe-layer.service';
import { ToastService } from '../core/toast.service';
import { ClimateVariableHelperService } from '../core/climate-variable-helper.service';
import { TemperatureUnitService, TemperatureUnit } from '../core/temperature-unit.service';
import { PrecipitationUnitService, PrecipitationUnit } from '../core/precipitation-unit.service';
import { TemperatureUtils } from '../utils/temperature-utils';
import { PrecipitationUtils } from '../utils/precipitation-utils';
import { CoordinateUtils } from '../utils/coordinate-utils';

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

@Component({
  selector: 'app-globe',
  standalone: true,
  imports: [
    CommonModule,
    MatSidenavModule,
    MatButtonModule,
    MatIconModule,
    MatProgressSpinnerModule,
    MapControlsComponent,
    ColorbarJsonComponent,
  ],
  templateUrl: './globe.component.html',
  styleUrl: './globe.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GlobeComponent implements OnInit, OnDestroy {
  @ViewChild('cesiumContainer', { static: true })
  cesiumContainer!: ElementRef<HTMLDivElement>;

  private viewer: Viewer | null = null;
  private climateLayer: ImageryLayer | null = null;
  private handler: ScreenSpaceEventHandler | null = null;

  controlsData: MapControlsData = {
    selectedVariableType: ClimateVarKey.T_MAX,
    selectedYearRange: null,
    selectedResolution: SpatialResolution.MIN10,
    selectedClimateScenario: null,
    selectedClimateModel: null,
    showDifferenceMap: true,
    showContourLines: false,
    selectedMonth: new Date().getMonth() + 1,
  };

  controlsOptions: MapControlsOptions | undefined;

  private layerOptions: LayerOption[] = [];
  private climateMaps: any[] = [];
  selectedOption: LayerOption | undefined;
  variableTypes: ClimateVarKey[] = [];
  yearRanges: YearRange[] = [];
  resolutions: SpatialResolution[] = [];
  climateScenarios: ClimateScenario[] = [];
  climateModels: ClimateModel[] = [];
  climateVariables: Record<ClimateVarKey, ClimateVariableConfig> = {} as Record<
    ClimateVarKey,
    ClimateVariableConfig
  >;
  isHistoricalYearRange!: (yearRange: readonly [number, number]) => boolean;

  sidebarOpened = false;
  isMobile = false;
  isLoading = true;
  private previousVariableType: ClimateVarKey | null = null;

  // Click-to-query state
  clickTooltip: {
    visible: boolean;
    lat: number;
    lon: number;
    value: string;
    unit: string;
    city: string;
    screenX: number;
    screenY: number;
  } | null = null;
  private clickMarker: Entity | null = null;
  private temperatureUnit = TemperatureUnit.CELSIUS;
  private precipitationUnit = PrecipitationUnit.MM;

  // 3D bar state
  private barEntities: Entity[] = [];
  isLoadingBars = false;
  barsVisible = false;
  private colorbarConfigCache: Map<string, ColorbarConfigResponse> = new Map();

  // Radar pulse animation state
  private radarEntity: Entity | null = null;
  private radarAnimationId: number | null = null;

  constructor(
    private climateMapService: ClimateMapService,
    private metadataService: MetadataService,
    private layerBuilder: LayerBuilderService,
    private layerFilter: LayerFilterService,
    private globeLayerService: GlobeLayerService,
    private globeBarService: GlobeBarService,
    private toastService: ToastService,
    private climateVariableHelper: ClimateVariableHelperService,
    private temperatureUnitService: TemperatureUnitService,
    private precipitationUnitService: PrecipitationUnitService,
    private cdr: ChangeDetectorRef,
    private route: ActivatedRoute,
    private location: Location,
  ) {
    this.isHistoricalYearRange =
      this.metadataService.isHistoricalYearRange.bind(this.metadataService);
  }

  ngOnInit(): void {
    this.checkMobile();
    this.initCesium();
    this.loadClimateData();

    this.temperatureUnitService.unit$.subscribe((u) => (this.temperatureUnit = u));
    this.precipitationUnitService.unit$.subscribe((u) => (this.precipitationUnit = u));
  }

  ngOnDestroy(): void {
    this.stopRadarPulse();
    this.handler?.destroy();
    if (this.viewer && !this.viewer.isDestroyed()) {
      this.viewer.destroy();
    }
  }

  @HostListener('window:resize')
  onResize(): void {
    this.checkMobile();
  }

  private checkMobile(): void {
    this.isMobile = window.innerWidth <= 768;
  }

  // ─── Cesium Initialization ───

  private initCesium(): void {
    this.viewer = new Viewer(this.cesiumContainer.nativeElement, {
      // Performance: use simple ellipsoid terrain (no elevation data)
      terrainProvider: new EllipsoidTerrainProvider(),
      // Disable all default UI widgets for clean look
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
      // Performance: request-render mode (only re-render on change)
      requestRenderMode: true,
      maximumRenderTimeChange: Infinity,
      // Start in 3D globe mode
      sceneMode: SceneMode.SCENE3D,
    });

    // Remove default Cesium credit display styling clutter
    (this.viewer.cesiumWidget.creditContainer as HTMLElement).style.display = 'none';

    // Set sky/atmosphere
    if (this.viewer.scene.skyAtmosphere) {
      this.viewer.scene.skyAtmosphere.show = true;
    }
    this.viewer.scene.globe.enableLighting = false;
    this.viewer.scene.backgroundColor = Color.fromCssColorString('#1B2735');

    // Performance: limit tile loading
    this.viewer.scene.globe.tileCacheSize = 100;
    this.viewer.scene.globe.maximumScreenSpaceError = 2;

    // Set initial camera to a nice global view
    this.viewer.camera.setView({
      destination: Cartesian3.fromDegrees(10, 30, 20000000),
    });

    // Enable render on camera change
    this.viewer.scene.requestRenderMode = true;
    this.viewer.scene.postRender.addEventListener(() => {
      // Keep rendering responsive during interaction
    });

    // Make scene request render on mouse interaction
    this.setupInteractionRendering();
  }

  private setupInteractionRendering(): void {
    if (!this.viewer) return;

    this.handler = new ScreenSpaceEventHandler(this.viewer.scene.canvas);

    // Request render on mouse movement for smooth interaction
    this.handler.setInputAction(() => {
      this.viewer?.scene.requestRender();
    }, ScreenSpaceEventType.MOUSE_MOVE);

    this.handler.setInputAction(() => {
      this.viewer?.scene.requestRender();
    }, ScreenSpaceEventType.WHEEL);

    this.handler.setInputAction(() => {
      this.viewer?.scene.requestRender();
    }, ScreenSpaceEventType.LEFT_DOWN);

    this.handler.setInputAction(() => {
      this.viewer?.scene.requestRender();
    }, ScreenSpaceEventType.LEFT_UP);

    // Click-to-query: pick globe position and fetch climate value
    this.handler.setInputAction(
      (event: { position: Cartesian2 }) => {
        this.onGlobeClick(event.position);
      },
      ScreenSpaceEventType.LEFT_CLICK,
    );
  }

  // ─── Click-to-Query ───

  private onGlobeClick(screenPos: Cartesian2): void {
    if (!this.viewer || !this.selectedOption?.metadata?.dataType) return;

    const ray = this.viewer.camera.getPickRay(screenPos);
    if (!ray) return;

    const cartesian = this.viewer.scene.globe.pick(ray, this.viewer.scene);
    if (!defined(cartesian) || !cartesian) return;

    const carto = Cartographic.fromCartesian(cartesian);
    const lat = CesiumMath.toDegrees(carto.latitude);
    const lon = CoordinateUtils.normalizeLongitude(
      CesiumMath.toDegrees(carto.longitude),
    );

    const dataType = this.selectedOption.metadata.dataType;
    const month = this.controlsData.selectedMonth;
    const variableType = this.controlsData.selectedVariableType;
    const cameraHeight = this.viewer.camera.positionCartographic.height;

    // Show loading tooltip
    this.clickTooltip = {
      visible: true,
      lat,
      lon,
      value: '...',
      unit: '',
      city: '',
      screenX: screenPos.x,
      screenY: screenPos.y,
    };
    this.placeClickMarker(lat, lon);
    this.cdr.markForCheck();

    // Fetch value, nearest city, and 3D bar data in parallel
    this.clearBars();
    this.isLoadingBars = true;
    this.startRadarPulse(lat, lon, cameraHeight);
    this.cdr.markForCheck();

    const grid = this.globeBarService.generateGrid(lat, lon, cameraHeight);

    forkJoin({
      climate: this.climateMapService.getClimateValue(dataType, month, lat, lon),
      city: this.climateMapService.getNearestCity(lat, lon),
      gridValues: this.globeBarService.fetchGridValues(grid, dataType, month),
      colorbar: this.getColorbarConfig(dataType),
    }).subscribe({
      next: ({ climate, city, gridValues, colorbar }) => {
        // Update tooltip
        const { displayValue, displayUnit } = this.formatClimateValue(
          climate,
          variableType,
        );
        const cityLabel =
          city.city_name && city.country_name
            ? `${city.city_name}, ${city.country_name}`
            : '';

        this.clickTooltip = {
          visible: true,
          lat,
          lon,
          value: displayValue,
          unit: displayUnit,
          city: cityLabel,
          screenX: screenPos.x,
          screenY: screenPos.y,
        };

        // Render 3D bars
        this.renderBars(gridValues, colorbar, cameraHeight);
        this.isLoadingBars = false;
        this.cdr.markForCheck();
      },
      error: () => {
        this.clickTooltip = {
          visible: true,
          lat,
          lon,
          value: 'N/A',
          unit: '',
          city: '',
          screenX: screenPos.x,
          screenY: screenPos.y,
        };
        this.isLoadingBars = false;
        this.cdr.markForCheck();
      },
    });
  }

  private formatClimateValue(
    resp: ClimateValueResponse,
    variableType: ClimateVarKey,
  ): { displayValue: string; displayUnit: string } {
    let val = resp.value;
    let unit = resp.unit;

    if (TemperatureUtils.isTemperatureVariable(variableType)) {
      if (this.temperatureUnit === TemperatureUnit.FAHRENHEIT) {
        val = TemperatureUtils.celsiusToFahrenheit(val);
        unit = TemperatureUnit.FAHRENHEIT;
      } else {
        unit = TemperatureUnit.CELSIUS;
      }
    } else if (PrecipitationUtils.isPrecipitationVariable(variableType)) {
      if (this.precipitationUnit === PrecipitationUnit.INCHES) {
        val = PrecipitationUtils.mmToInches(val);
        unit = 'in/month';
      }
    }

    return { displayValue: val.toFixed(1), displayUnit: unit };
  }

  private placeClickMarker(lat: number, lon: number): void {
    if (!this.viewer) return;

    // Remove previous marker
    if (this.clickMarker) {
      this.viewer.entities.remove(this.clickMarker);
    }

    this.clickMarker = this.viewer.entities.add({
      position: Cartesian3.fromDegrees(lon, lat),
      point: new PointGraphics({
        pixelSize: 8,
        color: Color.BLACK,
        outlineColor: Color.WHITE,
        outlineWidth: 2,
      }),
    });

    this.viewer.scene.requestRender();
  }

  dismissTooltip(): void {
    this.clickTooltip = null;
    if (this.clickMarker && this.viewer) {
      this.viewer.entities.remove(this.clickMarker);
      this.clickMarker = null;
      this.viewer.scene.requestRender();
    }
    this.clearBars();
    this.cdr.markForCheck();
  }

  // ─── 3D Bar Rendering ───

  private getColorbarConfig(
    dataType: string,
  ): Observable<ColorbarConfigResponse> {
    const cached = this.colorbarConfigCache.get(dataType);
    if (cached) {
      return new Observable((subscriber) => {
        subscriber.next(cached);
        subscriber.complete();
      });
    }
    return this.climateMapService.getColorbarConfig(dataType).pipe(
      map((config: ColorbarConfigResponse) => {
        this.colorbarConfigCache.set(dataType, config);
        return config;
      }),
    );
  }

  private renderBars(
    samples: { lat: number; lon: number; value: number }[],
    colorbar: ColorbarConfigResponse,
    cameraHeight: number,
  ): void {
    this.stopRadarPulse();

    if (!this.viewer || samples.length === 0) return;

    const barData = this.globeBarService.buildBarData(samples, colorbar);
    const cellSize = this.globeBarService.getCellSizeDeg(cameraHeight);

    // Bar cross-section size in meters (rectangular)
    const barSideMeters = cellSize * 0.8 * 111000; // ~111km per degree, slightly smaller for gaps

    for (const bar of barData) {
      const heightMeters = this.globeBarService.getBarHeightMeters(
        bar.normalizedHeight,
      );

      // Position the box center at half-height above the surface
      const position = Cartesian3.fromDegrees(
        bar.lon,
        bar.lat,
        heightMeters / 2,
      );

      const entity = this.viewer.entities.add({
        position,
        box: new BoxGraphics({
          dimensions: new Cartesian3(barSideMeters, barSideMeters, heightMeters),
          material: new ColorMaterialProperty(
            Color.fromBytes(bar.color[0], bar.color[1], bar.color[2], 190),
          ),
          outline: true,
          outlineColor: Color.fromBytes(
            bar.color[0],
            bar.color[1],
            bar.color[2],
            255,
          ),
          outlineWidth: 1,
        }),
      });

      this.barEntities.push(entity);
    }

    this.barsVisible = true;
    this.viewer.scene.requestRender();
  }

  clearBars(): void {
    if (!this.viewer) return;
    this.stopRadarPulse();
    for (const entity of this.barEntities) {
      this.viewer.entities.remove(entity);
    }
    this.barEntities = [];
    this.barsVisible = false;
    this.viewer.scene.requestRender();
  }

  // ─── Radar Pulse Animation ───

  private startRadarPulse(lat: number, lon: number, cameraHeight: number): void {
    this.stopRadarPulse();
    if (!this.viewer) return;

    const spacing = this.globeBarService.getCellSizeDeg(cameraHeight);
    // Max radius covers the full 5×5 grid extent
    const maxRadiusMeters = spacing * 3 * 111000;
    const cycleDuration = 1500; // ms for one pulse cycle
    const startTime = performance.now();

    // Expanding ring with fading alpha
    let currentRadius = 0;
    let currentAlpha = 180;

    this.radarEntity = this.viewer.entities.add({
      position: Cartesian3.fromDegrees(lon, lat),
      ellipse: new EllipseGraphics({
        semiMajorAxis: new CallbackProperty(() => currentRadius, false),
        semiMinorAxis: new CallbackProperty(() => currentRadius, false),
        material: new ColorMaterialProperty(
          new CallbackProperty(
            () => Color.fromBytes(0, 200, 255, currentAlpha),
            false,
          ),
        ),
        outline: true,
        outlineColor: new CallbackProperty(
          () => Color.fromBytes(0, 200, 255, Math.min(currentAlpha + 60, 255)),
          false,
        ),
        outlineWidth: 2,
        height: 100, // slightly above surface
      }),
    });

    const animate = () => {
      const elapsed = performance.now() - startTime;
      const phase = (elapsed % cycleDuration) / cycleDuration; // 0→1 repeating

      // Ease-out expansion
      currentRadius = maxRadiusMeters * phase;
      // Fade out as ring expands
      currentAlpha = Math.round(180 * (1 - phase));

      this.viewer?.scene.requestRender();
      this.radarAnimationId = requestAnimationFrame(animate);
    };

    this.radarAnimationId = requestAnimationFrame(animate);
  }

  private stopRadarPulse(): void {
    if (this.radarAnimationId !== null) {
      cancelAnimationFrame(this.radarAnimationId);
      this.radarAnimationId = null;
    }
    if (this.radarEntity && this.viewer) {
      this.viewer.entities.remove(this.radarEntity);
      this.radarEntity = null;
      this.viewer.scene.requestRender();
    }
  }

  // ─── Zoom Controls ───

  zoomIn(): void {
    if (!this.viewer) return;
    const camera = this.viewer.camera;
    const carto = camera.positionCartographic;
    const newHeight = Math.max(carto.height * 0.5, 100);
    camera.flyTo({
      destination: Cartesian3.fromRadians(
        carto.longitude,
        carto.latitude,
        newHeight,
      ),
      duration: 0.5,
      complete: () => this.viewer?.scene.requestRender(),
    });
  }

  zoomOut(): void {
    if (!this.viewer) return;
    const camera = this.viewer.camera;
    const carto = camera.positionCartographic;
    const newHeight = Math.min(carto.height * 2, 40000000);
    camera.flyTo({
      destination: Cartesian3.fromRadians(
        carto.longitude,
        carto.latitude,
        newHeight,
      ),
      duration: 0.5,
      complete: () => this.viewer?.scene.requestRender(),
    });
  }

  resetView(): void {
    this.viewer?.camera.flyTo({
      destination: Cartesian3.fromDegrees(10, 30, 20000000),
      duration: 1.0,
      complete: () => this.viewer?.scene.requestRender(),
    });
  }

  // ─── Data Loading ───

  private loadClimateData(): void {
    this.climateMapService.getClimateMapList().subscribe({
      next: (climateMaps) => {
        this.climateMaps = climateMaps;
        this.populateMetadata(climateMaps);
        this.layerOptions = this.layerBuilder.buildLayerOptions(climateMaps);

        this.resetInvalidSelections();

        this.route.queryParamMap.subscribe((params) => {
          this.updateControlsFromURL(params);
        });

        this.findMatchingLayer();
        this.updateGlobeLayer();

        this.isLoading = false;
        this.cdr.markForCheck();
      },
      error: (error) => {
        console.error('Failed to load climate maps:', error);
        this.toastService.showError(
          'Failed to load climate data. Please try again.',
          10000,
        );
        this.isLoading = false;
        this.cdr.markForCheck();
      },
    });
  }

  private populateMetadata(climateMaps: any[]): void {
    this.climateVariables =
      this.metadataService.getClimateVariables(climateMaps);
    this.yearRanges = this.metadataService.getYearRanges(climateMaps);
    this.resolutions = this.metadataService.getResolutions(climateMaps);
    this.climateScenarios =
      this.metadataService.getClimateScenarios(climateMaps);
    this.climateModels = this.metadataService.getClimateModels(climateMaps);
    this.variableTypes = this.metadataService.getSortedVariableTypes(
      this.climateVariables,
    );

    if (!this.controlsData.selectedYearRange && this.yearRanges.length > 0) {
      this.controlsData.selectedYearRange = this.yearRanges[0];
    }

    this.controlsOptions = {
      variableTypes: this.variableTypes,
      yearRanges: this.yearRanges,
      resolutions: this.resolutions,
      climateScenarios: this.climateScenarios,
      climateModels: this.climateModels,
      climateVariables: this.climateVariables,
      availableVariableTypes: this.getAvailableVariableTypes(),
      availableYearRanges: this.getAvailableYearRanges(),
      availableResolutions: this.getAvailableResolutions(),
      availableClimateScenarios: this.getAvailableClimateScenarios(),
      availableClimateModels: this.getAvailableClimateModels(),
      isHistoricalYearRange: this.isHistoricalYearRange,
    };
  }

  // ─── Layer Management ───

  private findMatchingLayer(): void {
    const matchingLayer = this.findMatchingLayerOption();
    if (matchingLayer) {
      this.selectedOption = matchingLayer;
    } else {
      this.selectedOption = undefined;
      this.removeClimateLayer();
    }
  }

  private findMatchingLayerOption(): LayerOption | undefined {
    const yearRange = this.controlsData.selectedYearRange;
    if (!yearRange) return undefined;

    return this.layerOptions.find((option) => {
      if (!option.metadata) return false;
      const m = option.metadata;

      const expectedName =
        this.climateVariables[this.controlsData.selectedVariableType]?.name;
      if (m.variableType !== expectedName) return false;

      const matchesPrimary =
        m.yearRange[0] === yearRange.value[0] &&
        m.yearRange[1] === yearRange.value[1];
      const matchesAdditional = yearRange.additionalValues?.some(
        (av) => m.yearRange[0] === av[0] && m.yearRange[1] === av[1],
      );
      if (!matchesPrimary && !matchesAdditional) return false;

      if (m.resolution !== this.controlsData.selectedResolution) return false;

      if (!this.isHistoricalYearRange(yearRange.value)) {
        if (m.isDifferenceMap !== this.controlsData.showDifferenceMap)
          return false;
        if (
          this.controlsData.selectedClimateScenario &&
          m.climateScenario !== this.controlsData.selectedClimateScenario
        )
          return false;
        if (
          this.controlsData.selectedClimateModel &&
          m.climateModel !== this.controlsData.selectedClimateModel
        )
          return false;
      } else {
        if (m.climateScenario || m.climateModel) return false;
        if (m.isDifferenceMap) return false;
      }

      return true;
    });
  }

  private updateGlobeLayer(): void {
    this.removeClimateLayer();

    if (!this.selectedOption || !this.viewer) return;

    const config = this.globeLayerService.buildLayerConfig(
      this.selectedOption,
      this.controlsData.selectedMonth,
    );

    const provider = new UrlTemplateImageryProvider({
      url: config.tileUrl,
      minimumLevel: 0,
      maximumLevel: config.maxZoom,
    });

    this.climateLayer = this.viewer.imageryLayers.addImageryProvider(provider);
    this.climateLayer.alpha = config.opacity;

    this.viewer.scene.requestRender();
  }

  private removeClimateLayer(): void {
    if (this.climateLayer && this.viewer) {
      this.viewer.imageryLayers.remove(this.climateLayer, true);
      this.climateLayer = null;
      this.viewer.scene.requestRender();
    }
  }

  // ─── Controls Event Handlers ───

  onControlsChange(newControlsData: MapControlsData): void {
    this.controlsData = { ...newControlsData };
    this.setDefaultFutureSelections();
    this.resetInvalidSelections();
    this.checkAndShowFuturePredictionWarning();
    this.findMatchingLayer();
    this.updateGlobeLayer();
    this.updateControlsOptions();
    this.cdr.markForCheck();
  }

  private setDefaultFutureSelections(): void {
    if (
      this.controlsData.selectedYearRange &&
      !this.isHistoricalYearRange(this.controlsData.selectedYearRange.value)
    ) {
      if (!this.controlsData.selectedClimateScenario) {
        this.controlsData.selectedClimateScenario = ClimateScenario.SSP370;
      }
      if (!this.controlsData.selectedClimateModel) {
        this.controlsData.selectedClimateModel = ClimateModel.ENSEMBLE_MEAN;
      }
    }
  }

  private checkAndShowFuturePredictionWarning(): void {
    const currentVariableType = this.controlsData.selectedVariableType;
    if (
      this.previousVariableType !== null &&
      this.previousVariableType !== currentVariableType
    ) {
      if (
        !this.climateVariableHelper.hasFuturePredictions(currentVariableType)
      ) {
        const displayName =
          this.climateVariables[currentVariableType]?.displayName ||
          currentVariableType;
        this.toastService.showInfo(
          `No future predictions available for ${displayName}`,
          6000,
        );
      }
    }
    this.previousVariableType = currentVariableType;
  }

  // ─── Availability Filters (reuse LayerFilterService) ───

  private getAvailableVariableTypes(): ClimateVarKey[] {
    return this.layerFilter.getAvailableVariableTypes(
      this.climateMaps,
      this.variableTypes,
      this.climateVariables,
    );
  }

  private getAvailableYearRanges(): YearRange[] {
    return this.layerFilter.getAvailableYearRanges(
      this.climateMaps,
      this.yearRanges,
      this.controlsData,
      this.climateVariables,
    );
  }

  private getAvailableResolutions(): SpatialResolution[] {
    return this.layerFilter.getAvailableResolutions(
      this.climateMaps,
      this.resolutions,
      this.controlsData,
      this.climateVariables,
      this.isHistoricalYearRange,
    );
  }

  private getAvailableClimateScenarios(): ClimateScenario[] {
    return this.layerFilter.getAvailableClimateScenarios(
      this.climateMaps,
      this.climateScenarios,
      this.controlsData,
      this.climateVariables,
      this.isHistoricalYearRange,
    );
  }

  private getAvailableClimateModels(): ClimateModel[] {
    return this.layerFilter.getAvailableClimateModels(
      this.climateMaps,
      this.climateModels,
      this.controlsData,
      this.climateVariables,
      this.isHistoricalYearRange,
    );
  }

  private resetInvalidSelections(): void {
    const availableYearRanges = this.getAvailableYearRanges();
    const availableResolutions = this.getAvailableResolutions();
    const availableScenarios = this.getAvailableClimateScenarios();
    const availableModels = this.getAvailableClimateModels();

    if (
      this.controlsData.selectedYearRange &&
      !availableYearRanges.some(
        (yr) =>
          yr.value[0] === this.controlsData.selectedYearRange!.value[0] &&
          yr.value[1] === this.controlsData.selectedYearRange!.value[1],
      )
    ) {
      this.controlsData.selectedYearRange = availableYearRanges[0] || null;
    }

    if (!availableResolutions.includes(this.controlsData.selectedResolution)) {
      this.controlsData.selectedResolution =
        availableResolutions[0] || SpatialResolution.MIN10;
    }

    const isFuture =
      this.controlsData.selectedYearRange &&
      !this.isHistoricalYearRange(this.controlsData.selectedYearRange.value);

    if (isFuture) {
      if (
        this.controlsData.selectedClimateScenario &&
        !availableScenarios.includes(
          this.controlsData.selectedClimateScenario,
        )
      ) {
        this.controlsData.selectedClimateScenario =
          availableScenarios[0] || null;
      }
      if (
        this.controlsData.selectedClimateModel &&
        !availableModels.includes(this.controlsData.selectedClimateModel)
      ) {
        this.controlsData.selectedClimateModel = availableModels[0] || null;
      }
    }
  }

  private updateControlsOptions(): void {
    if (!this.controlsOptions) return;
    this.controlsOptions = {
      ...this.controlsOptions,
      availableVariableTypes: this.getAvailableVariableTypes(),
      availableYearRanges: this.getAvailableYearRanges(),
      availableResolutions: this.getAvailableResolutions(),
      availableClimateScenarios: this.getAvailableClimateScenarios(),
      availableClimateModels: this.getAvailableClimateModels(),
    };
  }

  private updateControlsFromURL(params: ParamMap): void {
    if (this.climateMaps.length === 0) return;

    const variable = params.get('variable') as ClimateVarKey;
    if (variable && this.variableTypes.includes(variable)) {
      this.controlsData.selectedVariableType = variable;
    }

    const month = params.get('month');
    if (month) {
      const m = parseInt(month, 10);
      if (m >= 1 && m <= 12) {
        this.controlsData.selectedMonth = m;
      }
    }

    this.findMatchingLayer();
    this.updateGlobeLayer();
    this.cdr.markForCheck();
  }

  // ─── View Helpers ───

  toggleSidebar(): void {
    this.sidebarOpened = !this.sidebarOpened;
  }

  getMonthName(month: number): string {
    return MONTHS[month - 1] || '';
  }

  formatYearRange(range: [number, number]): string {
    return `${range[0]}-${range[1]}`;
  }

  shouldShowFutureControls(): boolean {
    return !!(
      this.controlsData.selectedYearRange &&
      !this.isHistoricalYearRange(this.controlsData.selectedYearRange.value)
    );
  }

  flyTo(lon: number, lat: number, height = 5000000): void {
    this.viewer?.camera.flyTo({
      destination: Cartesian3.fromDegrees(lon, lat, height),
      duration: 1.5,
      complete: () => {
        this.viewer?.scene.requestRender();
      },
    });
  }
}
