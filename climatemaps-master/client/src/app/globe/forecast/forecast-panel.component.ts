import {
  Component,
  Input,
  OnChanges,
  OnDestroy,
  SimpleChanges,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';

export interface ForecastPoint {
  label: string;
  offsetHours: number;
  tempCelsius: number;
}

@Component({
  selector: 'app-forecast-panel',
  standalone: true,
  imports: [CommonModule, MatProgressSpinnerModule],
  templateUrl: './forecast-panel.component.html',
  styleUrl: './forecast-panel.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ForecastPanelComponent implements OnChanges, OnDestroy {
  @Input() lat: number = 0;
  @Input() lon: number = 0;
  @Input() currentTemp: number | null = null;

  isLoading = false;
  forecastPoints: ForecastPoint[] = [];
  private loadingTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private cdr: ChangeDetectorRef) {}

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['lat'] || changes['lon'] || changes['currentTemp']) {
      this.triggerLoading();
    }
  }

  ngOnDestroy(): void {
    if (this.loadingTimer) clearTimeout(this.loadingTimer);
  }

  private triggerLoading(): void {
    if (this.loadingTimer) clearTimeout(this.loadingTimer);
    this.isLoading = true;
    this.forecastPoints = [];
    this.cdr.markForCheck();

    this.loadingTimer = setTimeout(() => {
      this.generateDummyForecast();
      this.isLoading = false;
      this.cdr.markForCheck();
    }, 3200);
  }

  private generateDummyForecast(): void {
    const nowTemp = this.currentTemp ?? 15 + (Math.random() - 0.5) * 30;
    this.forecastPoints = [0, 12, 24].map((hours) => ({
      label: hours === 0 ? 'Now' : `+${hours}h`,
      offsetHours: hours,
      tempCelsius:
        hours === 0 ? nowTemp : nowTemp + (Math.random() * 10 - 5),
    }));
  }

  formatTemp(celsius: number): string {
    return celsius.toFixed(1);
  }

  getTempColor(celsius: number): string {
    if (celsius >= 30) return '#ef4444';
    if (celsius >= 20) return '#f97316';
    if (celsius >= 10) return '#eab308';
    if (celsius >= 0) return '#22c55e';
    return '#3b82f6';
  }
}
