# BetterPinterest — Development Guide

Technical documentation for developers and AI agents working on this repo.
For the project overview and user installation, see [README.md](./README.md).

## Architecture principles

1. **State** lives in `chrome.storage.local` (single source of truth).
2. **CSS does the styling.** One master stylesheet is injected once
   (`<style id="pt-master-styles">`); toggling a feature only adds/removes a
   class on `<html>` (`pt-dark`, `pt-hide-search`, ...). No inline styles,
   no `insertCSS` per toggle, no flicker.
3. **JS stays tiny.** Only features that need real logic subclass `BaseFeature`;
   the shared `FeatureRegistry` handles init / enable / disable / revert.

There is **no build step**: the content script uses dynamic `import()` of ES
modules directly from `src/`.

## Project structure

```text
├── manifest.json               # MV3 config (content script + popup + SW)
└── src
    ├── background
    │   └── service-worker.js   # seeds defaults; message-routing extension point
    ├── content
    │   ├── index.js            # entry point: injects styles, boots registry
    │   ├── core
    │   │   ├── registry.js     # BaseFeature / CssFeature / FeatureRegistry
    │   │   ├── storage.js      # promise wrapper for chrome.storage.local
    │   │   └── observer.js     # MutationObserver wrapper (rAF batching)
    │   ├── features
    │   │   ├── index.js        # catalogue + FEATURE_GROUPS + DEFAULT_STATE
    │   │   ├── darkMode.js     # CSS  → html.pt-dark
    │   │   ├── bars.js         # CSS  → bar features (auto-collected)
    │   │   ├── pinGlobal.js    # CSS  → global pin appearance (auto-collected)
    │   │   └── mediaAutoplay.js# JS   → html.pt-autoplay-media + video logic
    │   └── styles
    │       └── master.css      # ALL visual rules, scoped to html classes
    └── popup
        ├── popup.html          # control panel markup
        ├── popup.css           # toggle switch styles
        └── popup.js            # renders toggles + group master switches, writes storage, sends messages
```

## Data flow

1. User clicks a toggle in the popup.
2. `popup.js` writes `chrome.storage.local` and sends a `PT_TWEAKER_TOGGLE`
   message to the background worker (routing / logging extension point).
3. Content scripts receive the change via `chrome.storage.onChanged` (and, as a
   redundant path, the runtime message) and call `registry.apply(id, enabled)`.
4. CSS features: the registry adds/removes the html class — `master.css` does
   the rest. JS features: `feature.enable()` / `feature.disable()` run.
5. On reload, `content/index.js` reads storage once and re-applies everything.

## How to add a CSS toggle (3 steps — no core changes)

1. **`src/content/styles/master.css`** — add rules scoped to a new html class:
   ```css
   html.pt-hide-comments [data-test-id="comments"] { display: none !important; }
   ```
2. **`src/content/features/myFeature.js`** — declare the config:
   ```js
   export const myFeature = {
     id: 'myFeature',
     title: 'Hide Comments',
     type: 'css',
     htmlClass: 'pt-hide-comments',
     defaultValue: false,
     description: 'Hides the comment section.',
   };
   ```
3. **`src/content/features/index.js`** — import it and add it to the matching
   group in `FEATURE_GROUPS` (both the popup sections and the flat `FEATURES`
   list are derived from it).

   > **Bar / pin features skip step 3.** Export the config from `bars.js` or
   > `pinGlobal.js` instead of a new file — `index.js` collects those modules
   > automatically (`import * as bars` / `import * as pinGlobal`), so the new
   > toggle appears in its group as soon as the file is saved.

Done: the registry, popup, storage seeding and content bootstrap pick it up
automatically.

**Checklist after adding a feature file:**

- Module added to `web_accessible_resources` in `manifest.json` (every
  imported module must be listed — see "Notes / limitations").
- `defaultValue` seeds correctly on a fresh install.
- Toggle appears in the popup and persists across a reload.

## How to add a JS feature

Subclass `BaseFeature` (see `mediaAutoplay.js` as a full example), implement
`init()` / `onEnable()` / `onDisable()`, and register the instance in
`src/content/features/index.js`. Use `DomObserver` instead of raw
`MutationObserver` for anything that watches Pinterest's feed.

```js
export class MyFeature extends BaseFeature {
  init() { this.observer = new DomObserver(); /* ... */ }
  onEnable() { /* apply */ }
  onDisable() { /* revert */ }
}
```

## How to add a feature setting (non-boolean option)

Declare a `settings` array on the config; the popup renders a control per
setting and the registry persists it under the storage key
`<featureId>.<settingId>` (`settingKey()` / `parseSettingKey()` in
`core/registry.js`):

```js
export const myFeature = {
  id: 'myFeature',
  // ...
  settings: [
    {
      id: 'speed',
      label: 'Scroll speed',
      type: 'select',
      defaultValue: 'normal',
      options: [
        { value: 'slow', label: 'Slow' },
        { value: 'normal', label: 'Normal' },
      ],
    },
  ],
};
```

Read the current values from `this.settingValues` in `onEnable()` and react to
live changes in the `onSettings(settings)` hook. Nothing else needs to change:
`DEFAULT_STATE`, the popup control, the storage key and the change-routing in
`content/index.js` are all derived from the schema.

## Group master switches (popup)

Every group header in the popup carries a master switch that toggles all of the
group's features at once. It owns **no storage key** — its visual state is
derived from the group's feature switches:

| Group state | Master switch |
| --- | --- |
| every feature on | checked |
| every feature off | unchecked |
| mixed | indeterminate (thumb centred) |

Visually the switch is the first row of the group's card — a tinted header
band with an "All" caption — so the box of toggles it controls is the one
directly beneath it.

Clicking it writes one boolean per feature (bare `<featureId>` keys), exactly
like flipping the individual toggles by hand — the content script, registry
and storage schema need no changes for it.

## Selector maintenance (important)

Pinterest re-rolls generated CSS class names on every deploy. All selectors
should rely on `data-test-id`, `aria-label`, or stable structural patterns
(`#ids`, `:has(...)`, roles) — **never** generated classes like `.xyz123`.

The current rules in `master.css` / `MEDIA_SELECTORS` in `mediaAutoplay.js` use
the placeholder selectors from the design doc; candidate selectors observed in
community userscripts (2025–2026) are listed as comments in both files. When a
toggle stops working, that is where to look first.

## Debugging

> All tips below assume the Pinterest tab with DevTools open.

- The Elements panel / page console show `<html data-pt-tweaker="ready">`
  and `data-pt-state='{"darkMode":true,...}'` — whether the content script
  booted and which state it applies. These are plain DOM attributes, so they
  are visible from the page console, unlike `window.__ptTweaker` (an
  isolated-world global that reads `undefined` in the default console context).
- Bootstrap logs use `console.info` — visible without enabling "Verbose".
- Toggle a feature live from the page console:
  `document.dispatchEvent(new CustomEvent('pt-tweaker:toggle', { detail: { id: 'darkMode', enabled: true } }))`
- After editing content scripts, reload the extension at `chrome://extensions`
  and refresh the Pinterest tab (content scripts don't hot-reload).

## Notes / limitations

- `darkMode` is intentionally minimal (base rules only) — the design doc plans
  CSS-variable injection later.
- `mediaAutoplay` is best-effort: browsers block unmuted autoplay, so videos
  are forced to `muted` + `loop`; GIF→video conversion restores the original
  `<img>` if the replacement fails to load.
- No build step: the content script uses dynamic `import()` of ES modules.
  Every imported module is listed under `web_accessible_resources` in
  `manifest.json` — keep that list in sync when adding feature files.

