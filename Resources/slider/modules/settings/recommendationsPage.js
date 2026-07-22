// Dedicated "Recommendations" settings panel for the MonWUI settings modal.
//
// Groups the online-recommendation setup in one place: the master toggle, the
// TMDb API key, the Trending rows toggle, content-rating/runtime enrichment,
// and the certification region. Persists through the same admin settings
// channel as the Seerr/Arr panel (getSerrSettings / saveSerrSettings).

import { createSection } from "./shared.js";
import { getSerrSettings, saveSerrSettings } from "../seerr/api.js";
import { invalidateOnlineRecsAccess, getCountryList } from "../seerr/onlineRecs.js";

const MAX_POPULAR_REGIONS = 5;

function L(labels, key, fallback) {
  const value = labels?.[key];
  return typeof value === "string" && value.trim() ? value : fallback;
}

function text(value, fallback = "") {
  const out = String(value ?? "").trim();
  return out || fallback;
}

function createCheckboxRow(name, label, checked, hint = "") {
  const container = document.createElement("div");
  container.className = "setting-item";

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.name = name;
  checkbox.id = name;
  checkbox.checked = checked !== false;

  const labelEl = document.createElement("label");
  labelEl.htmlFor = name;
  labelEl.textContent = label;

  container.append(checkbox, labelEl);

  if (hint) {
    const hintEl = document.createElement("div");
    hintEl.className = "description-text2";
    hintEl.style.margin = "2px 0 0 26px";
    hintEl.textContent = hint;
    container.appendChild(hintEl);
  }
  return container;
}

function createInputRow(name, label, { type = "text", placeholder = "", hint = "" } = {}) {
  const wrap = document.createElement("div");
  wrap.className = "input-container";

  const labelEl = document.createElement("label");
  labelEl.htmlFor = name;
  labelEl.textContent = label;
  wrap.appendChild(labelEl);

  const input = document.createElement("input");
  input.id = name;
  input.name = name;
  input.type = type;
  input.autocomplete = "off";
  if (placeholder) input.placeholder = placeholder;
  wrap.appendChild(input);

  if (hint) {
    const hintEl = document.createElement("div");
    hintEl.className = "description-text2";
    hintEl.style.margin = "4px 0 0";
    hintEl.textContent = hint;
    wrap.appendChild(hintEl);
  }
  return wrap;
}

function regionDisplayName(code, labels) {
  if (String(code).toLowerCase() === "auto") {
    return L(labels, "popularRegionAuto", "Auto-detect (viewer's region)");
  }
  const cc = String(code || "").toUpperCase();
  try {
    const dn = new Intl.DisplayNames([navigator.language || "en", "en"], { type: "region" });
    return dn.of(cc) || cc;
  } catch {
    return cc;
  }
}

// Multi-country picker for the "Popular in X" rows. State lives on the element
// (__getRegions / __setRegions) so read/save can reach it like any field.
function createRegionPicker(labels) {
  const wrap = document.createElement("div");
  wrap.className = "input-container";
  wrap.dataset.regionPicker = "1";

  const labelEl = document.createElement("label");
  labelEl.textContent = L(labels, "popularRegionsLabel", "Popular in — countries");
  wrap.appendChild(labelEl);

  const chips = document.createElement("div");
  chips.className = "rec-region-chips";
  chips.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;margin:6px 0;";
  wrap.appendChild(chips);

  const controls = document.createElement("div");
  controls.style.cssText = "display:flex;gap:8px;align-items:center;flex-wrap:wrap;";
  const select = document.createElement("select");
  select.className = "rec-region-select";
  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "monwui-serr-mini-btn";
  addBtn.textContent = L(labels, "add", "Add");
  controls.append(select, addBtn);
  wrap.appendChild(controls);

  const warn = document.createElement("div");
  warn.className = "description-text2";
  warn.style.cssText = "margin:4px 0 0;color:#e5a03a;display:none;";
  warn.textContent = L(labels, "popularRegionsCapHint", "Up to 5 countries; more rows can slow the home page.");
  wrap.appendChild(warn);

  const hint = document.createElement("div");
  hint.className = "description-text2";
  hint.style.margin = "4px 0 0";
  hint.textContent = L(labels, "popularRegionsHint", "Adds a 'Popular in <country>' row for each. 'Auto-detect' uses each viewer's browser region.");
  wrap.appendChild(hint);

  const state = { codes: [] };
  let countryMap = new Map();

  const renderChips = () => {
    chips.innerHTML = "";
    state.codes.forEach((code) => {
      const chip = document.createElement("span");
      chip.className = "rec-region-chip";
      chip.style.cssText = "display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:999px;background:rgba(255,255,255,.09);font-size:.85rem;";
      const t = document.createElement("span");
      t.textContent = regionDisplayName(code, labels);
      const x = document.createElement("button");
      x.type = "button";
      x.textContent = "×";
      x.setAttribute("aria-label", L(labels, "remove", "Remove"));
      x.style.cssText = "background:none;border:0;color:inherit;cursor:pointer;font-size:1.05rem;line-height:1;padding:0;";
      x.addEventListener("click", () => {
        state.codes = state.codes.filter((c) => c !== code);
        renderChips();
        rebuildSelect();
      });
      chip.append(t, x);
      chips.appendChild(chip);
    });
    warn.style.display = state.codes.length >= MAX_POPULAR_REGIONS ? "block" : "none";
  };

  const rebuildSelect = () => {
    select.innerHTML = "";
    if (!state.codes.includes("auto")) {
      const o = document.createElement("option");
      o.value = "auto";
      o.textContent = L(labels, "popularRegionAuto", "Auto-detect (viewer's region)");
      select.appendChild(o);
    }
    for (const [code, name] of countryMap) {
      if (state.codes.includes(code)) continue;
      const o = document.createElement("option");
      o.value = code;
      o.textContent = name;
      select.appendChild(o);
    }
    const atCap = state.codes.length >= MAX_POPULAR_REGIONS;
    select.disabled = atCap;
    addBtn.disabled = atCap;
  };

  addBtn.addEventListener("click", () => {
    const code = select.value;
    if (!code || state.codes.length >= MAX_POPULAR_REGIONS || state.codes.includes(code)) return;
    state.codes.push(code);
    renderChips();
    rebuildSelect();
  });

  getCountryList()
    .then((list) => {
      countryMap = new Map((list || []).map((c) => [String(c.code).toUpperCase(), c.name]));
      rebuildSelect();
    })
    .catch(() => rebuildSelect());

  wrap.__getRegions = () => state.codes.slice();
  wrap.__setRegions = (arr) => {
    state.codes = (Array.isArray(arr) ? arr : [])
      .map((c) => (String(c).toLowerCase() === "auto" ? "auto" : String(c).toUpperCase()))
      .filter((c) => c === "auto" || /^[A-Z]{2}$/.test(c))
      .filter((c, i, a) => a.indexOf(c) === i)
      .slice(0, MAX_POPULAR_REGIONS);
    renderChips();
    rebuildSelect();
  };

  return wrap;
}

function setValues(panel, settings = {}) {
  const setChecked = (name, value) => {
    const el = panel.querySelector(`[name="${name}"]`);
    if (el) el.checked = value !== false;
  };
  const setValue = (name, value) => {
    const el = panel.querySelector(`[name="${name}"]`);
    if (el) el.value = value ?? "";
  };

  setChecked("recEnableOnlineRecommendations", settings.enableOnlineRecommendations !== false);
  setChecked("recEnableOnlineTrendingRows", settings.enableOnlineTrendingRows !== false);
  setChecked("recEnableOnlinePopularRows", settings.enableOnlinePopularRows !== false);
  setChecked("recEnableOnlineCardEnrichment", settings.enableOnlineCardEnrichment !== false);
  setValue("recOnlineContentRatingRegion", settings.onlineContentRatingRegion || "");
  setValue("recTmdbApiKey", settings.tmdbApiKey || "");

  const picker = panel.querySelector('[data-region-picker]');
  if (picker && typeof picker.__setRegions === "function") {
    const regions = Array.isArray(settings.popularRegions) && settings.popularRegions.length
      ? settings.popularRegions
      : ["auto"];
    picker.__setRegions(regions);
  }

  const keyField = panel.querySelector('[name="recTmdbApiKey"]');
  if (keyField && !settings.tmdbApiKey && settings.hasTmdbApiKey) {
    keyField.placeholder = "••••••••••••••••";
  }
}

function readValues(panel) {
  const value = (name) => panel.querySelector(`[name="${name}"]`)?.value ?? "";
  const checked = (name) => panel.querySelector(`[name="${name}"]`)?.checked === true;
  const picker = panel.querySelector('[data-region-picker]');
  const popularRegions = (picker && typeof picker.__getRegions === "function") ? picker.__getRegions() : undefined;
  return {
    enableOnlineRecommendations: checked("recEnableOnlineRecommendations"),
    enableOnlineTrendingRows: checked("recEnableOnlineTrendingRows"),
    enableOnlinePopularRows: checked("recEnableOnlinePopularRows"),
    enableOnlineCardEnrichment: checked("recEnableOnlineCardEnrichment"),
    onlineContentRatingRegion: text(value("recOnlineContentRatingRegion")).toUpperCase(),
    ...(popularRegions ? { popularRegions } : {}),
    tmdbApiKey: value("recTmdbApiKey")
  };
}

export function createRecommendationsPanel(config, labels) {
  const panel = document.createElement("div");
  panel.id = "recommendations-panel";
  panel.className = "settings-panel";

  const section = createSection(L(labels, "recommendationsSettingsTab", "Recommendations"));

  const intro = document.createElement("div");
  intro.className = "description-text2";
  intro.style.margin = "0 0 12px";
  intro.textContent = L(
    labels,
    "recommendationsSettingsHint",
    "Blend online recommendations from TMDb / Seerr into the home rows alongside your local library. Requesting missing titles needs Seerr or Radarr/Sonarr configured."
  );
  section.appendChild(intro);

  section.appendChild(createCheckboxRow(
    "recEnableOnlineRecommendations",
    L(labels, "serrEnableOnlineRecommendations", "Show online (TMDb/Seerr) recommendations in the recommendation rows"),
    true
  ));
  section.appendChild(createCheckboxRow(
    "recEnableOnlineTrendingRows",
    L(labels, "enableOnlineTrendingRows", "Show Trending Movies / Trending Series rows"),
    true
  ));
  section.appendChild(createCheckboxRow(
    "recEnableOnlinePopularRows",
    L(labels, "enableOnlinePopularRows", "Show 'Popular in <country>' rows"),
    true
  ));
  section.appendChild(createRegionPicker(labels));
  section.appendChild(createCheckboxRow(
    "recEnableOnlineCardEnrichment",
    L(labels, "enableOnlineCardEnrichment", "Fetch content rating and runtime for online cards"),
    true,
    L(labels, "enableOnlineCardEnrichmentHint", "Makes an extra TMDb detail call per title (cached).")
  ));
  section.appendChild(createInputRow(
    "recOnlineContentRatingRegion",
    L(labels, "onlineContentRatingRegion", "Content rating region (e.g. US, TR, DE)"),
    { placeholder: "US", hint: L(labels, "onlineContentRatingRegionHint", "Leave blank to derive it from the Seerr language setting.") }
  ));
  section.appendChild(createInputRow(
    "recTmdbApiKey",
    L(labels, "tmdbApiKeyLabel", "TMDb API key"),
    {
      type: "password",
      placeholder: L(labels, "tmdbApiKeyPlaceholder", "TMDb v3 API key"),
      hint: L(labels, "tmdbApiKeyHint", "Used for online discovery and enrichment. Get one for free at themoviedb.org.")
    }
  ));

  panel.appendChild(section);

  let loaded = false;

  panel.__monwuiLoad = async () => {
    const data = await getSerrSettings().catch(() => null);
    if (data?.settings) {
      setValues(panel, data.settings);
      loaded = true;
    }
  };

  panel.__monwuiSave = async () => {
    // Never persist unloaded defaults; that would wipe the stored TMDb key.
    if (!loaded) return;
    await saveSerrSettings(readValues(panel));
    try { invalidateOnlineRecsAccess(); } catch {}
  };

  setTimeout(() => {
    panel.__monwuiLoad?.().catch(() => {});
  }, 0);

  return panel;
}
