import { Injectable } from '@angular/core';
import { LayerOption } from '../../map/services/layer-builder.service';

export interface GlobeLayerConfig {
  tileUrl: string;
  maxZoom: number;
  opacity: number;
}

@Injectable({
  providedIn: 'root',
})
export class GlobeLayerService {
  buildTileUrl(layerOption: LayerOption, month: number): string {
    return `${layerOption.rasterUrl}_${month}/{z}/{x}/{y}.png`;
  }

  buildLayerConfig(
    layerOption: LayerOption,
    month: number,
  ): GlobeLayerConfig {
    return {
      tileUrl: this.buildTileUrl(layerOption, month),
      maxZoom: layerOption.rasterMaxZoom,
      opacity: 0.8,
    };
  }
}
