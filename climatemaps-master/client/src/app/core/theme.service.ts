import { Injectable, signal, effect } from '@angular/core';
import { LocalStorageService } from './local-storage.service';

export type Theme = 'light' | 'dark';

const THEME_KEY = 'theme';

@Injectable({
  providedIn: 'root',
})
export class ThemeService {
  readonly theme: ReturnType<typeof signal<Theme>>;

  constructor(private localStorage: LocalStorageService) {
    this.theme = signal<Theme>(this.getInitialTheme());
    this.applyTheme(this.theme());

    effect(() => {
      const current = this.theme();
      this.applyTheme(current);
      this.localStorage.setItem(THEME_KEY, current);
    });
  }

  toggle(): void {
    this.theme.set(this.theme() === 'light' ? 'dark' : 'light');
  }

  private getInitialTheme(): Theme {
    const stored = this.localStorage.getItem(THEME_KEY);
    if (stored === 'light' || stored === 'dark') {
      return stored;
    }
    if (
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches
    ) {
      return 'dark';
    }
    return 'light';
  }

  private applyTheme(theme: Theme): void {
    if (typeof document === 'undefined') return;
    document.body.classList.remove('light-theme', 'dark-theme');
    document.body.classList.add(`${theme}-theme`);
  }
}
