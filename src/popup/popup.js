/**
 * popup.js — toggle UI controller.
 * ============================================================================
 * Renders one switch per registered feature, grouped into the same sections
 * declared in `FEATURE_GROUPS` (src/content/features/index.js), a tri-state
 * master switch in every group header with 2+ features (flips all of the
 * group's features; its state is DERIVED — it owns no storage key), plus a
 * control for every declared feature setting (e.g. auto-scroll speed).
 *
 * chrome.storage.local stays the single source of truth: each change is written
 * there and the content script applies it via `storage.onChanged`. The popup
 * ALSO pings the background worker / active tab (message-routing flow per the
 * design doc) for immediate feedback.
 * ============================================================================
 */

import { FEATURE_GROUPS, FEATURES, DEFAULT_STATE, getFeature } from '../content/features/index.js';
import { Storage } from '../content/core/storage.js';
import { settingKey, parseSettingKey } from '../content/core/registry.js';

/** Message contract shared with the background worker and content script. */
const MESSAGE_TYPE = 'PT_TWEAKER_TOGGLE';

const store = new Storage('local');
const listEl = document.getElementById('featureList');
const statusEl = document.getElementById('status');

/** Tooltip whose ⓘ marker is currently hovered — re-clamped on scroll. */
let activeTooltip = null;

/**
 * Build the DOM for a single toggle row. The description is NOT rendered
 * inline: it becomes a tooltip (`.toggle-tooltip`) nested inside the
 * decorative "ⓘ" marker and revealed by CSS only while that marker is
 * hovered. The checkbox keeps its aria-describedby pointing at the tooltip
 * element, so screen readers still announce the description.
 */
function createRow(feature) {
  const label = document.createElement('label');
  label.className = 'toggle-row';
  label.setAttribute('data-feature-id', feature.id);

  const input = document.createElement('input');
  input.type = 'checkbox';
  input.className = 'toggle-input';
  input.dataset.featureId = feature.id;
  input.setAttribute('aria-describedby', `desc-${feature.id}`);

  const body = document.createElement('span');
  body.className = 'toggle-body';

  const titleRow = document.createElement('span');
  titleRow.className = 'toggle-title-row';

  const title = document.createElement('span');
  title.className = 'toggle-title';
  title.textContent = feature.title;

  // const badge = document.createElement('span');
  // badge.className = `toggle-badge toggle-badge--${feature.type}`;
  // badge.textContent = feature.type === 'js' ? 'JS' : 'CSS';

  // "ⓘ" marker — the tooltip trigger AND its positioning anchor: the
  // tooltip element lives INSIDE it (kept out of aria-hidden so the
  // checkbox's aria-describedby still reaches the text). The marker sits
  // inside the row <label>, so a click on it must not flip the switch —
  // hovering is all it is for.
  const hint = document.createElement('span');
  hint.className = 'toggle-hint';
  hint.addEventListener('click', (event) => event.preventDefault());

  // Description as a hover-only tooltip. Hidden via `opacity` (NOT display)
  // so the aria-describedby target stays in the accessibility tree; CSS
  // reveals it only while the marker itself is hovered.
  const tooltip = document.createElement('span');
  tooltip.className = 'toggle-tooltip';
  tooltip.id = `desc-${feature.id}`;
  tooltip.setAttribute('role', 'tooltip');
  tooltip.textContent = feature.description;
  hint.append(tooltip);

  // CSS centers the tooltip on the marker; a wide one would be clipped by
  // the window edge, so every hover (re)measures it and nudges it back
  // inside (see clampTooltip). mouseleave only forgets it as the re-clamp
  // target used while scrolling.
  hint.addEventListener('mouseenter', () => {
    activeTooltip = tooltip;
    clampTooltip(tooltip);
  });
  hint.addEventListener('mouseleave', () => {
    if (activeTooltip === tooltip) activeTooltip = null;
  });

  titleRow.append(title, hint);

  const track = document.createElement('span');
  track.className = 'toggle-track';
  track.setAttribute('aria-hidden', 'true');
  const thumb = document.createElement('span');
  thumb.className = 'toggle-thumb';
  track.appendChild(thumb);

  body.append(titleRow);
  label.append(input, body, ...createInlineSettings(feature), track);
  return label;
}

/** Breathing room kept between the tooltip and the popup window edges. */
const TOOLTIP_EDGE_GAP = 8;

/**
 * Keep the floating tooltip fully inside the popup window.
 *
 * CSS centers the tooltip on the ⓘ marker; a wide one then overflows the
 * 320px window and body's `overflow-x: hidden` cuts it off (and scrolled
 * down, a tall one can run past the top edge). The tooltip is laid out at
 * opacity:0 — not display:none — so its real box is measurable before the
 * fade-in. Measured in the neutral (centered) position, it is shifted via
 * the --tip-shift-x / --tip-shift-y custom properties just enough to clear
 * both edges, and opened DOWNWARD (`.toggle-tooltip--below`) when there is
 * no room above it. The ::after arrow offsets by the same X shift, so it
 * keeps pointing at the marker.
 * @param {HTMLElement} tooltip
 */
function clampTooltip(tooltip) {
  const gap = TOOLTIP_EDGE_GAP;
  const view = document.documentElement;
  const bounds = view.getBoundingClientRect();
  const topLimit = bounds.top + gap;

  // Measure the default (opens upward) layout: any previous shift and flip
  // are removed first, so stale values can't skew the decision.
  tooltip.classList.remove('toggle-tooltip--below');
  tooltip.style.removeProperty('--tip-shift-x');
  tooltip.style.removeProperty('--tip-shift-y');

  // No room above (e.g. the popup is scrolled and the row sits at the very
  // top) → open downward under the marker instead.
  const aboveTop = tooltip.getBoundingClientRect().top;
  tooltip.classList.toggle('toggle-tooltip--below', aboveTop < topLimit);

  const tip = tooltip.getBoundingClientRect();
  // Sticking out left/top → shift right/down (positive); sticking out on
  // the right shifts left (negative). clientWidth excludes a classic
  // scrollbar, so the right limit is the actually visible edge.
  const dx = tip.left < bounds.left + gap
    ? bounds.left + gap - tip.left
    : Math.min(0, bounds.left + view.clientWidth - gap - tip.right);
  const dy = Math.max(0, topLimit - tip.top);

  tooltip.style.setProperty('--tip-shift-x', `${dx}px`);
  tooltip.style.setProperty('--tip-shift-y', `${dy}px`);
}

/**
 * Number settings render INSIDE the feature's toggle row, right before the
 * switch (no separate setting row below). The row is a <label> around the
 * checkbox — a click on the embedded input would flip the switch, so its
 * default action is suppressed (same trick as the ⓘ hint marker above).
 */
function createInlineSettings(feature) {
  const nodes = [];
  for (const setting of feature.settings ?? []) {
    if (setting.type !== 'number') continue;
    const wrap = document.createElement('span');
    wrap.className = 'setting-inline';
    const input = createNumberInput(feature, setting, `setting-${feature.id}-${setting.id}`);
    input.addEventListener('click', (event) => event.preventDefault());
    wrap.append(input);
    if (setting.unit) {
      const unit = document.createElement('span');
      unit.className = 'setting-unit';
      unit.textContent = setting.unit;
      wrap.append(unit);
    }
    nodes.push(wrap);
  }
  return nodes;
}

/** Build the DOM for one feature setting — a `select` on its own row. */
function createSettingRow(feature, setting) {
  const row = document.createElement('div');
  row.className = 'setting-row';
  row.dataset.featureId = feature.id;
  row.dataset.settingId = setting.id;

  const controlId = `setting-${feature.id}-${setting.id}`;

  const head = document.createElement('div');
  head.className = 'setting-head';

  const label = document.createElement('label');
  label.className = 'setting-label';
  label.htmlFor = controlId;
  label.textContent = setting.label;
  head.append(label);

  row.append(head, createSelectInput(feature, setting, controlId));
  return row;
}

/** `<input type="number">` — numeric setting, rendered inline in the feature's toggle row. */
function createNumberInput(feature, setting, controlId) {
  const input = document.createElement('input');
  input.type = 'number';
  input.className = 'setting-number-input';
  input.id = controlId;
  input.setAttribute('aria-label', setting.label);
  input.dataset.featureId = feature.id;
  input.dataset.settingId = setting.id;
  input.min = String(setting.min ?? 0);
  input.max = String(setting.max ?? 100);
  input.step = String(setting.step ?? 1);
  return input;
}

/** `<select>` built from `setting.options`. */
function createSelectInput(feature, setting, controlId) {
  const select = document.createElement('select');
  select.className = 'setting-select';
  select.id = controlId;
  select.dataset.featureId = feature.id;
  select.dataset.settingId = setting.id;

  for (const option of setting.options ?? []) {
    const opt = document.createElement('option');
    opt.value = String(option.value);
    opt.textContent = option.label;
    select.append(opt);
  }
  return select;
}

/** Push a stored value onto a control. */
function applyControlValue(control, setting, value) {
  control.value = value == null ? String(setting.defaultValue) : String(value);
}

/**
 * The master switch inside a group header — flips every feature of the group
 * at once. It owns NO storage key: its checked/indeterminate/unchecked state
 * is derived from the group's feature switches (see updateGroupToggleStates).
 * The "All" caption names the scope explicitly.
 */
function createGroupToggle(group) {
  const label = document.createElement('label');
  label.className = 'group-toggle';
  label.title = `Toggle all "${group.title}" features`;

  const input = document.createElement('input');
  input.type = 'checkbox';
  input.className = 'group-toggle-input';
  input.dataset.groupId = group.id;
  input.setAttribute('aria-label', `Toggle all ${group.title} features`);

  // DOM order: hidden input → caption → track. The caption renders to the LEFT
  // of the switch while remaining a later sibling of the input, so popup.css
  // recolors it from the switch state (checked / indeterminate).
  const caption = document.createElement('span');
  caption.className = 'group-toggle-caption';
  caption.textContent = 'All';
  caption.setAttribute('aria-hidden', 'true');

  const track = document.createElement('span');
  track.className = 'toggle-track';
  track.setAttribute('aria-hidden', 'true');
  const thumb = document.createElement('span');
  thumb.className = 'toggle-thumb';
  track.appendChild(thumb);

  label.append(input, caption, track);
  return label;
}

/**
 * Build a popup section for a logical feature group. The header (title +, for
 * groups with 2+ features, the master switch) is the FIRST row of the bordered
 * card, so the switch visibly governs exactly the group of toggles beneath it.
 */
function createGroup(group) {
  const section = document.createElement('section');
  section.className = 'group';
  section.dataset.groupId = group.id;

  const headingId = `group-${group.id}`;
  section.setAttribute('aria-labelledby', headingId);

  const items = document.createElement('div');
  items.className = 'group-items';

  const head = document.createElement('div');
  head.className = 'group-head';

  const heading = document.createElement('h2');
  heading.className = 'group-title';
  heading.id = headingId;
  heading.textContent = group.title;

  head.append(heading);

  // The "All" master switch only makes sense when the group has 2+ features
  // to batch — a single-feature group has nothing to toggle in bulk, so it
  // renders the title alone.
  if (group.features.length >= 2) head.append(createGroupToggle(group));
  items.append(head);

  for (const feature of group.features) {
    items.append(createRow(feature));
    // number settings already render inside the toggle row (createInlineSettings)
    for (const setting of feature.settings ?? []) {
      if (setting.type === 'number') continue;
      items.append(createSettingRow(feature, setting));
    }
  }

  section.append(items);
  return section;
}

function getInput(featureId) {
  return listEl.querySelector(
    `.toggle-row[data-feature-id="${CSS.escape(featureId)}"] .toggle-input`,
  );
}

function getSettingControl(featureId, settingId) {
  const id = CSS.escape(featureId);
  const sid = CSS.escape(settingId);
  return listEl.querySelector(
    `.setting-select[data-feature-id="${id}"][data-setting-id="${sid}"], ` +
      `.setting-number-input[data-feature-id="${id}"][data-setting-id="${sid}"]`,
  );
}

/**
 * Re-derive every group master switch from its feature switches:
 *   all on → checked · all off → unchecked · mixed → indeterminate.
 */
function updateGroupToggleStates() {
  for (const group of FEATURE_GROUPS) {
    const input = listEl.querySelector(
      `.group-toggle-input[data-group-id="${CSS.escape(group.id)}"]`,
    );
    if (!input) continue;
    const checks = group.features.map((feature) => Boolean(getInput(feature.id)?.checked));
    const allOn = checks.length > 0 && checks.every(Boolean);
    const allOff = checks.every((on) => !on);
    input.checked = allOn;
    input.indeterminate = !allOn && !allOff;
  }
}

/**
 * Mirror the stored darkMode state onto the popup document itself.
 * The control-panel rules live in master.css under `html.pt-dark` — the same
 * class the content script toggles on the Pinterest page.
 */
function applyPopupTheme(state) {
  document.documentElement.classList.toggle('pt-dark', Boolean(state.darkMode));
}

async function syncFromStorage() {
  const state = await store.getAll(DEFAULT_STATE);

  for (const feature of FEATURES) {
    const input = getInput(feature.id);
    if (input) input.checked = Boolean(state[feature.id]);

    for (const setting of feature.settings ?? []) {
      const control = getSettingControl(feature.id, setting.id);
      if (!control) continue;
      applyControlValue(control, setting, state[settingKey(feature.id, setting.id)]);
    }
  }

  updateGroupToggleStates();
  applyPopupTheme(state);
}

/**
 * Persist one feature state and fan the change out — storage first (the single
 * source of truth), then background worker + active tab for immediate feedback.
 * @param {string} featureId
 * @param {boolean} enabled
 */
async function setFeatureEnabled(featureId, enabled) {
  // 1) Persist (single source of truth — content scripts apply via storage).
  await store.set(featureId, enabled);

  // 2) Notify the background worker (message-routing / extension point).
  try {
    await chrome.runtime.sendMessage({ type: MESSAGE_TYPE, featureId, enabled });
  } catch {
    /* optional channel — the storage change already applies everywhere */
  }

  // 3) Push directly to the active tab. If the tab has no receiver, the
  //    Pinterest page was opened before the extension was (re)loaded and
  //    needs a refresh — the storage events cover every other case.
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) await chrome.tabs.sendMessage(tab.id, { type: MESSAGE_TYPE, featureId, enabled });
  } catch {
    /* no content script in the active tab */
  }
}

/** One feature switch clicked. */
async function handleToggle(event) {
  const input = event.target;
  if (!(input instanceof HTMLInputElement) || !input.matches('.toggle-input')) return;

  await setFeatureEnabled(input.dataset.featureId, input.checked);
  updateGroupToggleStates();
}

/**
 * The master switch in a group header — applies one state to every feature of
 * the group. Mixed or all-off → switch the whole group ON; all-on → OFF
 * (standard tri-state behaviour). Like a single toggle, this just writes each
 * feature's storage key — no group state is persisted anywhere.
 */
async function handleGroupToggle(event) {
  const input = event.target;
  if (!(input instanceof HTMLInputElement) || !input.matches('.group-toggle-input')) return;

  const group = FEATURE_GROUPS.find((g) => g.id === input.dataset.groupId);
  if (!group || group.features.length === 0) return;

  const enabled = !group.features.every((feature) => Boolean(getInput(feature.id)?.checked));

  // Optimistic DOM update (the storage.onChanged handler confirms it), then
  // persist + fan out and re-derive the master switch.
  for (const feature of group.features) {
    const row = getInput(feature.id);
    if (row) row.checked = enabled;
  }
  updateGroupToggleStates();

  await Promise.allSettled(group.features.map((feature) => setFeatureEnabled(feature.id, enabled)));
  updateGroupToggleStates();
}

async function handleSettingChange(event) {
  const control = event.target;

  // Number input → persist a number (clamped to the declared range).
  if (control instanceof HTMLInputElement && control.matches('.setting-number-input')) {
    const { featureId, settingId } = control.dataset;
    const value = Number(control.value);
    if (!Number.isFinite(value)) return; // half-typed input — keep the old value
    const min = Number(control.min || 0);
    const max = Number(control.max || 100);
    await store.set(settingKey(featureId, settingId), Math.min(Math.max(value, min), max));
    return;
  }

  // Dropdown (`select`) → persist the string value.
  if (control instanceof HTMLSelectElement && control.matches('.setting-select')) {
    const { featureId, settingId } = control.dataset;
    const feature = getFeature(featureId);
    const setting = feature?.settings?.find((e) => e.id === settingId);
    const value = control.value;
    await store.set(settingKey(featureId, settingId), value);
    const label = setting?.label ?? settingId;
    const option = setting?.options?.find((e) => String(e.value) === value);
    statusEl.textContent = `${label}: ${option?.label ?? value}`;
  }
}

function init() {
  for (const group of FEATURE_GROUPS) listEl.append(createGroup(group));

  listEl.addEventListener('change', (event) => {
    const target = event.target;
    if (target instanceof HTMLInputElement && target.matches('.group-toggle-input')) {
      handleGroupToggle(event);
      return;
    }
    if (target instanceof HTMLInputElement && target.matches('.toggle-input')) {
      handleToggle(event);
      return;
    }
    if (target instanceof HTMLInputElement && target.matches('.setting-number-input')) {
      handleSettingChange(event);
      return;
    }
    if (target instanceof HTMLSelectElement && target.matches('.setting-select')) {
      handleSettingChange(event);
    }
  });

  // A marker kept hovered across a scroll would show a stale clamp —
  // re-measure while a tooltip is visible. (Capture: body's overflow
  // propagates to the viewport, so the event fires on document, not body.)
  document.addEventListener('scroll', () => {
    if (activeTooltip) clampTooltip(activeTooltip);
  }, { capture: true, passive: true });

  // Keep the popup in sync if another popup/tab changes a toggle or a setting.
  store.onChanged((changes) => {
    for (const [key, change] of Object.entries(changes)) {
      const input = getInput(key);
      if (input && typeof change.newValue === 'boolean') {
        input.checked = change.newValue;
        continue;
      }
      const parsed = parseSettingKey(key);
      if (parsed && change.newValue != null) {
        const feature = getFeature(parsed.featureId);
        const setting = feature?.settings?.find((e) => e.id === parsed.settingId);
        const control = getSettingControl(parsed.featureId, parsed.settingId);
        if (control && setting) applyControlValue(control, setting, change.newValue);
      }
    }
    updateGroupToggleStates();
    if ('darkMode' in changes) {
      applyPopupTheme({ darkMode: changes.darkMode.newValue });
    }
  });

  syncFromStorage().catch((err) => {
    console.error('[pt-tweaker] popup: failed to read state', err);
    statusEl.textContent = 'Failed to read settings';
  });
}

init();