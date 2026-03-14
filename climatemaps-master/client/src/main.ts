import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { AppComponent } from './app/app.component';

// Cesium requires a base URL to locate its Workers, Assets, and ThirdParty files
(window as any).CESIUM_BASE_URL = '/cesium/';

bootstrapApplication(AppComponent, appConfig).catch((err) =>
  console.error(err),
);
