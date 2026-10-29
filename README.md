# BetterPinterest

A modular Chromium extension (Manifest V3) that tweaks the Pinterest interface
through a popup with toggles. No account, no build step, no telemetry — just
load it and flip the switches you want.

## What it does

Toggles are grouped in the popup by what they affect:

| Group | Toggle | Effect |
| --- | --- | --- |
| Theme | **Dark mode** | Minimal dark theme (`html.pt-dark`) |
| Bars & Panels | **Hide left menu** | Collapses the sidebar navigation |
| Bars & Panels | **Hide search bar** | Removes the top search input |
| Bars & Panels | **Hide tabs bar** | Hides the tabs bar on the home feed |
| Pins | **Hide pin menu** | Hides the "⋯" more-options menu on pins |
| Feed & Media | **Media autoplay** | Restarts muted looping playback of feed videos/GIFs |

Every group header also carries a master switch that flips all toggles in its
group at once (it shows a "mixed" state while only some of them are on).

State persists per-browser in `chrome.storage.local`, so your toggles survive
reloads and restarts.

## How it works (short version)

1. **State** lives in `chrome.storage.local` (single source of truth).
2. **CSS does the styling.** One master stylesheet is injected once;
   toggling a feature only adds/removes a class on `<html>`. No flicker.
3. **JS stays tiny.** Only features that need real logic run JavaScript;
   everything else is pure CSS.

## Install (dev mode)

1. Clone the repository and enter its folder:

   ```bash
   git clone https://github.com/Cluarain/better-pinterest.git
   cd better-pinterest
   ```

   (Alternatively, download the ZIP from GitHub and extract it.)

2. Open `chrome://extensions`
3. Enable **Developer mode** (top right)
4. **Load unpacked** → select the cloned `better-pinterest` folder
5. Open `https://www.pinterest.com`, click the toolbar icon, flip a toggle.

## Notes / limitations

- `darkMode` is intentionally minimal (base rules only).
- `mediaAutoplay` is best-effort: browsers block unmuted autoplay, so videos
  are forced to `muted` + `loop`.
- Pinterest re-rolls generated CSS class names on every deploy, so selectors
  are based on stable attributes (`data-test-id`, `aria-label`, roles).

## Development

Working on the code, adding features, or using an AI agent on this repo? See
**[README.DEV.md](./README.DEV.md)** — architecture, project structure, guides,
and debugging notes for developers and agents.

