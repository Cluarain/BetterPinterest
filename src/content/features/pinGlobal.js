/**
 * pinGlobal.js
 * ============================================================================
 * CSS-driven features — GLOBAL pin appearance ("оформление пинов").
 *
 * Shared home for EVERY tweak that affects how pins look. features/index.js
 * collects this module automatically (`import * as pinGlobal`), so it becomes
 * the "Pins" group in the popup: to add a feature just `export const` a config
 * object with a unique `id` below and add the matching rules (scoped to its
 * `htmlClass`) to src/content/styles/master.css — no other file changes.
 *
 * Current features:
 *   hidePinHeader → html.pt-hide-pin-header       (pin header info)
 *   hidePinMenu   → html.pt-hide-pin-menu-footer  (hover "⋯" more-options menu)
 * ============================================================================
 */

export const hidePinMenu = {
  id: 'hidePinMenu',
  title: 'Hide menu',
  type: 'css',
  htmlClass: 'pt-hide-pin-menu-footer',
  defaultValue: false,
  description: 'Hides "more options" menu and interactions on pins',
};

export const hidePinHeader = {
  id: 'hidePinHeader',
  title: 'Hide header info',
  type: 'css',
  htmlClass: 'pt-hide-pin-header',
  defaultValue: false,
  description: 'Hides video timer and counter on carousel pins',
};