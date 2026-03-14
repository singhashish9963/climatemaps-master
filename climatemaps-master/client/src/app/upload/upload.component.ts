import {
  Component,
  ViewChild,
  ElementRef,
  OnInit,
  HostListener,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSelectModule } from '@angular/material/select';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatCardModule } from '@angular/material/card';
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
  LeafletMouseEvent,
} from 'leaflet';

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

interface NcPointValueResponse {
  upload_id: string;
  variable: string;
  latitude: number;
  longitude: number;
  value: number;
  unit: string;
}

@Component({
  selector: 'app-upload',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    LeafletModule,
    MatButtonModule,
    MatIconModule,
    MatProgressSpinnerModule,
    MatSelectModule,
    MatTooltipModule,
    MatCardModule,
    MatSliderModule,
    MatDividerModule,
  ],
  templateUrl: './upload.component.html',
  styleUrl: './upload.component.scss',
})
export class UploadComponent implements OnInit {
  @ViewChild('fileInput') fileInput!: ElementRef<HTMLInputElement>;

  // Map
  private map: Map | null = null;
  private ncImageOverlay: ImageOverlay | null = null;

  baseLayer = tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18,
    attribution: '&copy; OpenStreetMap contributors',
  });

  mapOptions: any = {
    layers: [this.baseLayer],
    zoom: 3,
    center: latLng(20, 0),
    zoomControl: true,
  };

  // Upload state
  isLoading = false;
  errorMessage: string | null = null;
  uploadData: NcUploadResponse | null = null;
  selectedVariable = '';
  selectedTimeIndex = 0;
  overlayOpacity = 0.75;

  // Point query state
  pointValue: NcPointValueResponse | null = null;
  queryingPoint = false;
  clickedLat: number | null = null;
  clickedLon: number | null = null;

  // Drag-and-drop
  isDragOver = false;

  // File reference for re-upload on variable change
  private lastFile: File | null = null;

  isMobile = false;

  constructor(private http: HttpClient) {}

  ngOnInit(): void {
    this.checkMobile();
  }

  @HostListener('window:resize')
  onResize(): void {
    this.checkMobile();
  }

  private checkMobile(): void {
    this.isMobile = window.innerWidth <= 768;
  }

  // ── Map events ──────────────────────────────────────────────────────────────

  onMapReady(map: Map): void {
    this.map = map;
    setTimeout(() => map.invalidateSize(), 0);
  }

  onMapClick(event: LeafletMouseEvent): void {
    if (!this.uploadData || !this.map) return;

    this.clickedLat = event.latlng.lat;
    this.clickedLon = event.latlng.lng;
    this.queryPointValue(this.clickedLat, this.clickedLon);
  }

  private queryPointValue(lat: number, lon: number): void {
    if (!this.uploadData) return;
    this.queryingPoint = true;
    this.pointValue = null;

    const uploadId = this.uploadData.upload_id;
    this.http
      .get<NcPointValueResponse>(
        `${environment.apiBaseUrl}/nc-value/${uploadId}?lat=${lat}&lon=${lon}`,
      )
      .subscribe({
        next: (res) => {
          this.pointValue = res;
          this.queryingPoint = false;
        },
        error: () => {
          this.pointValue = null;
          this.queryingPoint = false;
        },
      });
  }

  // ── File upload ─────────────────────────────────────────────────────────────

  onUploadButtonClick(): void {
    this.fileInput.nativeElement.click();
  }

  onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (!input.files || input.files.length === 0) return;
    const file = input.files[0];
    input.value = '';
    this.uploadFile(file);
  }

  // Drag-and-drop handlers
  onDragOver(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDragOver = true;
  }

  onDragLeave(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDragOver = false;
  }

  onDrop(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDragOver = false;

    const files = event.dataTransfer?.files;
    if (files && files.length > 0) {
      const file = files[0];
      if (file.name.toLowerCase().endsWith('.nc')) {
        this.uploadFile(file);
      } else {
        this.errorMessage = 'Please drop a .nc (NetCDF) file.';
      }
    }
  }

  uploadFile(file: File): void {
    this.isLoading = true;
    this.errorMessage = null;
    this.pointValue = null;
    this.lastFile = file;

    const formData = new FormData();
    formData.append('file', file);
    if (this.selectedVariable) {
      formData.append('variable', this.selectedVariable);
    }
    formData.append('time_index', String(this.selectedTimeIndex));

    this.http
      .post<NcUploadResponse>(
        `${environment.apiBaseUrl}/upload-nc`,
        formData,
      )
      .subscribe({
        next: (response) => {
          this.isLoading = false;
          this.uploadData = response;
          this.selectedVariable = response.selected_variable;
          this.applyOverlay(response);
        },
        error: (err) => {
          this.isLoading = false;
          const detail =
            err?.error?.detail ?? err?.message ?? 'Unknown error';
          this.errorMessage = `Upload failed: ${detail}`;
        },
      });
  }

  // ── Variable / time change ──────────────────────────────────────────────────

  onVariableChange(): void {
    if (!this.lastFile) return;
    this.uploadFile(this.lastFile);
  }

  onTimeIndexChange(): void {
    if (!this.lastFile) return;
    this.uploadFile(this.lastFile);
  }

  // ── Overlay management ──────────────────────────────────────────────────────

  private applyOverlay(data: NcUploadResponse): void {
    this.removeOverlay();
    if (!this.map) return;

    const bounds: [[number, number], [number, number]] = [
      [data.lat_min, data.lon_min],
      [data.lat_max, data.lon_max],
    ];

    this.ncImageOverlay = imageOverlay(data.image_base64, bounds, {
      opacity: this.overlayOpacity,
    }).addTo(this.map);

    // Fit the map to the data bounds
    this.map.fitBounds(new LatLngBounds(bounds), { padding: [30, 30] });
  }

  private removeOverlay(): void {
    if (this.ncImageOverlay && this.map) {
      this.ncImageOverlay.removeFrom(this.map);
    }
    this.ncImageOverlay = null;
  }

  onOpacityChange(value: number): void {
    this.overlayOpacity = value;
    if (this.ncImageOverlay) {
      this.ncImageOverlay.setOpacity(value);
    }
  }

  clearAll(): void {
    this.removeOverlay();
    this.uploadData = null;
    this.pointValue = null;
    this.errorMessage = null;
    this.lastFile = null;
    this.selectedVariable = '';
    this.selectedTimeIndex = 0;
  }
}
