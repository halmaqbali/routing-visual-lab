// Theme preference (light / dark / system). Stored separately from labs and from the layout.
import type { KV } from './library';

export type ThemePref = 'system' | 'light' | 'dark';
export const THEME_KEY = 'routing-visual-lab:theme';

export function loadTheme(store: KV | null): ThemePref {
  try {
    const v = store?.getItem(THEME_KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function saveTheme(store: KV | null, t: ThemePref) {
  try {
    store?.setItem(THEME_KEY, t);
  } catch {
    /* ignore */
  }
}

/** Apply the theme to the page: only touches the root element's data-theme attribute. */
export function applyTheme(root: { setAttribute(n: string, v: string): void; removeAttribute(n: string): void }, t: ThemePref) {
  if (t === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', t);
}
