/**
 * features/index.js
 * ============================================================================
 * Feature catalogue — grouping declaration for the whole extension.
 *
 * `FEATURE_GROUPS` is the single source of truth for both the flat feature list
 * and the popup sections. Bars and pin features are COLLECTED AUTOMATICALLY
 * from their barrel modules (`import * as bars` / `import * as pinGlobal`):
 *
 *   darkMode.js      → Theme         (appearance)
 *   bars.js          → Bars & Panels (auto-collected: leftMenu, searchBar, ...)
 *   pinGlobal.js     → Pins          (auto-collected: every pin-appearance tweak)
 *   mediaAutoplay.js → Feed & Media  (JS)
 *   autoScroll.js    → Feed & Media  (JS, configurable)
 *
 * Adding a feature:
 *   - a bar / pin feature → just `export const myFeature = { id, ... }` from
 *     bars.js or pinGlobal.js; it lands in its group automatically (module
 *     namespaces hand out their exports in sorted order). Then add the CSS.
 *   - anything else → drop a new file in src/content/features/, import it and
 *     add it to the matching group in `FEATURE_GROUPS`, then add the CSS rules.
 *
 * Settings: a feature may declare `settings: [{ id, label, type, options,
 * defaultValue }]`. Those are persisted under `<featureId>.<settingId>` keys
 * (see settingKey/parseSettingKey in core/registry.js) and rendered by the
 * popup — still nothing else in the codebase needs to change.
 * ============================================================================
 */

import { settingKey } from '../core/registry.js';
import { darkMode } from './darkMode.js';
import * as bars from './bars.js';
import * as pinGlobal from './pinGlobal.js';
import { gifAutoplay, GifAutoplayFeature, videoAutoplay, VideoAutoplayFeature } from './mediaAutoplay.js';
// import { autoScroll, AutoScrollFeature } from './autoScroll.js';

/**
 * Collect every exported feature config from a barrel module namespace object
 * (`import * as bars`). Namespace exports come out in sorted order, so a plain
 * `export const myFeature = { id, ... }` in bars.js / pinGlobal.js is enough —
 * no change is needed here. Non-feature exports (anything without a string
 * `id`) are ignored so a helper/constant can't break the registry.
 * @param {Record<string, unknown>} moduleNamespace
 * @returns {Array<Object>} feature configs
 */
const collectFeatures = (moduleNamespace) =>
  Object.values(moduleNamespace).filter(
    (value) => value && typeof value === 'object' && typeof value.id === 'string',
  );

/**
 * Ordered feature GROUPS — both the popup sections and the flat FEATURES list
 * are derived from this single array, so grouping stays in one place.
 * @type {Array<{ id: string, title: string, features: Array<Object> }>}
 */
export const FEATURE_GROUPS = [
  {
    id: 'theme',
    title: 'Theme',
    features: [darkMode],
  },
  {
    id: 'panels',
    title: 'Bars & Panels',
    features: collectFeatures(bars),
  },
  {
    id: 'pins',
    title: 'Pins',
    features: collectFeatures(pinGlobal),
  },
  {
    id: 'feed',
    title: 'Feed & Media',
    features: [
      new GifAutoplayFeature(gifAutoplay),
      new VideoAutoplayFeature(videoAutoplay),
      // new AutoScrollFeature(autoScroll),
    ],
  },
];

/**
 * Flat, ordered feature list. Plain configs are auto-wrapped into CssFeature
 * instances by FeatureRegistry.register(); instances are used as-is.
 */
export const FEATURES = FEATURE_GROUPS.flatMap((group) => group.features);

/**
 * Default persisted state — the fallback used when storage is empty (shared by
 * popup, content bootstrap and background onInstalled). Keys are feature ids
 * (boolean toggles) plus `<featureId>.<settingId>` for every declared setting
 * (e.g. `autoScroll.speed`).
 * @type {Readonly<Record<string, boolean|string|number>>}
 */
export const DEFAULT_STATE = Object.freeze({
  ...FEATURES.reduce((acc, feature) => {
    acc[feature.id] = feature.defaultValue;
    return acc;
  }, {}),
  ...FEATURES.reduce((acc, feature) => {
    for (const setting of feature.settings ?? []) {
      acc[settingKey(feature.id, setting.id)] = setting.defaultValue;
    }
    return acc;
  }, {}),
});

/** Look up a feature/config by id. */
export const getFeature = (id) => FEATURES.find((feature) => feature.id === id);