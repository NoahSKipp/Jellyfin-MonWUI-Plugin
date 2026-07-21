// Dedicated "Recommendations" settings panel for the MonWUI settings modal.
//
// Groups the online-recommendation setup in one place: the master toggle, the
// TMDb API key, the Trending rows toggle, content-rating/runtime enrichment,
// and the certification region. Persists through the same admin settings
// channel as the Seerr/Arr panel (getSerrSettings / saveSerrSettings).

import { createSection } from "./shared.js";
import { getSerrSettings, saveSerrSettings } from "../seerr/api.js";
import { invalidateOnlineRecsAccess } from "../seerr/onlineRecs.js";

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
  setChecked("recEnableOnlineCardEnrichment", settings.enableOnlineCardEnrichment !== false);
  setValue("recOnlineContentRatingRegion", settings.onlineContentRatingRegion || "");
  setValue("recTmdbApiKey", settings.tmdbApiKey || "");

  const keyField = panel.querySelector('[name="recTmdbApiKey"]');
  if (keyField && !settings.tmdbApiKey && settings.hasTmdbApiKey) {
    keyField.placeholder = "••••••••••••••••";
  }
}

function readValues(panel) {
  const value = (name) => panel.querySelector(`[name="${name}"]`)?.value ?? "";
  const checked = (name) => panel.querySelector(`[name="${name}"]`)?.checked === true;
  return {
    enableOnlineRecommendations: checked("recEnableOnlineRecommendations"),
    enableOnlineTrendingRows: checked("recEnableOnlineTrendingRows"),
    enableOnlineCardEnrichment: checked("recEnableOnlineCardEnrichment"),
    onlineContentRatingRegion: text(value("recOnlineContentRatingRegion")).toUpperCase(),
    tmdbApiKey: value("recTmdbApiKey")
  };
}

export function createRecommendationsPanel(config, labels) {
  const panel = document.createElement("div");
  panel.id = "recommendations-panel";
  panel.className = "settings-panel";

  const section = createSection(L(labels, "recommendationsSettingsTab", "Öneriler"));

  const intro = document.createElement("div");
  intro.className = "description-text2";
  intro.style.margin = "0 0 12px";
  intro.textContent = L(
    labels,
    "recommendationsSettingsHint",
    "Yerel kütüphaneye ek olarak TMDb / Seerr üzerinden çevrimiçi öneriler getirir. İstekler için Seerr veya Radarr/Sonarr yapılandırılmış olmalıdır."
  );
  section.appendChild(intro);

  section.appendChild(createCheckboxRow(
    "recEnableOnlineRecommendations",
    L(labels, "serrEnableOnlineRecommendations", "Öneri satırlarında çevrimiçi (TMDb/Seerr) önerileri göster"),
    true
  ));
  section.appendChild(createCheckboxRow(
    "recEnableOnlineTrendingRows",
    L(labels, "enableOnlineTrendingRows", "Öne Çıkan Filmler / Diziler satırlarını göster"),
    true
  ));
  section.appendChild(createCheckboxRow(
    "recEnableOnlineCardEnrichment",
    L(labels, "enableOnlineCardEnrichment", "Çevrimiçi kartlar için içerik derecelendirmesi ve süre bilgisini getir"),
    true,
    L(labels, "enableOnlineCardEnrichmentHint", "Her başlık için ek TMDb detay çağrısı yapar (önbelleğe alınır).")
  ));
  section.appendChild(createInputRow(
    "recOnlineContentRatingRegion",
    L(labels, "onlineContentRatingRegion", "İçerik derecelendirmesi bölgesi (ör. US, TR, DE)"),
    { placeholder: "US", hint: L(labels, "onlineContentRatingRegionHint", "Boş bırakılırsa Seerr dil ayarından türetilir.") }
  ));
  section.appendChild(createInputRow(
    "recTmdbApiKey",
    L(labels, "tmdbApiKeyLabel", "TMDb API anahtarı"),
    {
      type: "password",
      placeholder: L(labels, "tmdbApiKeyPlaceholder", "TMDb v3 API anahtarı"),
      hint: L(labels, "tmdbApiKeyHint", "Çevrimiçi keşif ve zenginleştirme için kullanılır. themoviedb.org üzerinden ücretsiz alınır.")
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
