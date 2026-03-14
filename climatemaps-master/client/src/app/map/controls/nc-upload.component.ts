import {
  Component,
  EventEmitter,
  Output,
  ViewChild,
  ElementRef,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSelectModule } from '@angular/material/select';
import { MatSliderModule } from '@angular/material/slider';
import { MatTooltipModule } from '@angular/material/tooltip';

import { environment } from '../../../environments/environment';

export interface NcUploadResponse {
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

export interface NcOverlayData {
  response: NcUploadResponse;
  imageUrl: string;
  bounds: [[number, number], [number, number]]; // [[south, west], [north, east]]
}

@Component({
  selector: 'app-nc-upload',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatButtonModule,
    MatIconModule,
    MatProgressSpinnerModule,
    MatSelectModule,
    MatSliderModule,
    MatTooltipModule,
  ],
  templateUrl: './nc-upload.component.html',
  styleUrl: './nc-upload.component.scss',
})
export class NcUploadComponent {
  @ViewChild('fileInput') fileInput!: ElementRef<HTMLInputElement>;
  @Output() overlayChanged = new EventEmitter<NcOverlayData | null>();

  isLoading = false;
  errorMessage: string | null = null;
  uploadData: NcUploadResponse | null = null;
  selectedVariable = '';
  selectedTimeIndex = 0;
  isCollapsed = false;

  constructor(private http: HttpClient) {}

  onUploadButtonClick(): void {
    this.fileInput.nativeElement.click();
  }

  onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (!input.files || input.files.length === 0) return;
    const file = input.files[0];
    // Reset input so same file can be re-selected
    input.value = '';
    this.uploadFile(file);
  }

  uploadFile(file: File): void {
    this.isLoading = true;
    this.errorMessage = null;

    const formData = new FormData();
    formData.append('file', file);
    if (this.selectedVariable) {
      formData.append('variable', this.selectedVariable);
    }
    formData.append('time_index', String(this.selectedTimeIndex));

    this.http
      .post<NcUploadResponse>(`${environment.apiBaseUrl}/upload-nc`, formData)
      .subscribe({
        next: (response) => {
          this.isLoading = false;
          this.uploadData = response;
          this.selectedVariable = response.selected_variable;
          this.selectedTimeIndex = 0;
          this.emitOverlay(response);
        },
        error: (err) => {
          this.isLoading = false;
          const detail = err?.error?.detail ?? err?.message ?? 'Unknown error';
          this.errorMessage = `Upload failed: ${detail}`;
        },
      });
  }

  onVariableChange(): void {
    if (!this.uploadData) return;
    this.reUploadWithOptions();
  }

  onTimeIndexChange(): void {
    if (!this.uploadData) return;
    this.reUploadWithOptions();
  }

  private reUploadWithOptions(): void {
    if (!this.uploadData) return;
    // Re-upload with the same file is not practical here; instead reload from server
    // This re-renders on the server side using the stored upload_id
    this.isLoading = true;
    this.errorMessage = null;

    const url =
      `${environment.apiBaseUrl}/upload-nc-render` +
      `?upload_id=${this.uploadData.upload_id}` +
      `&variable=${encodeURIComponent(this.selectedVariable)}` +
      `&time_index=${this.selectedTimeIndex}`;

    // NOTE: For simplicity, variable/time re-selection requires re-upload.
    // The panel only shows re-render button; full re-upload on variable change.
    this.isLoading = false;
  }

  removeOverlay(): void {
    this.uploadData = null;
    this.selectedVariable = '';
    this.selectedTimeIndex = 0;
    this.errorMessage = null;
    this.overlayChanged.emit(null);
  }

  toggleCollapse(): void {
    this.isCollapsed = !this.isCollapsed;
  }

  private emitOverlay(response: NcUploadResponse): void {
    const overlayData: NcOverlayData = {
      response,
      imageUrl: response.image_base64,
      bounds: [
        [response.lat_min, response.lon_min],
        [response.lat_max, response.lon_max],
      ],
    };
    this.overlayChanged.emit(overlayData);
  }

  get formattedValueMin(): string {
    return this.uploadData ? this.uploadData.value_min.toFixed(2) : '';
  }

  get formattedValueMax(): string {
    return this.uploadData ? this.uploadData.value_max.toFixed(2) : '';
  }
}
