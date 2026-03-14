import { Injectable } from '@angular/core';
import { CircleMarker, Map, Popup, Tooltip } from 'leaflet';

@Injectable({
  providedIn: 'root',
})
export class TooltipManagerService {
  private hoverTooltips = new WeakMap<Map, Tooltip>();
  private clickPopups = new WeakMap<Map, Popup>();
  private clickMarkers = new WeakMap<Map, CircleMarker>();

  private createTooltip(
    content: string,
    latlng: any,
    map: Map,
    permanent: boolean,
  ): Tooltip {
    const tooltip = new Tooltip({
      content: content,
      className: 'contour-hover-tooltip',
      direction: 'top',
      offset: [0, -4],
      permanent: permanent,
    });

    tooltip.setLatLng(latlng);
    tooltip.addTo(map);
    return tooltip;
  }

  createHoverTooltip(content: string, latlng: any, map: Map): void {
    this.removeHoverTooltip(map);

    const tooltip = this.createTooltip(content, latlng, map, false);
    this.hoverTooltips.set(map, tooltip);
  }

  removeHoverTooltip(map: Map): void {
    const tooltip = this.hoverTooltips.get(map);
    if (tooltip) {
      map.removeLayer(tooltip);
      this.hoverTooltips.delete(map);
    }
  }

  createPersistentTooltip(content: string, latlng: any, map: Map): void {
    this.removeClickTooltip(map);

    const marker = new CircleMarker(latlng, {
      radius: 3,
      fillColor: '#000000',
      color: '#000000',
      weight: 1,
      opacity: 1,
      fillOpacity: 1,
    });
    marker.addTo(map);
    this.clickMarkers.set(map, marker);

    const popup = new Popup({
      className: 'weather-popup',
      closeButton: true,
      autoClose: false,
      closeOnClick: false,
      maxWidth: 320,
      minWidth: 260,
      offset: [0, -6],
    });
    popup.setLatLng(latlng);
    popup.setContent(content);
    popup.addTo(map);
    this.clickPopups.set(map, popup);
  }

  updatePersistentTooltipContent(content: string, map: Map): void {
    const popup = this.clickPopups.get(map);
    if (popup) {
      popup.setContent(content);
      popup.update();
    }
  }

  removeClickTooltip(map: Map): void {
    const popup = this.clickPopups.get(map);
    if (popup) {
      map.removeLayer(popup);
      this.clickPopups.delete(map);
    }
    const marker = this.clickMarkers.get(map);
    if (marker) {
      map.removeLayer(marker);
      this.clickMarkers.delete(map);
    }
  }

  removeAllTooltips(map: Map): void {
    this.removeHoverTooltip(map);
    this.removeClickTooltip(map);
  }
}
