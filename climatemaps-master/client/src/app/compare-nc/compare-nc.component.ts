import {
  Component,
  OnInit,
  OnDestroy,
  ViewChild,
  ElementRef,
  HostListener,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSelectModule } from '@angular/material/select';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSliderModule } from '@angular/material/slider';
import { MatDividerModule } from '@angular/material/divider';

import { LeafletModule } from '@bluehalo/ngx-leaflet';
import {
  latLng,
  tileLayer,
  Map,
  imageOverlay,
  ImageOverlay,
  LatLngBounds,
} from 'leaflet';

import {
  Viewer,
  Cartesian3,
  Math as CesiumMath,
  SceneMode,
  Color,
  EllipsoidTerrainProvider,
  SingleTileImageryProvider,
  ImageryLayer,
  Rectangle,
} from 'cesium';

import { environment } from '../../environments/environment';

interface NcUploadResponse {
  upload_id: string;
  variables: string[];
  selected_variable: string;
  unit: string;
  time_steps: number;
  lat_min: number;
  lat_max: number;
  lon_min: number;
  lon_max: number;
  value_min: number;
  value_max: number;
  image_base64: string;
}

interface PanelState {
  file: File | null;
  data: NcUploadResponse | null;
  selectedVariable: string;
  selectedTimeIndex: number;
  isLoading: boolean;
  error: string | null;
  isDragOver: boolean;
  // Leaflet
  map: Map | null;
  overlay: ImageOverlay | null;
  // Cesium
  viewer: Viewer | null;
  imageryLayer: ImageryLayer | null;
}

@Component({
  selector: 'app-compare-nc',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    LeafletModule,
    MatButtonModule,
    MatButtonToggleModule,
    MatIconModule,
    MatProgressSpinnerModule,
    MatSelectModule,
    MatTooltipModule,
    MatSliderModule,
    MatDividerModule,
  ],
  templateUrl: './compare-nc.component.html',
  styleUrl: './compare-nc.component.scss',
})
export class CompareNcComponent implements OnInit, OnDestroy {
  @ViewChild('fileInputA') fileInputA!: ElementRef<HTMLInputElement>;
  @ViewChild('fileInputB') fileInputB!: ElementRef<HTMLInputElement>;
  @ViewChild('globeContainerA') globeContainerA!: ElementRef<HTMLDivElement>;
  @ViewChild('globeContainerB') globeContainerB!: ElementRef<HTMLDivElement>;

  viewMode: 'map' | 'globe' = 'map';
  overlayOpacity = 0.75;
  syncViews = true;
  isMobile = false;

  baseLayerA = tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18,
    attribution: '&copy; OSM',
  });
  baseLayerB = tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18,
    attribution: '&copy; OSM',
  });

  mapOptionsA: any = {
    layers: [this.baseLayerA],
    zoom: 3,
    center: latLng(20, 0),
    zoomControl: true,
  };
  mapOptionsB: any = {
    layers: [this.baseLayerB],
    zoom: 3,
    center: latLng(20, 0),
    zoomControl: true,
  };

  panelA: PanelState = this.createPanel();
  panelB: PanelState = this.createPanel();

  private syncing = false;

  constructor(private http: HttpClient) {}

  ngOnInit(): void {
    this.checkMobile();
  }

  ngOnDestroy(): void {
    this.destroyCesium(this.panelA);
    this.destroyCesium(this.panelB);
  }

  @HostListener('window:resize')
  onResize(): void {
    this.checkMobile();
  }

  private checkMobile(): void {
    this.isMobile = window.innerWidth <= 768;
  }

  private createPanel(): PanelState {
    return {
      file: null,
      data: null,
      selectedVariable: '',
      selectedTimeIndex: 0,
      isLoading: false,
      error: null,
      isDragOver: false,
      map: null,
      overlay: null,
      viewer: null,
      imageryLayer: null,
    };
  }

  // ── View mode ───────────────────────────────────────────────────────────────

  onViewModeChange(mode: 'map' | 'globe'): void {
    this.viewMode = mode;
    if (mode === 'globe') {
      // Use longer delay to ensure DOM containers have their final size
      setTimeout(() => {
        this.initCesium(this.panelA, 'globeContainerA');
        this.initCesium(this.panelB, 'globeContainerB');
        if (this.panelA.data) this.applyGlobeOverlay(this.panelA);
        if (this.panelB.data) this.applyGlobeOverlay(this.panelB);
      }, 200);
    } else {
      this.destroyCesium(this.panelA);
      this.destroyCesium(this.panelB);
      setTimeout(() => {
        this.panelA.map?.invalidateSize();
        this.panelB.map?.invalidateSize();
        if (this.panelA.data) this.applyMapOverlay(this.panelA);
        if (this.panelB.data) this.applyMapOverlay(this.panelB);
      }, 100);
    }
  }

  // ── Leaflet map events ──────────────────────────────────────────────────────

  onMapReadyA(map: Map): void {
    this.panelA.map = map;
    setTimeout(() => map.invalidateSize(), 0);
    this.setupMapSync(map, this.panelB);
  }

  onMapReadyB(map: Map): void {
    this.panelB.map = map;
    setTimeout(() => map.invalidateSize(), 0);
    this.setupMapSync(map, this.panelA);
  }

  private setupMapSync(source: Map, targetPanel: PanelState): void {
    source.on('moveend', () => {
      if (!this.syncViews || this.syncing || !targetPanel.map) return;
      this.syncing = true;
      targetPanel.map.setView(source.getCenter(), source.getZoom(), { animate: false });
      this.syncing = false;
    });
  }

  // ── Cesium globe ────────────────────────────────────────────────────────────

  private initCesium(panel: PanelState, containerRef: string): void {
    const el = containerRef === 'globeContainerA'
      ? this.globeContainerA?.nativeElement
      : this.globeContainerB?.nativeElement;
    if (!el || panel.viewer) return;

    panel.viewer = new Viewer(el, {
      sceneMode: SceneMode.SCENE3D,
      animation: false,
      timeline: false,
      homeButton: false,
      geocoder: false,
      baseLayerPicker: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      fullscreenButton: false,
      infoBox: false,
      selectionIndicator: false,
      terrainProvider: new EllipsoidTerrainProvider(),
      requestRenderMode: true,
      maximumRenderTimeChange: Infinity,
    });

    panel.viewer.scene.backgroundColor = Color.fromCssColorString('#1B2735');
    if (panel.viewer.scene.skyBox) {
      panel.viewer.scene.skyBox.show = false;
    }
    (panel.viewer.scene as any).sun = undefined;
    (panel.viewer.scene as any).moon = undefined;

    panel.viewer.camera.setView({
      destination: Cartesian3.fromDegrees(0, 20, 20_000_000),
    });

    panel.viewer.scene.requestRender();
  }

  private destroyCesium(panel: PanelState): void {
    if (panel.viewer && !panel.viewer.isDestroyed()) {
      panel.viewer.destroy();
    }
    panel.viewer = null;
    panel.imageryLayer = null;
  }

  private async applyGlobeOverlay(panel: PanelState): Promise<void> {
    if (!panel.viewer || panel.viewer.isDestroyed() || !panel.data) return;

    // Remove old layer
    if (panel.imageryLayer) {
      panel.viewer.imageryLayers.remove(panel.imageryLayer, true);
      panel.imageryLayer = null;
    }

    const data = panel.data;

    // Convert data URI to blob URL for Cesium
    const byteString = atob(data.image_base64.split(',')[1]);
    const mimeString = data.image_base64.split(',')[0].split(':')[1].split(';')[0];
    const ab = new ArrayBuffer(byteString.length);
    const ia = new Uint8Array(ab);
    for (let i = 0; i < byteString.length; i++) {
      ia[i] = byteString.charCodeAt(i);
    }
    const blob = new Blob([ab], { type: mimeString });
    const blobUrl = URL.createObjectURL(blob);

    const provider = await SingleTileImageryProvider.fromUrl(blobUrl, {
      rectangle: Rectangle.fromDegrees(
        data.lon_min, data.lat_min, data.lon_max, data.lat_max,
      ),
    });

    // Guard against viewer being destroyed while awaiting
    if (!panel.viewer || panel.viewer.isDestroyed()) return;

    panel.imageryLayer = panel.viewer.imageryLayers.addImageryProvider(provider);
    panel.imageryLayer.alpha = this.overlayOpacity;
    panel.viewer.scene.requestRender();
  }

  // ── File upload ─────────────────────────────────────────────────────────────

  onUploadClick(panel: 'A' | 'B'): void {
    if (panel === 'A') {
      this.fileInputA.nativeElement.click();
    } else {
      this.fileInputB.nativeElement.click();
    }
  }

  onFileSelected(event: Event, panel: 'A' | 'B'): void {
    const input = event.target as HTMLInputElement;
    if (!input.files || input.files.length === 0) return;
    const file = input.files[0];
    input.value = '';
    this.uploadFile(file, panel);
  }

  onDragOver(event: DragEvent, panel: 'A' | 'B'): void {
    event.preventDefault();
    event.stopPropagation();
    this.getPanel(panel).isDragOver = true;
  }

  onDragLeave(event: DragEvent, panel: 'A' | 'B'): void {
    event.preventDefault();
    event.stopPropagation();
    this.getPanel(panel).isDragOver = false;
  }

  onDrop(event: DragEvent, panel: 'A' | 'B'): void {
    event.preventDefault();
    event.stopPropagation();
    const p = this.getPanel(panel);
    p.isDragOver = false;

    const files = event.dataTransfer?.files;
    if (files && files.length > 0) {
      const file = files[0];
      if (file.name.toLowerCase().endsWith('.nc')) {
        this.uploadFile(file, panel);
      } else {
        p.error = 'Please drop a .nc (NetCDF) file.';
      }
    }
  }

  uploadFile(file: File, panelId: 'A' | 'B'): void {
    const panel = this.getPanel(panelId);
    panel.isLoading = true;
    panel.error = null;
    panel.file = file;

    const formData = new FormData();
    formData.append('file', file);
    if (panel.selectedVariable) {
      formData.append('variable', panel.selectedVariable);
    }
    formData.append('time_index', String(panel.selectedTimeIndex));

    this.http
      .post<NcUploadResponse>(`${environment.apiBaseUrl}/upload-nc`, formData)
      .subscribe({
        next: (response) => {
          panel.isLoading = false;
          panel.data = response;
          panel.selectedVariable = response.selected_variable;
          if (this.viewMode === 'map') {
            this.applyMapOverlay(panel);
          } else {
            this.applyGlobeOverlay(panel);
          }
        },
        error: (err) => {
          panel.isLoading = false;
          panel.error = `Upload failed: ${err?.error?.detail ?? err?.message ?? 'Unknown error'}`;
        },
      });
  }

  // ── Variable / time controls ────────────────────────────────────────────────

  onVariableChange(panelId: 'A' | 'B'): void {
    const panel = this.getPanel(panelId);
    if (panel.file) this.uploadFile(panel.file, panelId);
  }

  onTimeIndexChange(panelId: 'A' | 'B'): void {
    const panel = this.getPanel(panelId);
    if (panel.file) this.uploadFile(panel.file, panelId);
  }

  // ── Overlay management ──────────────────────────────────────────────────────

  private applyMapOverlay(panel: PanelState): void {
    this.removeMapOverlay(panel);
    if (!panel.map || !panel.data) return;

    const data = panel.data;
    const bounds: [[number, number], [number, number]] = [
      [data.lat_min, data.lon_min],
      [data.lat_max, data.lon_max],
    ];

    panel.overlay = imageOverlay(data.image_base64, bounds, {
      opacity: this.overlayOpacity,
    }).addTo(panel.map);

    panel.map.fitBounds(new LatLngBounds(bounds), { padding: [20, 20] });
  }

  private removeMapOverlay(panel: PanelState): void {
    if (panel.overlay && panel.map) {
      panel.overlay.removeFrom(panel.map);
    }
    panel.overlay = null;
  }

  onOpacityChange(value: number): void {
    this.overlayOpacity = value;
    // Update both panels
    if (this.panelA.overlay) this.panelA.overlay.setOpacity(value);
    if (this.panelB.overlay) this.panelB.overlay.setOpacity(value);
    if (this.panelA.imageryLayer) {
      this.panelA.imageryLayer.alpha = value;
      this.panelA.viewer?.scene.requestRender();
    }
    if (this.panelB.imageryLayer) {
      this.panelB.imageryLayer.alpha = value;
      this.panelB.viewer?.scene.requestRender();
    }
  }

  clearPanel(panelId: 'A' | 'B'): void {
    const panel = this.getPanel(panelId);
    this.removeMapOverlay(panel);
    if (panel.imageryLayer && panel.viewer) {
      panel.viewer.imageryLayers.remove(panel.imageryLayer, true);
      panel.imageryLayer = null;
      panel.viewer.scene.requestRender();
    }
    panel.data = null;
    panel.file = null;
    panel.error = null;
    panel.selectedVariable = '';
    panel.selectedTimeIndex = 0;
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private getPanel(id: 'A' | 'B'): PanelState {
    return id === 'A' ? this.panelA : this.panelB;
  }
}
