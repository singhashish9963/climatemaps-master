import { Component, EventEmitter, inject, Input, Output } from '@angular/core';
import { MatSliderModule } from '@angular/material/slider';
import { CommonModule } from '@angular/common';
import { YearRange, MetadataService } from '../../../core/metadata.service';
import { MatomoTracker } from 'ngx-matomo-client';

@Component({
  selector: 'app-year-slider',
  standalone: true,
  imports: [CommonModule, MatSliderModule],
  templateUrl: './year-slider.component.html',
  styleUrls: ['./year-slider.component.scss'],
})
export class YearSliderComponent {
  private readonly tracker = inject(MatomoTracker);
  private readonly metadataService = inject(MetadataService);

  @Output() valueChange = new EventEmitter<YearRange>();
  @Input() value: YearRange | null = null;
  @Input() years: YearRange[] = [];
  @Input() disabled = false;

  get sliderValue(): number {
    if (!this.value || this.years.length === 0) return 1;
    const index = this.years.findIndex((yr) => {
      const matchesPrimary =
        yr.value[0] === this.value!.value[0] &&
        yr.value[1] === this.value!.value[1];
      const matchesAdditional = yr.additionalValues?.some(
        (av: [number, number]) =>
          av[0] === this.value!.value[0] && av[1] === this.value!.value[1],
      );
      return matchesPrimary || matchesAdditional;
    });
    return index >= 0 ? index + 1 : 1;
  }

  onInput(raw: number | string) {
    const idx = Number(raw);
    if (this.years.length > 0 && idx >= 1 && idx <= this.years.length) {
      const selected = this.years[idx - 1];
      this.valueChange.emit(selected);
      this.tracker.trackEvent('Slider Control', 'Year Range Change', selected.label, idx);
    }
  }

  getDisplayLabel(yearRange: YearRange): string {
    if (yearRange.value[0] === 2081 && yearRange.value[1] === 2100) {
      return '2011-2020';
    }
    return yearRange.label;
  }

  displayWith = (val: number): string => {
    if (this.years.length > 0 && val >= 1 && val <= this.years.length) {
      const year = this.years[val - 1];
      return year ? this.getDisplayLabel(year) : '';
    }
    return '';
  };

  isHistoricalYearRange(yearRange: YearRange): boolean {
    return this.metadataService.isHistoricalYearRange(yearRange.value);
  }
}
