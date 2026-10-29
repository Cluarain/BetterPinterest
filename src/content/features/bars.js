/**
 * bars.js
 * ============================================================================
 * CSS-driven features — the top "bar" surfaces around the feed.
 *
 * These three toggles are one UI concept (the chrome/panels that frame the
 * feed) and therefore live in a single file and share a single popup group
 * ("Bars & Panels"). Each one only declares configuration — the actual styling
 * lives in `src/content/styles/master.css`, scoped to the html class below.
 *
 *   leftMenu  → html.pt-hide-left-menu  (left navigation sidebar)
 *   searchBar → html.pt-hide-search     (top search input)
 *   tabsBar   → html.pt-hide-tabs       (home-feed tabs bar)
 *
 * TODO(future): `pt-interactive-left-menu` — collapse on demand instead of a
 * hard hide (would need JS positioning/visibility logic).
 * ============================================================================
 */

export const leftMenu = {
  id: 'leftMenu',
  title: 'Hide left menu',
  type: 'css',
  htmlClass: 'pt-hide-left-menu',
  defaultValue: false,
  description: 'Hides the left navigation sidebar',
};

export const searchBar = {
  id: 'searchBar',
  title: 'Hide search bar',
  type: 'css',
  htmlClass: 'pt-hide-search',
  defaultValue: false,
  description: 'Hides the top search bar',
};

export const tabsBar = {
  id: 'tabsBar',
  title: 'Hide tabs bar',
  type: 'css',
  htmlClass: 'pt-hide-tabs',
  defaultValue: false,
  description: 'Hides the top tabs bar',
};
