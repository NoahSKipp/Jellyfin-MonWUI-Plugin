import {
  approveSerrRequest,
  declineSerrRequest,
  getSerrMovieDetails,
  getSerrTvDetails,
  listSerrRequests,
  withdrawSerrRequest
} from "./api.js";
import { getConfig } from "../config.js";
import { getEffectiveLanguage, getLanguageLabels } from "../../language/index.js";
import { requestMovieFromArr } from "../arr/requestFallback.js";
import { getArrCalendar } from "../arr/api.js";
import { showNotification } from "../player/ui/notification.js";

let cachedCount = 0;
let cachedRequests = [];
let lastIsAdmin = false;
let managerRequests = [];
let managerIsAdmin = false;
let managerRefreshPromise = null;
let refreshPromise = null;
let pollTimer = 0;
let pollEventsBound = false;
let pollEnabled = false;
const ACTIVE_DOWNLOAD_POLL_MS = 2_000;
const OPEN_IDLE_POLL_MS = 5_000;
const BACKGROUND_POLL_MS = 15_000;
const SERR_IMAGE_BASE = "https://image.tmdb.org/t/p";
const CALENDAR_IMAGE_READY_TIMEOUT_MS = 3500;
const posterCache = new Map();
const posterPromises = new Map();

function currentUserId() {
  try { return text(window.ApiClient?.getCurrentUserId?.()); } catch {}
  try { return text(window.ApiClient?._currentUserId); } catch {}
  try { return text(window.ApiClient?._currentUser?.Id || window.ApiClient?._currentUser?.id); } catch {}
  try { return text(sessionStorage.getItem("currentUserId") || localStorage.getItem("currentUserId")); } catch {}
  return "";
}

function seenStorageKey() {
  return `jf:serrSeenRequests:${currentUserId() || "nouser"}`;
}

function readSeenRequestKeys() {
  try {
    const raw = localStorage.getItem(seenStorageKey());
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.map((value) => text(value)).filter(Boolean) : []);
  } catch {
    return new Set();
  }
}

function writeSeenRequestKeys(keys) {
  try {
    localStorage.setItem(seenStorageKey(), JSON.stringify(Array.from(keys || []).filter(Boolean)));
  } catch {}
}

function labels() {
  try {
    const activeLabels = getLanguageLabels?.(getEffectiveLanguage?.()) || {};
    if (Object.keys(activeLabels).length) return activeLabels;
  } catch {}
  try { return getConfig()?.languageLabels || {}; } catch { return {}; }
}

function moduleEnabled() {
  try { return getConfig()?.enableSerrArrIntegrationModule !== false; } catch { return true; }
}

function L(key, fallback) {
  const value = labels()?.[key];
  return typeof value === "string" && value.trim() ? value : fallback;
}

function text(value, fallback = "") {
  const out = String(value ?? "").trim();
  return out || fallback;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (m) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  }[m]));
}

function serrLanguage() {
  try {
    const cfg = getConfig?.() || {};
    return text(cfg.serrDefaultLanguage || cfg.defaultLanguage || "");
  } catch {
    return "";
  }
}

function readFirst(source, ...keys) {
  if (!source || typeof source !== "object") return undefined;
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null) return source[key];
  }
  return undefined;
}

function imageUrl(path, size = "w342") {
  const clean = text(path);
  if (!clean) return "";
  if (/^https?:\/\//i.test(clean)) return clean;
  return `${SERR_IMAGE_BASE}/${size}${clean.startsWith("/") ? clean : `/${clean}`}`;
}

function requestMediaType(req) {
  const type = text(req?.MediaType || req?.mediaType).toLowerCase();
  return type === "tv" || type === "series" || type === "show" || type === "tvshow" ? "tv" : "movie";
}

function requestMediaId(req) {
  const id = Number(req?.MediaId || req?.mediaId || 0);
  return Number.isFinite(id) && id > 0 ? Math.floor(id) : 0;
}

function requestIs4K(req) {
  const value = req?.Is4K ?? req?.is4K ?? req?.is4k;
  if (value === true || value === 1) return true;
  return text(value).toLowerCase() === "true";
}

function renderRequest4KBadge(req) {
  if (!requestIs4K(req)) return "";
  const label = L("serrRequest4KBadge", "4K");
  return `<span class="monwui-serr-4k-badge" title="${escapeHtml(label)}">${escapeHtml(label)}</span>`;
}

function requestNotificationKey(req) {
  const id = text(req?.Id || req?.id);
  if (id) return id;
  return [
    requestMediaType(req),
    requestMediaId(req),
    text(req?.CreatedAtUtc || req?.createdAtUtc),
    text(req?.Title || req?.title)
  ].filter(Boolean).join(":");
}

function posterCacheKey(req) {
  const id = requestMediaId(req);
  if (!id) return "";
  return `${requestMediaType(req)}:${id}`;
}

function directPosterUrl(req) {
  return imageUrl(readFirst(req, "PosterUrl", "posterUrl", "PosterPath", "posterPath", "poster_path", "image", "Image"));
}

async function resolvePosterUrl(req) {
  const direct = directPosterUrl(req);
  if (direct) return direct;

  const key = posterCacheKey(req);
  if (!key) return "";
  if (posterCache.has(key)) return posterCache.get(key) || "";
  if (posterPromises.has(key)) return posterPromises.get(key);

  const job = (async () => {
    const id = requestMediaId(req);
    const mediaType = requestMediaType(req);
    const language = serrLanguage();
    const details = mediaType === "tv"
      ? await getSerrTvDetails(id, { language }).catch(() => null)
      : await getSerrMovieDetails(id, { language }).catch(() => null);
    const poster = imageUrl(readFirst(details, "posterPath", "poster_path", "PosterPath"));
    posterCache.set(key, poster || "");
    return poster || "";
  })().finally(() => {
    posterPromises.delete(key);
  });

  posterPromises.set(key, job);
  return job;
}

function posterFallbackLabel(req) {
  return requestMediaType(req) === "tv" ? L("serrTv", "Dizi") : L("serrMovie", "Film");
}

function renderPoster(req, className = "") {
  const direct = directPosterUrl(req);
  const key = posterCacheKey(req);
  const cached = key ? posterCache.get(key) : "";
  const url = direct || cached || "";
  const title = text(req?.Title || req?.title, L("serrUntitled", "İçerik"));
  const label = posterFallbackLabel(req);
  const attrs = [
    `class="monwui-serr-poster ${escapeHtml(className)}"`,
    key ? `data-serr-art-key="${escapeHtml(key)}"` : "",
    direct ? `data-serr-art-ready="1"` : "",
  ].filter(Boolean).join(" ");

  return `
    <div ${attrs}>
      ${url
        ? `<img src="${escapeHtml(url)}" alt="${escapeHtml(title)}" loading="lazy" decoding="async">`
        : `<div class="monwui-serr-poster-fallback"><i class="fas fa-clapperboard" aria-hidden="true"></i><span>${escapeHtml(label)}</span></div>`}
    </div>
  `;
}

function hydrateRequestPosters(scope = document) {
  const nodes = Array.from(scope.querySelectorAll?.(".monwui-serr-poster[data-serr-art-key]:not([data-serr-art-ready='1'])") || []);
  if (!nodes.length) return;

  for (const node of nodes) {
    const key = text(node.getAttribute("data-serr-art-key"));
    const req = [...cachedRequests, ...managerRequests].find((entry) => posterCacheKey(entry) === key);
    if (!req) continue;

    resolvePosterUrl(req).then((url) => {
      if (!url || !node.isConnected || node.getAttribute("data-serr-art-ready") === "1") return;
      const title = text(req?.Title || req?.title, L("serrUntitled", "İçerik"));
      node.innerHTML = `<img src="${escapeHtml(url)}" alt="${escapeHtml(title)}" loading="lazy" decoding="async">`;
      node.setAttribute("data-serr-art-ready", "1");
    }).catch(() => {});
  }
}

function formatTime(ts) {
  const n = Number(ts || 0);
  if (!Number.isFinite(n) || n <= 0) return "";
  try {
    return new Date(n).toLocaleString(labels()?.timeLocale || undefined);
  } catch {
    return "";
  }
}

function ensureSerrProgressStyles() {
  const id = "monwui-serr-download-progress-styles";
  if (document.getElementById(id)) return;
  const style = document.createElement("style");
  style.id = id;
  style.textContent = `
    #jfNotifModal .monwui-serr-download,
    .monwui-serr-requests-modal .monwui-serr-download {
      display: grid;
      gap: 5px;
      margin-top: 4px;
      min-width: 0;
    }
    #jfNotifModal .monwui-serr-download-line,
    .monwui-serr-requests-modal .monwui-serr-download-line {
      align-items: center;
      color: var(--jf-notif-text-dim, var(--nft-text-secondary, rgba(255,255,255,.68)));
      display: flex;
      flex-wrap: wrap;
      font-size: 12px;
      gap: 6px;
      line-height: 1.35;
      min-width: 0;
    }
    #jfNotifModal .monwui-serr-download-line b,
    .monwui-serr-requests-modal .monwui-serr-download-line b {
      color: var(--jf-notif-text, var(--nft-text-primary, #fff));
      font-weight: 800;
    }
    #jfNotifModal .monwui-serr-download-track,
    .monwui-serr-requests-modal .monwui-serr-download-track {
      background: color-mix(in srgb, var(--jf-notif-accent, var(--notif-accent, #6aa6ff)) 18%, transparent);
      border: 1px solid color-mix(in srgb, var(--jf-notif-accent, var(--notif-accent, #6aa6ff)) 26%, transparent);
      border-radius: 999px;
      height: 7px;
      overflow: hidden;
      width: 100%;
    }
    #jfNotifModal .monwui-serr-download-bar,
    .monwui-serr-requests-modal .monwui-serr-download-bar {
      background: var(--jf-notif-accent, var(--notif-accent, #6aa6ff));
      border-radius: inherit;
      height: 100%;
      min-width: 2px;
      transition: width .25s ease;
    }
    #jfNotifModal .monwui-serr-4k-badge,
    .monwui-serr-requests-modal .monwui-serr-4k-badge {
      align-items: center;
      background: color-mix(in srgb, var(--jf-notif-warning, var(--ntf-warning, #ffbf5f)) 84%, #fff);
      border: 1px solid color-mix(in srgb, var(--jf-notif-warning, var(--ntf-warning, #ffbf5f)) 72%, #111);
      border-radius: 6px;
      color: #111;
      display: inline-flex;
      font-size: 11px;
      font-weight: 900;
      justify-content: center;
      letter-spacing: 0;
      line-height: 1;
      padding: 3px 7px;
      white-space: nowrap;
    }
  `;
  document.head.appendChild(style);
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function dateKey(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function startOfMonth(date = new Date()) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function addDays(date, days) {
  const out = new Date(date);
  out.setDate(out.getDate() + days);
  return out;
}

function addMonths(date, months) {
  return new Date(date.getFullYear(), date.getMonth() + months, 1);
}

function calendarRange(monthDate) {
  const first = startOfMonth(monthDate);
  const mondayOffset = (first.getDay() + 6) % 7;
  const start = addDays(first, -mondayOffset);
  return { start, end: addDays(start, 41) };
}

function parseEventDate(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function monthTitle(date) {
  try {
    return date.toLocaleDateString(labels()?.timeLocale || undefined, { month: "long", year: "numeric" });
  } catch {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`;
  }
}

function weekdayLabels() {
  const base = new Date(2024, 0, 1);
  return Array.from({ length: 7 }, (_, index) => {
    try {
      return addDays(base, index).toLocaleDateString(labels()?.timeLocale || undefined, { weekday: "short" });
    } catch {
      return ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][index];
    }
  });
}

function calendarStatusLabel(status) {
  switch (text(status).toLowerCase()) {
    case "available": return L("serrStatusCompleted", "Tamamlandı");
    case "missing": return L("serrCalendarMissing", "Eksik");
    case "unmonitored": return L("serrCalendarUnmonitored", "İzlenmiyor");
    case "upcoming":
    default: return L("serrCalendarUpcoming", "Yakında");
  }
}

function calendarReleaseLabel(type) {
  switch (text(type).toLowerCase()) {
    case "air": return L("episode", "Bölüm");
    case "cinema": return L("serrCalendarCinema", "Sinema");
    case "digital": return L("serrCalendarDigital", "Dijital");
    case "physical": return L("serrCalendarPhysical", "Fiziksel");
    case "release": return L("serrCalendarRelease", "Yayın");
    default: return "";
  }
}

function ensureSerrCalendarStyles() {
  const id = "monwui-serr-calendar-styles";
  if (document.getElementById(id)) return;
  const style = document.createElement("style");
  style.id = id;
  style.textContent = `
    #jfNotifModal .monwui-serr-notif-tools {
      gap: 8px;
    }
    #jfNotifModal .monwui-serr-calendar-btn,
    #jfNotifModal .monwui-serr-manage-btn {
      align-items: center;
      display: inline-flex;
      gap: 7px;
      justify-content: center;
      font-size: 0.875rem;
    }
    #jfNotifModal .monwui-serr-calendar-btn {
        background: var(--ntf-btn-bg, var(--jf-notif-hover, var(--panel-bg, rgba(255,255,255,.08))));
        border: 1px solid var(--ntf-divider, var(--jf-notif-border, rgba(255,255,255,.12)));
        border-radius: var(--ntf-radius-sm, 8px);
        color: var(--ntf-btn-text, var(--jf-notif-text, #fff));
        cursor: pointer;
        min-height: 32px;
        padding: 6px 10px;
        display: flex;
        flex-direction: row;
        align-items: center;
    }
    .monwui-serr-calendar-btn i,.monwui-serr-calendar-btn span {
        padding: 0;
        margin: 0;
        text-align: center;
    }
    #jfNotifModal .monwui-serr-calendar-btn:hover {
      background: var(--ntf-btn-hover, var(--jf-notif-card-bg-hover, rgba(255,255,255,.12)));
    }
    .monwui-serr-calendar-modal {
      box-sizing: border-box;
      display: none;
      inset: 0;
      overflow: auto;
      padding: 16px;
      position: fixed;
      z-index: 10002;
    }
    .monwui-serr-calendar-modal.open {
      align-items: flex-start;
      display: flex;
      justify-content: center;
    }
    .monwui-serr-calendar-backdrop {
      background: rgba(0,0,0,.52);
      inset: 0;
      position: absolute;
    }
    .monwui-serr-calendar-dialog {
      background: var(--jf-notif-bg, var(--panel-bg, #151924));
      border: 1px solid var(--jf-notif-border, var(--border-color, rgba(255,255,255,.12)));
      border-radius: 12px;
      box-shadow: var(--jf-notif-shadow, 0 24px 70px rgba(0,0,0,.38));
      color: var(--jf-notif-text, var(--nft-text-primary, #fff));
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
      margin: auto 0;
      max-height: calc(100dvh - 32px);
      overflow: hidden;
      position: relative;
      width: min(980px, calc(100vw - 28px));
    }
    .monwui-serr-calendar-head {
      align-items: center;
      border-bottom: 1px solid var(--jf-notif-border, var(--border-color, rgba(255,255,255,.1)));
      display: grid;
      gap: 10px;
      grid-template-columns: auto auto minmax(0, 1fr) auto auto;
      padding: 12px 14px;
    }
    .monwui-serr-calendar-title {
      font-size: 17px;
      font-weight: 800;
      overflow-wrap: anywhere;
      text-align: center;
    }
    .monwui-serr-calendar-nav,
    .monwui-serr-calendar-close {
      align-items: center;
      background: var(--jf-notif-hover, var(--head-bg, rgba(255,255,255,.08)));
      border: 1px solid var(--jf-notif-border, var(--border-color, rgba(255,255,255,.12)));
      border-radius: 8px;
      color: inherit;
      cursor: pointer;
      display: inline-flex;
      height: 34px;
      justify-content: center;
      width: 34px;
    }
    .monwui-serr-calendar-nav:hover,
    .monwui-serr-calendar-close:hover {
      border-color: var(--jf-notif-accent, var(--notif-accent, #60a5fa));
      color: var(--jf-notif-accent, var(--notif-accent, #60a5fa));
    }
    .monwui-serr-calendar-body {
      display: grid;
      gap: 10px;
      min-height: 0;
      overflow: auto;
      padding: 12px;
      scrollbar-color: var(--jf-notif-accent, var(--notif-accent, #60a5fa)) transparent;
      scrollbar-width: thin;
    }
    .monwui-serr-calendar-legend {
      align-items: center;
      color: var(--jf-notif-subtext, var(--nft-text-secondary, rgba(255,255,255,.68)));
      display: flex;
      flex-wrap: wrap;
      font-size: 12px;
      gap: 10px;
    }
    .monwui-serr-calendar-legend span {
      align-items: center;
      display: inline-flex;
      gap: 6px;
    }
    .monwui-serr-calendar-dot {
      background: var(--dot-bg, var(--dot, var(--jf-notif-accent, #60a5fa)));
      border-radius: 999px;
      display: inline-block;
      height: 7px;
      width: 7px;
    }
    .monwui-serr-calendar-dot.is-split {
      background: linear-gradient(135deg,
        var(--dot-service, #60a5fa) 0 48%,
        rgba(255,255,255,.42) 48% 52%,
        var(--dot-status, #94a3b8) 52% 100%);
    }
    .monwui-serr-calendar-grid {
      display: grid;
      gap: 6px;
      grid-template-columns: repeat(7, minmax(42px, 1fr));
      overflow: visible;
    }
    .monwui-serr-calendar-weekday {
      color: var(--jf-notif-subtext, var(--nft-text-secondary, rgba(255,255,255,.68)));
      font-size: 11px;
      font-weight: 800;
      padding: 0 4px 2px;
      text-align: center;
      text-transform: uppercase;
    }
    .monwui-serr-calendar-day {
      background: var(--jf-notif-card-bg, var(--head-bg, rgba(255,255,255,.04)));
      border: 1px solid var(--jf-notif-border, var(--border-color, rgba(255,255,255,.1)));
      border-radius: 8px;
      min-height: clamp(62px, 10vh, 86px);
      overflow: visible;
      padding: 7px;
      position: relative;
    }
    .monwui-serr-calendar-day:hover,
    .monwui-serr-calendar-day:focus-within,
    .monwui-serr-calendar-day.is-open {
      z-index: 20;
    }
    .monwui-serr-calendar-day.is-muted {
      opacity: 1;
    }
    .monwui-serr-calendar-day.is-muted .monwui-serr-calendar-number,
    .monwui-serr-calendar-day.is-muted .monwui-serr-calendar-dot,
    .monwui-serr-calendar-day.is-muted .monwui-serr-calendar-more {
      opacity: .48;
    }
    .monwui-serr-calendar-day.is-muted .monwui-serr-calendar-popover {
      opacity: 1;
    }
    .monwui-serr-calendar-day.is-today {
      border-color: var(--jf-notif-accent, var(--notif-accent, #60a5fa));
    }
    .monwui-serr-calendar-number {
      color: var(--jf-notif-text, var(--nft-text-primary, #fff));
      font-size: 12px;
      font-weight: 800;
    }
    .monwui-serr-calendar-dots {
      align-items: center;
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      margin-top: 8px;
    }
    .monwui-serr-calendar-dot-wrap {
      align-items: center;
      cursor: pointer;
      display: inline-flex;
      height: 16px;
      justify-content: center;
      position: relative;
      width: 16px;
    }
    .monwui-serr-calendar-more {
      color: var(--jf-notif-subtext, var(--nft-text-secondary, rgba(255,255,255,.68)));
      font-size: 10px;
      line-height: 1;
    }
    .monwui-serr-calendar-popover {
      -webkit-backdrop-filter: blur(12px);
      backdrop-filter: blur(12px);
      background: transparent;
      border: 1px solid rgba(255,255,255,.18);
      border-radius: 10px;
      box-shadow: 0 18px 40px rgba(0,0,0,.34);
      color: var(--jf-notif-subtext, rgba(255,255,255,.68));
      display: none;
      gap: 8px;
      isolation: isolate;
      left: 50%;
      min-width: min(310px, calc(100vw - 40px));
      overflow: hidden;
      padding: 10px;
      position: absolute;
      top: calc(100% - 1px);
      transform: translateX(-50%);
      width: min(360px, calc(100vw - 40px));
      z-index: 40;
    }
    .monwui-serr-calendar-popover-bg {
      inset: -18px;
      opacity: .28;
      overflow: hidden;
      pointer-events: none;
      position: absolute;
      z-index: 0;
    }
    .monwui-serr-calendar-popover-bg img {
      filter: blur(12px) saturate(1.12) contrast(1.04);
      height: 100%;
      object-fit: cover;
      transform: scale(1.08);
      width: 100%;
    }
    .monwui-serr-calendar-day.is-left-edge .monwui-serr-calendar-popover {
      left: 0;
      transform: none;
    }
    .monwui-serr-calendar-day.is-right-edge .monwui-serr-calendar-popover {
      left: auto;
      right: 0;
      transform: none;
    }
    .monwui-serr-calendar-day.is-bottom-row .monwui-serr-calendar-popover {
      bottom: calc(100% - 1px);
      top: auto;
    }
    .monwui-serr-calendar-dot-wrap.is-ready:hover .monwui-serr-calendar-popover,
    .monwui-serr-calendar-dot-wrap.is-ready.is-open .monwui-serr-calendar-popover {
      display: grid;
      z-index: 999;
    }
    .monwui-serr-calendar-event {
      display: grid;
      gap: 10px;
      grid-template-columns: 54px minmax(0, 1fr);
      position: relative;
      z-index: 1;
    }
    .monwui-serr-calendar-links {
      align-items: center;
      display: flex;
      flex-wrap: wrap;
      gap: 7px;
      justify-content: center;
      margin-top: 8px;
    }
    .monwui-serr-calendar-link {
      align-items: center;
      background: rgba(255,255,255,.12);
      border: 1px solid rgba(255,255,255,.18);
      border-radius: 8px;
      box-sizing: border-box;
      display: inline-flex;
      height: 28px;
      justify-content: center;
      padding: 5px;
      transition: background .16s ease,border-color .16s ease,transform .16s ease;
      width: 28px;
    }
    .monwui-serr-calendar-link:hover,
    .monwui-serr-calendar-link:focus-visible {
      background: rgba(255,255,255,.2);
      border-color: rgba(255,255,255,.34);
      outline: none;
      transform: translateY(-1px);
    }
    .monwui-serr-calendar-link img {
      display: block;
      max-height: 18px;
      max-width: 18px;
      object-fit: contain;
    }
    .monwui-serr-calendar-event-poster {
      align-items: center;
      aspect-ratio: 2 / 3;
      background: color-mix(in srgb, var(--jf-notif-accent, #60a5fa) 18%, transparent);
      border: 1px solid var(--jf-notif-border, rgba(255,255,255,.12));
      border-radius: 7px;
      color: var(--jf-notif-subtext, rgba(255,255,255,.68));
      display: flex;
      justify-content: center;
      overflow: hidden;
      width: 54px;
    }
    .monwui-serr-calendar-event-poster img {
      display: block;
      height: 100%;
      object-fit: cover;
      width: 100%;
    }
    .monwui-serr-calendar-event-poster i {
      font-size: 18px;
    }
    .monwui-serr-calendar-event strong,
    .monwui-serr-calendar-event small {
      overflow-wrap: anywhere;
    }
    .monwui-serr-calendar-event strong {
      color: var(--jf-notif-text, var(--nft-text-primary, #fff));
      font-size: 13px;
      line-height: 1.25;
      display: flex;
      text-align: center;
      align-items: center;
      justify-content: center;
    }
    .monwui-serr-calendar-event small {
      color: var(--jf-notif-subtext, var(--nft-text-secondary, rgba(255,255,255,.68)));
      color: var(--jf-notif-subtext, rgba(255,255,255,.68));
      font-size: 11px;
      line-height: 1.35;
      display: flex;
      padding: 10px;
      justify-content: center;
      align-items: center;
    }
    .monwui-serr-calendar-loading,
    .monwui-serr-calendar-empty,
    .monwui-serr-calendar-error {
      color: var(--jf-notif-subtext, var(--nft-text-secondary, rgba(255,255,255,.68)));
      padding: 28px;
      text-align: center;
    }
    .monwui-serr-calendar-error {
      color: #ef4444;
    }
    @media (max-width: 640px) {
      .monwui-serr-calendar-dialog {
        border-radius: 0;
        height: 100dvh;
        max-height: 100dvh;
        width: 100vw;
      }
      .monwui-serr-calendar-modal {
        padding: 0;
      }
      .monwui-serr-calendar-head {
        align-items: center;
        gap: 6px;
        display: flex;
        justify-content: space-between;
        min-height: 48px;
        padding: calc(7px + env(safe-area-inset-top)) max(8px, env(safe-area-inset-right)) 7px max(8px, env(safe-area-inset-left));
      }
      .monwui-serr-calendar-title {
        font-size: 14px;
        line-height: 1.15;
        min-width: 0;
        overflow: hidden;
        overflow-wrap: normal;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .monwui-serr-calendar-nav,
      .monwui-serr-calendar-close {
        box-sizing: border-box;
        font-size: 14px;
        height: 32px;
        line-height: 1;
        min-height: 0 !important;
        min-width: 0 !important;
        padding: 0 !important;
        width: 32px;
      }
      .monwui-serr-calendar-close {
        font-size: 19px;
      }
      .monwui-serr-calendar-body {
        gap: 6px;
        grid-template-rows: auto minmax(0, 1fr);
        overflow: auto;
        padding: 8px;
      }
      .monwui-serr-calendar-legend {
        flex-wrap: wrap;
        gap: 6px;
        margin: 0 -8px;
        overflow-x: auto;
        overflow-y: hidden;
        padding: 0 8px 4px;
        scrollbar-width: none;
        white-space: nowrap;
        align-items: center;
        justify-content: center;
        align-content: center;
      }
      .monwui-serr-calendar-legend::-webkit-scrollbar {
        display: none;
      }
      .monwui-serr-calendar-legend > span {
        flex: 0 0 auto;
        font-size: 10px;
        gap: 4px;
        line-height: 1;
        padding: 5px 7px;
      }
      .monwui-serr-calendar-grid {
        gap: 3px;
        grid-template-columns: repeat(7, minmax(0, 1fr));
        min-width: 0;
        overflow: visible;
        padding: 12px;
      }
      .monwui-serr-calendar-weekday {
        font-size: 9px;
        padding: 0 1px 1px;
      }
      .monwui-serr-calendar-day {
        border-radius: 6px;
        min-height: 49px;
        min-width: 0;
        padding: 4px 3px;
      }
      .monwui-serr-calendar-number {
        font-size: 11px;
        line-height: 1;
      }
      .monwui-serr-calendar-dots {
        gap: 1px;
        margin-top: 5px;
      }
      .monwui-serr-calendar-dot-wrap {
        height: 12px;
        width: 12px;
      }
      .monwui-serr-calendar-dot {
        height: 6px;
        width: 6px;
      }
      .monwui-serr-calendar-more {
        font-size: 9px;
      }
      .monwui-serr-calendar-popover {
        min-width: min(280px, calc(100vw - 24px));
        width: min(320px, calc(100vw - 24px));
      }
      .monwui-serr-calendar-event {
        grid-template-columns: 46px minmax(0, 1fr);
      }
      .monwui-serr-calendar-event-poster {
        width: 46px;
      }
    }
  `;
  document.head.appendChild(style);
}

function calendarServiceColor(service) {
  return text(service).toLowerCase() === "radarr" ? "#f59e0b" : "#60a5fa";
}

function calendarServiceLabel(service) {
  return text(service).toLowerCase() === "radarr"
    ? L("serrCalendarRadarr", "Radarr")
    : L("serrCalendarSonarr", "Sonarr");
}

function normalizeCalendarStatusKey(status) {
  switch (text(status).toLowerCase()) {
    case "available":
    case "completed":
      return "completed";
    case "missing":
      return "missing";
    case "processing":
      return "processing";
    case "approved":
      return "approved";
    case "pending":
      return "pending";
    case "requested":
      return "requested";
    case "unmonitored":
      return "unmonitored";
    case "declined":
      return "declined";
    case "failed":
      return "failed";
    case "withdrawn":
      return "withdrawn";
    case "upcoming":
    default:
      return "upcoming";
  }
}

function calendarNumericId(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function findCalendarRequest(event) {
  const mediaType = calendarMediaType(event);
  const tmdbId = calendarNumericId(readFirst(event, "tmdbId", "TmdbId"));
  const tvdbId = calendarNumericId(readFirst(event, "tvdbId", "TvdbId"));
  const requests = cachedRequests;

  return requests.find((req) => {
    if (requestMediaType(req) !== mediaType) return false;
    if (mediaType === "movie") return tmdbId > 0 && requestMediaId(req) === tmdbId;
    const reqTvdbId = calendarNumericId(readFirst(req, "TvdbId", "tvdbId"));
    return (tvdbId > 0 && reqTvdbId === tvdbId) || (tmdbId > 0 && requestMediaId(req) === tmdbId);
  }) || null;
}

function calendarRequestStatus(event) {
  const cached = findCalendarRequest(event);
  return text(readFirst(cached, "Status", "status") || readFirst(event, "requestStatus", "RequestStatus"));
}

function calendarDotStatusKey(event) {
  const requestStatus = calendarRequestStatus(event);
  if (requestStatus) return normalizeCalendarStatusKey(requestStatus);
  return normalizeCalendarStatusKey(readFirst(event, "status", "Status"));
}

function calendarStatusColor(status) {
  switch (normalizeCalendarStatusKey(status)) {
    case "completed": return "#22c55e";
    case "missing": return "#ef4444";
    case "processing": return "#a855f7";
    case "approved": return "#14b8a6";
    case "pending": return "#facc15";
    case "requested": return "#38bdf8";
    case "unmonitored": return "#94a3b8";
    case "declined": return "#fb7185";
    case "failed": return "#dc2626";
    case "withdrawn": return "#64748b";
    case "upcoming":
    default: return "#c084fc";
  }
}

function calendarDotStyle(event) {
  return `--dot-service:${calendarServiceColor(event?.service)};--dot-status:${calendarStatusColor(calendarDotStatusKey(event))};`;
}

function calendarLegendDot(label, color) {
  const safeColor = escapeHtml(color);
  return `<span><span class="monwui-serr-calendar-dot" style="--dot:${safeColor};--dot-bg:${safeColor};background:${safeColor};background-color:${safeColor}"></span>${escapeHtml(label)}</span>`;
}

function calendarLegendHtml() {
  return [
    calendarLegendDot(calendarServiceLabel("sonarr"), calendarServiceColor("sonarr")),
    calendarLegendDot(calendarServiceLabel("radarr"), calendarServiceColor("radarr")),
    calendarLegendDot(L("serrCalendarMissing", "Eksik"), calendarStatusColor("missing")),
    calendarLegendDot(L("serrCalendarUpcoming", "Yakında"), calendarStatusColor("upcoming")),
    calendarLegendDot(statusLabel("pending"), calendarStatusColor("pending")),
    calendarLegendDot(statusLabel("approved"), calendarStatusColor("approved")),
    calendarLegendDot(statusLabel("processing"), calendarStatusColor("processing")),
    calendarLegendDot(statusLabel("completed"), calendarStatusColor("completed")),
    calendarLegendDot(L("serrCalendarUnmonitored", "İzlenmiyor"), calendarStatusColor("unmonitored"))
  ].join("");
}

function servicePopoverClass(service) {
  return text(service).toLowerCase() === "radarr" ? "is-radarr" : "is-sonarr";
}

function calendarPosterUrl(event) {
  return imageUrl(readFirst(event, "posterUrl", "posterPath", "poster_path", "image", "thumbnail"), "w185");
}

const CALENDAR_ICON_BASE = "./slider/src/images/";

function safeExternalUrl(value) {
  const clean = text(value);
  return /^https?:\/\//i.test(clean) ? clean : "";
}

function calendarId(value) {
  const clean = text(value);
  if (!clean || clean === "0") return "";
  return clean;
}

function calendarMediaType(event) {
  return text(readFirst(event, "mediaType", "MediaType")).toLowerCase() === "tv" ? "tv" : "movie";
}

function calendarProviderUrl(provider, id, mediaType) {
  const cleanId = calendarId(id);
  if (!cleanId) return "";
  const encoded = encodeURIComponent(cleanId);
  switch (provider) {
    case "imdb":
      return `https://www.imdb.com/title/${encoded}/`;
    case "tmdb":
      return `https://www.themoviedb.org/${mediaType === "tv" ? "tv" : "movie"}/${encoded}`;
    case "tvdb":
      return `https://www.thetvdb.com/dereferrer/${mediaType === "tv" ? "series" : "movie"}/${encoded}`;
    default:
      return "";
  }
}

function calendarIconLink({ key, label, url }) {
  const cleanUrl = safeExternalUrl(url);
  if (!cleanUrl) return "";
  const cleanKey = text(key).toLowerCase();
  const cleanLabel = text(label, cleanKey.toUpperCase());
  return `
    <a class="monwui-serr-calendar-link ${escapeHtml(cleanKey)}" href="${escapeHtml(cleanUrl)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(cleanLabel)}" aria-label="${escapeHtml(cleanLabel)}">
      <img src="${CALENDAR_ICON_BASE}${escapeHtml(cleanKey)}.svg" alt="">
    </a>
  `;
}

function renderCalendarLinks(event) {
  const mediaType = calendarMediaType(event);
  const service = text(readFirst(event, "service", "Service")).toLowerCase();
  const links = [];
  const arrUrl = safeExternalUrl(readFirst(event, "arrUrl", "ArrUrl"));
  const serrUrl = safeExternalUrl(readFirst(event, "serrUrl", "SerrUrl"));
  const tmdbId = calendarId(readFirst(event, "tmdbId", "TmdbId"));
  const imdbId = calendarId(readFirst(event, "imdbId", "ImdbId"));
  const tvdbId = calendarId(readFirst(event, "tvdbId", "TvdbId"));

  if (arrUrl) {
    links.push(calendarIconLink({
      key: service === "radarr" ? "radarr" : "sonarr",
      label: calendarServiceLabel(service),
      url: arrUrl
    }));
  }
  if (serrUrl) links.push(calendarIconLink({ key: "seerr", label: "Seerr", url: serrUrl }));
  if (tmdbId) links.push(calendarIconLink({ key: "tmdb", label: "TMDb", url: calendarProviderUrl("tmdb", tmdbId, mediaType) }));
  if (imdbId) links.push(calendarIconLink({ key: "imdb", label: "IMDb", url: calendarProviderUrl("imdb", imdbId, mediaType) }));
  if (tvdbId) links.push(calendarIconLink({ key: "tvdb", label: "TVDb", url: calendarProviderUrl("tvdb", tvdbId, mediaType) }));

  const html = links.filter(Boolean).join("");
  return html ? `<span class="monwui-serr-calendar-links">${html}</span>` : "";
}

function normalizedCalendarText(value) {
  return text(value)
    .toLowerCase()
    .replace(/[•|/\\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function pushUniqueCalendarPart(parts, value) {
  const clean = text(value);
  if (!clean) return;
  const normalized = normalizedCalendarText(clean);
  if (!normalized || parts.some((part) => normalizedCalendarText(part) === normalized)) return;
  parts.push(clean);
}

function calendarSubtitle(event, service, title) {
  let subtitle = text(event?.subtitle);
  if (!subtitle) return "";
  if (subtitle.toLowerCase().startsWith(service.toLowerCase())) {
    subtitle = subtitle.slice(service.length).replace(/^\s*(?:[•:|/\\-]\s*)?/, "").trim();
  }
  if (!subtitle) return "";
  const normalizedSubtitle = normalizedCalendarText(subtitle);
  const normalizedTitle = normalizedCalendarText(title);
  if (normalizedSubtitle && normalizedTitle.includes(normalizedSubtitle)) return "";
  return subtitle;
}

function renderCalendarEvent(event) {
  const service = calendarServiceLabel(event?.service);
  const status = calendarStatusLabel(event?.status);
  const release = calendarReleaseLabel(event?.releaseType);
  const requestStatusValue = calendarRequestStatus(event);
  const requestStatus = requestStatusValue ? statusLabel(requestStatusValue) : "";
  const title = text(event?.title, L("serrUntitled", "İçerik"));
  const metaParts = [];
  pushUniqueCalendarPart(metaParts, service);
  pushUniqueCalendarPart(metaParts, release);
  pushUniqueCalendarPart(metaParts, status);
  pushUniqueCalendarPart(metaParts, requestStatus);
  const meta = metaParts.join(" • ");
  const subtitle = calendarSubtitle(event, service, title);
  const poster = calendarPosterUrl(event);
  return `
    <div class="monwui-serr-calendar-event">
      <span class="monwui-serr-calendar-event-poster">
        ${poster
          ? `<img src="${escapeHtml(poster)}" alt="${escapeHtml(title)}" loading="lazy" decoding="async">`
          : `<i class="fas fa-clapperboard" aria-hidden="true"></i>`}
      </span>
      <span>
        <strong>${escapeHtml(title)}</strong>
        <small>${escapeHtml(meta)}</small>
        ${subtitle ? `<small>${escapeHtml(subtitle)}</small>` : ""}
        ${renderCalendarLinks(event)}
      </span>
    </div>
  `;
}

function renderCalendarDot(event) {
  const title = text(event?.title, L("serrUntitled", "İçerik"));
  const poster = calendarPosterUrl(event);
  return `
    <span class="monwui-serr-calendar-dot-wrap" role="button" tabindex="0" data-serr-calendar-event-dot aria-label="${escapeHtml(title)}">
      <span class="monwui-serr-calendar-dot is-split" style="${escapeHtml(calendarDotStyle(event))}" title="${escapeHtml(title)}"></span>
      <span class="monwui-serr-calendar-popover ${escapeHtml(servicePopoverClass(event?.service))}" role="tooltip">
        ${poster ? `<span class="monwui-serr-calendar-popover-bg" aria-hidden="true"><img src="${escapeHtml(poster)}" alt="" loading="lazy" decoding="async"></span>` : ""}
        ${renderCalendarEvent(event)}
      </span>
    </span>
  `;
}

function calendarPopoverImageUrls(dot) {
  const popover = dot?.querySelector?.(".monwui-serr-calendar-popover");
  if (!popover) return [];
  const seen = new Set();
  const urls = [];
  popover.querySelectorAll("img").forEach((img) => {
    const url = text(img.currentSrc || img.getAttribute("src") || img.src);
    if (!url || seen.has(url)) return;
    seen.add(url);
    urls.push(url);
  });
  return urls;
}

function waitForCalendarImage(url) {
  return new Promise((resolve) => {
    const img = new Image();
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok === true);
    };
    const timer = setTimeout(() => finish(false), CALENDAR_IMAGE_READY_TIMEOUT_MS);
    img.onload = () => finish(true);
    img.onerror = () => finish(false);
    img.decoding = "async";
    img.src = url;
    if (img.complete) finish(img.naturalWidth > 0);
  });
}

function replaceFailedCalendarImages(dot, failedUrls) {
  if (!dot || !failedUrls?.length) return;
  const failed = new Set(failedUrls);
  dot.querySelectorAll(".monwui-serr-calendar-popover img").forEach((img) => {
    const url = text(img.currentSrc || img.getAttribute("src") || img.src);
    if (!failed.has(url)) return;
    const bg = img.closest(".monwui-serr-calendar-popover-bg");
    if (bg) {
      bg.remove();
      return;
    }
    const poster = img.closest(".monwui-serr-calendar-event-poster");
    if (poster) {
      poster.innerHTML = `<i class="fas fa-clapperboard" aria-hidden="true"></i>`;
      return;
    }
    img.remove();
  });
}

function ensureCalendarDotImagesReady(dot) {
  if (!dot) return Promise.resolve(false);
  if (dot.classList.contains("is-ready")) return Promise.resolve(true);
  if (dot.__monwuiCalendarReadyPromise) return dot.__monwuiCalendarReadyPromise;

  const urls = calendarPopoverImageUrls(dot);
  if (!urls.length) {
    dot.classList.add("is-ready");
    dot.setAttribute("data-serr-calendar-images-ready", "1");
    return Promise.resolve(true);
  }

  dot.classList.add("is-loading");
  dot.__monwuiCalendarReadyPromise = Promise.all(urls.map(async (url) => ({
    url,
    ok: await waitForCalendarImage(url)
  }))).then((results) => {
    if (!dot.isConnected) return false;
    replaceFailedCalendarImages(dot, results.filter((item) => !item.ok).map((item) => item.url));
    dot.classList.remove("is-loading");
    dot.classList.add("is-ready");
    dot.setAttribute("data-serr-calendar-images-ready", "1");
    return true;
  }).finally(() => {
    dot.__monwuiCalendarReadyPromise = null;
  });

  return dot.__monwuiCalendarReadyPromise;
}

function closeCalendarDots(modal, exceptDot = null, exceptDay = null) {
  modal?.querySelectorAll?.(".monwui-serr-calendar-dot-wrap.is-open, .monwui-serr-calendar-dot-wrap.is-open-pending").forEach((node) => {
    if (node === exceptDot) return;
    node.classList.remove("is-open", "is-open-pending");
    node.__monwuiCalendarOpenToken = "";
  });
  modal?.querySelectorAll?.(".monwui-serr-calendar-day.is-open").forEach((node) => {
    if (node !== exceptDay) node.classList.remove("is-open");
  });
}

async function openCalendarDotAfterImages(dot, modal) {
  if (!dot) return;
  const day = dot.closest(".monwui-serr-calendar-day");
  const token = `${Date.now()}:${Math.random()}`;
  dot.__monwuiCalendarOpenToken = token;
  dot.classList.add("is-open-pending");
  closeCalendarDots(modal, dot, day);
  const ready = await ensureCalendarDotImagesReady(dot);
  if (!ready || !dot.isConnected || dot.__monwuiCalendarOpenToken !== token) return;
  dot.classList.remove("is-open-pending");
  dot.classList.add("is-open");
  day?.classList?.add?.("is-open");
}

function renderCalendarDay(day, monthDate, events, dayIndex = 0) {
  const key = dateKey(day);
  const today = dateKey(new Date()) === key;
  const muted = day.getMonth() !== monthDate.getMonth();
  const col = dayIndex % 7;
  const row = Math.floor(dayIndex / 7);
  const classes = [
    "monwui-serr-calendar-day",
    muted ? "is-muted" : "",
    today ? "is-today" : "",
    events.length ? "has-events" : "",
    col <= 1 ? "is-left-edge" : "",
    col >= 5 ? "is-right-edge" : "",
    row >= 4 ? "is-bottom-row" : ""
  ].filter(Boolean).join(" ");
  const visibleEvents = events.slice(0, 7);
  const dots = visibleEvents.map(renderCalendarDot).join("");
  return `
    <div class="${escapeHtml(classes)}" tabindex="0" data-serr-calendar-day="${escapeHtml(key)}">
      <div class="monwui-serr-calendar-number">${escapeHtml(String(day.getDate()))}</div>
      ${events.length ? `<div class="monwui-serr-calendar-dots">${dots}${events.length > visibleEvents.length ? `<span class="monwui-serr-calendar-more">+${events.length - visibleEvents.length}</span>` : ""}</div>` : ""}
    </div>
  `;
}

function ensureSerrCalendarModal() {
  ensureSerrCalendarStyles();
  let modal = document.getElementById("monwuiSerrCalendarModal");
  if (modal) return modal;

  modal = document.createElement("div");
  modal.id = "monwuiSerrCalendarModal";
  modal.className = "monwui-serr-calendar-modal";
  modal.setAttribute("aria-hidden", "true");
  modal.__calendarMonth = startOfMonth(new Date());
  modal.innerHTML = `
    <div class="monwui-serr-calendar-backdrop" data-serr-calendar-close></div>
    <div class="monwui-serr-calendar-dialog" role="dialog" aria-modal="true" aria-label="${escapeHtml(L("serrCalendarTitle", "Arr Takvimi"))}">
      <div class="monwui-serr-calendar-head">
        <button type="button" class="monwui-serr-calendar-nav" data-serr-calendar-prev aria-label="${escapeHtml(L("previous", "Önceki"))}"><i class="fas fa-chevron-left" aria-hidden="true"></i></button>
        <button type="button" class="monwui-serr-calendar-nav" data-serr-calendar-today aria-label="${escapeHtml(L("today", "Bugün"))}"><i class="fas fa-calendar-day" aria-hidden="true"></i></button>
        <div class="monwui-serr-calendar-title" data-serr-calendar-title></div>
        <button type="button" class="monwui-serr-calendar-nav" data-serr-calendar-next aria-label="${escapeHtml(L("next", "Sonraki"))}"><i class="fas fa-chevron-right" aria-hidden="true"></i></button>
        <button type="button" class="monwui-serr-calendar-close" data-serr-calendar-close aria-label="${escapeHtml(L("close", "Kapat"))}">×</button>
      </div>
      <div class="monwui-serr-calendar-body">
        <div class="monwui-serr-calendar-legend">
          ${calendarLegendHtml()}
        </div>
        <div class="monwui-serr-calendar-grid" data-serr-calendar-grid></div>
      </div>
    </div>
  `;

  modal.addEventListener("click", (event) => {
    if (event.target?.closest?.(".monwui-serr-calendar-link")) {
      return;
    }
    if (event.target?.closest?.("[data-serr-calendar-close]")) {
      closeSerrCalendarModal();
      return;
    }
    if (event.target?.closest?.("[data-serr-calendar-prev]")) {
      modal.__calendarMonth = addMonths(modal.__calendarMonth || new Date(), -1);
      void renderSerrCalendarModal(modal);
      return;
    }
    if (event.target?.closest?.("[data-serr-calendar-next]")) {
      modal.__calendarMonth = addMonths(modal.__calendarMonth || new Date(), 1);
      void renderSerrCalendarModal(modal);
      return;
    }
    if (event.target?.closest?.("[data-serr-calendar-today]")) {
      modal.__calendarMonth = startOfMonth(new Date());
      void renderSerrCalendarModal(modal);
      return;
    }
    const dot = event.target?.closest?.("[data-serr-calendar-event-dot]");
    if (dot) {
      const day = dot.closest(".monwui-serr-calendar-day");
      const willOpen = !dot.classList.contains("is-open");
      if (!willOpen) {
        dot.classList.remove("is-open", "is-open-pending");
        dot.__monwuiCalendarOpenToken = "";
        day?.classList?.remove?.("is-open");
        return;
      }
      void openCalendarDotAfterImages(dot, modal);
    }
  });
  modal.addEventListener("mouseover", (event) => {
    const dot = event.target?.closest?.("[data-serr-calendar-event-dot]");
    if (dot) void ensureCalendarDotImagesReady(dot);
  });
  modal.addEventListener("focusin", (event) => {
    const dot = event.target?.closest?.("[data-serr-calendar-event-dot]");
    if (dot) void ensureCalendarDotImagesReady(dot);
  });
  modal.addEventListener("keydown", (event) => {
    const dot = event.target?.closest?.("[data-serr-calendar-event-dot]");
    if (dot && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      dot.click();
      return;
    }
    if (event.key === "Escape") {
      closeSerrCalendarModal();
    }
  });
  document.body.appendChild(modal);
  return modal;
}

function closeSerrCalendarModal() {
  const modal = document.getElementById("monwuiSerrCalendarModal");
  if (!modal) return;
  closeCalendarDots(modal);
  modal.classList.remove("open");
  modal.setAttribute("aria-hidden", "true");
}

async function openSerrCalendarModal() {
  const modal = ensureSerrCalendarModal();
  modal.__calendarMonth = modal.__calendarMonth || startOfMonth(new Date());
  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
  await renderSerrCalendarModal(modal);
}

async function renderSerrCalendarModal(modal) {
  const month = startOfMonth(modal.__calendarMonth || new Date());
  modal.__calendarMonth = month;
  const title = modal.querySelector("[data-serr-calendar-title]");
  const grid = modal.querySelector("[data-serr-calendar-grid]");
  if (title) title.textContent = monthTitle(month);
  if (!grid) return;
  grid.innerHTML = `<div class="monwui-serr-calendar-loading" style="grid-column:1/-1">${escapeHtml(L("loadingText", "Yükleniyor..."))}</div>`;

  const range = calendarRange(month);
  try {
    const [data] = await Promise.all([
      getArrCalendar({ start: dateKey(range.start), end: dateKey(range.end) }),
      refresh({ render: false }).catch(() => null)
    ]);
    const events = Array.isArray(data?.events) ? data.events : [];
    const byDay = new Map();
    for (const event of events) {
      const parsed = parseEventDate(event?.date);
      if (!parsed) continue;
      const key = dateKey(parsed);
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push(event);
    }
    const days = Array.from({ length: 42 }, (_, index) => addDays(range.start, index));
    grid.innerHTML = [
      ...weekdayLabels().map((label) => `<div class="monwui-serr-calendar-weekday">${escapeHtml(label)}</div>`),
      ...days.map((day, index) => renderCalendarDay(day, month, byDay.get(dateKey(day)) || [], index))
    ].join("");
    if (!events.length) {
      grid.insertAdjacentHTML("beforeend", `<div class="monwui-serr-calendar-empty" style="grid-column:1/-1">${escapeHtml(L("serrCalendarEmpty", "Bu aralıkta takvim kaydı yok."))}</div>`);
    }
  } catch (error) {
    grid.innerHTML = `<div class="monwui-serr-calendar-error" style="grid-column:1/-1">${escapeHtml(error?.message || L("serrRequestFailed", "İşlem tamamlanamadı."))}</div>`;
  }
}

function statusLabel(status) {
  switch (text(status).toLowerCase()) {
    case "pending": return L("serrStatusPending", "Onay bekliyor");
    case "approved": return L("serrStatusApproved", "Onaylandı");
    case "processing": return L("serrStatusProcessing", "İşleniyor");
    case "completed":
    case "available": return L("serrStatusCompleted", "Tamamlandı");
    case "declined": return L("serrStatusDeclined", "Reddedildi");
    case "failed": return L("serrStatusFailed", "Hatalı");
    case "withdrawn": return L("serrStatusWithdrawn", "Geri çekildi");
    default: return L("serrStatusRequested", "İstendi");
  }
}

function downloadInfo(req) {
  const info = req?.download || req?.Download;
  return info && (info.active === true || info.IsActive === true) ? info : null;
}

function percentValue(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

function serviceLabel(value) {
  const clean = text(value).toLowerCase();
  if (clean === "radarr") return L("serrCalendarRadarr", "Radarr");
  if (clean === "sonarr") return L("serrCalendarSonarr", "Sonarr");
  if (clean === "radarr4k" || clean === "4k radarr") return L("arrRadarr4KSection", "4K Radarr");
  if (clean === "sonarr4k" || clean === "4k sonarr") return L("arrSonarr4KSection", "4K Sonarr");
  return clean ? clean : "Arr";
}

function renderDownloadProgress(req) {
  const info = downloadInfo(req);
  if (!info) return "";
  const percent = percentValue(info.progressPercent ?? info.ProgressPercent);
  const service = serviceLabel(info.service || info.Service);
  const client = text(info.downloadClient || info.DownloadClient);
  const timeLeft = text(info.timeLeft || info.TimeLeft);
  const count = Number(info.itemCount ?? info.ItemCount ?? 1);
  const bits = [
    service,
    client,
    timeLeft ? `${L("arrDownloadRemaining", "Kalan")}: ${timeLeft}` : "",
    Number.isFinite(count) && count > 1 ? `${count} ${L("arrDownloadItems", "öğe")}` : ""
  ].filter(Boolean);

  return `
    <div class="monwui-serr-download">
      <div class="monwui-serr-download-line">
        <b>${escapeHtml(L("arrDownloadProgress", "İndirme"))} ${escapeHtml(percent.toFixed(percent >= 10 ? 0 : 1))}%</b>
        ${bits.length ? `<span>${escapeHtml(bits.join(" • "))}</span>` : ""}
      </div>
      <div class="monwui-serr-download-track" aria-label="${escapeHtml(L("arrDownloadProgress", "İndirme"))}">
        <div class="monwui-serr-download-bar" style="width:${escapeHtml(String(percent))}%"></div>
      </div>
    </div>
  `;
}

function renderDownloadProgressHost(req) {
  return `<div data-serr-download-host>${renderDownloadProgress(req)}</div>`;
}

function arrStatusMessage(result) {
  if (result?.service === "sonarr") return L("arrEpisodeRequestSent", "Bölüm isteği Sonarr'a gönderildi.");
  if (result?.service === "radarr") return L("arrMovieRequestSent", "Film isteği Radarr'a gönderildi.");
  return L("arrRequestSent", "Arr isteği gönderildi.");
}

function notify(message, type = "info") {
  const clean = text(message);
  if (!clean) return;
  try {
    showNotification(`<i class="fas fa-clapperboard" style="margin-right:8px;"></i>${escapeHtml(clean)}`, 3200, type);
  } catch {
    window.showMessage?.(clean, type === "error" ? "error" : "success");
  }
}

function shouldFallbackMovieToArr(result) {
  if (result?.backend === "arr" || result?.service === "radarr" || result?.service === "sonarr") return false;
  if (result?.pendingApproval) return false;
  if (result?.ok !== false) return false;

  const request = result?.request || result?.Request || {};
  const mediaType = requestMediaType(request);
  const mediaId = requestMediaId(request);
  return mediaType === "movie" && mediaId > 0;
}

async function approveSerrRequestWithArrFallback(id) {
  const result = await approveSerrRequest(id);
  if (result?.backend === "arr" || result?.service === "radarr" || result?.service === "sonarr") {
    notify(arrStatusMessage(result), "success");
  }
  if (shouldFallbackMovieToArr(result)) {
    const request = result?.request || result?.Request || {};
    const mediaId = requestMediaId(request);
    const title = text(request?.Title || request?.title, L("serrMovie", "Film"));
    const arrResult = await requestMovieFromArr({ __tmdbId: mediaId, Name: title }, { tmdbId: mediaId, title, is4K: requestIs4K(request) });
    notify(arrStatusMessage(arrResult), "success");
  }
  return result;
}

function isHiddenFromNotifications(req) {
  const status = text(req?.Status || req?.status).toLowerCase();
  return status === "completed" ||
    status === "available" ||
    status === "declined" ||
    status === "failed" ||
    status === "withdrawn";
}

function mediaLabel(req) {
  const type = requestMediaType(req);
  const episodes = Array.isArray(req?.episodes) ? req.episodes : (Array.isArray(req?.Episodes) ? req.Episodes : []);
  const episodeText = episodes.length
    ? episodes.slice(0, 4).map((entry) => {
        const seasonNumber = Number(entry?.SeasonNumber ?? entry?.seasonNumber);
        const episodeNumber = Number(entry?.EpisodeNumber ?? entry?.episodeNumber);
        const code = [
          Number.isFinite(seasonNumber) ? `S${String(seasonNumber).padStart(2, "0")}` : "",
          Number.isFinite(episodeNumber) ? `E${String(episodeNumber).padStart(2, "0")}` : ""
        ].filter(Boolean).join("");
        return code || text(entry?.Name || entry?.name, L("episode", "Bölüm"));
      }).join(", ") + (episodes.length > 4 ? ` +${episodes.length - 4}` : "")
    : "";
  const seasons = req?.RequestAllSeasons || req?.requestAllSeasons
    ? L("serrAllSeasons", "Tüm sezonlar")
    : (Array.isArray(req?.seasons) && req.seasons.length
      ? req.seasons.map((n) => `${L("season", "Sezon")} ${n}`).join(", ")
      : "");
  return [type === "tv" ? L("serrTv", "Dizi") : L("serrMovie", "Film"), seasons, episodeText].filter(Boolean).join(" • ");
}

function computeCount(requests, isAdmin) {
  const seen = readSeenRequestKeys();
  return notificationCountableRequests(requests, isAdmin)
    .reduce((count, req) => {
      const key = requestNotificationKey(req);
      return count + (key && !seen.has(key) ? 1 : 0);
    }, 0);
}

function notificationCountableRequests(requests, isAdmin) {
  const list = Array.isArray(requests) ? requests : [];
  if (!isAdmin) return list;
  return list.filter((req) => text(req?.Status || req?.status).toLowerCase() === "pending");
}

function ensureSerrTabBadgeStyles() {
  const id = "monwui-serr-tab-badge-styles";
  if (document.getElementById(id)) return;
  const style = document.createElement("style");
  style.id = id;
  style.textContent = `
    #jfNotifModal .jf-notif-tab[data-tab="serr"] {
      align-items: center;
      display: inline-flex;
      gap: 6px;
      flex-direction: column-reverse;
    }
    #jfNotifModal .monwui-serr-tab-label {
      min-width: 0;
    }
    #jfNotifModal .monwui-serr-tab-badge {
      align-items: center;
      background: var(--jf-notif-warning, #ffbf5f);
      border-radius: 999px;
      color: #111;
      display: inline-flex;
      font-size: 11px;
      font-weight: 850;
      height: 18px;
      justify-content: center;
      line-height: 1;
      min-width: 18px;
      padding: 0 6px;
    }
    #jfNotifModal .jf-notif-tab.active .monwui-serr-tab-badge {
      background: rgba(255,255,255,.92);
      color: #111;
    }
    #jfNotifModal .monwui-serr-tab-badge[hidden] {
      display: none !important;
    }
  `;
  document.head.appendChild(style);
}

function renderSerrTabBadge() {
  const tab = document.querySelector('#jfNotifModal .jf-notif-tab[data-tab="serr"]');
  if (!tab) return;
  ensureSerrTabBadgeStyles();

  let label = tab.querySelector(".monwui-serr-tab-label");
  let badge = tab.querySelector(".monwui-serr-tab-badge");
  if (!label || !badge) {
    tab.textContent = "";
    label = document.createElement("span");
    label.className = "monwui-serr-tab-label";
    badge = document.createElement("span");
    badge.className = "monwui-serr-tab-badge";
    badge.setAttribute("aria-hidden", "true");
    tab.append(label, badge);
  }

  label.textContent = L("serrNotificationsTab", "Seerr İstekleri");
  const count = getCachedSerrNotificationCount();
  const visible = count > 0;
  const value = count > 99 ? "99+" : String(count);
  badge.textContent = visible ? value : "";
  badge.hidden = !visible;
  tab.setAttribute("data-serr-count", visible ? value : "");
  tab.classList.toggle("has-serr-count", visible);
}

function dispatchSerrCountChanged() {
  try { window.dispatchEvent(new CustomEvent("monwui:serr-notification-count-changed")); } catch {}
}

export function markSerrNotificationsSeen() {
  const before = cachedCount;
  const seen = readSeenRequestKeys();
  let changed = false;
  for (const req of notificationCountableRequests(cachedRequests, lastIsAdmin)) {
    const key = requestNotificationKey(req);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    changed = true;
  }
  if (!changed && cachedCount === 0) {
    renderSerrTabBadge();
    if (before !== cachedCount) dispatchSerrCountChanged();
    return;
  }

  if (changed) writeSeenRequestKeys(seen);
  cachedCount = computeCount(cachedRequests, lastIsAdmin);
  renderSerrTabBadge();
  if (changed || before !== cachedCount) dispatchSerrCountChanged();
}

function applyNotificationData(data, { render = false } = {}) {
  const previousCount = cachedCount;
  cachedRequests = (Array.isArray(data?.requests) ? data.requests : []).filter((req) => !isHiddenFromNotifications(req));
  lastIsAdmin = data?.isAdmin === true;
  cachedCount = computeCount(cachedRequests, lastIsAdmin);
  if (isSerrPanelVisible()) {
    markSerrNotificationsSeen();
    if (previousCount !== cachedCount) dispatchSerrCountChanged();
  } else {
    renderSerrTabBadge();
    if (previousCount !== cachedCount) dispatchSerrCountChanged();
  }
  if (render) renderSerrNotifications();
}

async function refresh({ render = false } = {}) {
  if (!moduleEnabled()) {
    const previousCount = cachedCount;
    cachedRequests = [];
    cachedCount = 0;
    removeSerrNotificationsTab();
    if (previousCount !== cachedCount) dispatchSerrCountChanged();
    return null;
  }
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    try {
      const data = await listSerrRequests();
      applyNotificationData(data, { render });
      return data;
    } catch {
      const previousCount = cachedCount;
      cachedRequests = [];
      cachedCount = 0;
      renderSerrTabBadge();
      if (previousCount !== cachedCount) dispatchSerrCountChanged();
      if (render) renderSerrNotifications();
      return null;
    } finally {
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}

export function refreshSerrNotifications({ render = false } = {}) {
  return refresh({ render });
}

export function getCachedSerrNotificationCount() {
  return moduleEnabled() ? cachedCount : 0;
}

export function removeSerrNotificationsTab() {
  const tab = document.querySelector('#jfNotifModal .jf-notif-tab[data-tab="serr"]');
  const pane = document.querySelector('#jfNotifModal .jf-notif-tab-content[data-tab="serr"]');
  const wasActive = tab?.classList?.contains("active") === true || (pane ? pane.style.display !== "none" : false);
  tab?.remove?.();
  pane?.remove?.();
  if (wasActive) {
    const first = document.querySelector("#jfNotifModal .jf-notif-tab");
    first?.click?.();
  }
}

function serrToolsHtml() {
  return `
    <button type="button" class="monwui-serr-manage-btn" data-serr-open-manager>${escapeHtml(L("serrManageRequests", "İstekleri Yönet"))}</button>
    <button type="button" class="monwui-serr-calendar-btn" data-serr-open-calendar title="${escapeHtml(L("serrCalendarTitle", "Arr Takvimi"))}">
      <i class="fas fa-calendar-alt" aria-hidden="true"></i>
      <span>${escapeHtml(L("serrCalendarButton", "Takvim"))}</span>
    </button>
  `;
}

export function ensureSerrNotificationsTab({ bindNotifTabButton } = {}) {
  if (!moduleEnabled()) {
    removeSerrNotificationsTab();
    return;
  }
  ensureSerrTabBadgeStyles();
  ensureSerrCalendarStyles();
  const tabs = document.querySelector("#jfNotifModal .jf-notif-tabs");
  const contentHost = document.querySelector("#jfNotifModal .jf-notif-content");
  if (!tabs || !contentHost) return;

  if (!tabs.querySelector('[data-tab="serr"]')) {
    const btn = document.createElement("button");
    btn.className = "jf-notif-tab";
    btn.setAttribute("data-tab", "serr");
    tabs.appendChild(btn);
    bindNotifTabButton?.(btn);
  }
  renderSerrTabBadge();

  let pane = contentHost.querySelector('.jf-notif-tab-content[data-tab="serr"]');
  if (!pane) {
    pane = document.createElement("div");
    pane.className = "jf-notif-tab-content";
    pane.setAttribute("data-tab", "serr");
    pane.style.display = "none";
    pane.innerHTML = `
      <div class="monwui-serr-notif-tools">
        ${serrToolsHtml()}
      </div>
      <div class="monwui-serr-notif-host" id="monwuiSerrNotifHost"></div>
    `;
    contentHost.appendChild(pane);
  }

  let tools = pane.querySelector(".monwui-serr-notif-tools");
  if (!tools) {
    tools = document.createElement("div");
    tools.className = "monwui-serr-notif-tools";
    pane.prepend(tools);
  }
  if (!tools.querySelector("[data-serr-open-manager]") || !tools.querySelector("[data-serr-open-calendar]")) {
    tools.innerHTML = serrToolsHtml();
  }

  if (!pane.querySelector("#monwuiSerrNotifHost")) {
    const host = document.createElement("div");
    host.className = "monwui-serr-notif-host";
    host.id = "monwuiSerrNotifHost";
    pane.appendChild(host);
  }

  bindSerrManagerButtons(pane);
  bindSerrCalendarButtons(pane);
}

export function renderSerrNotifications() {
  if (!moduleEnabled()) {
    removeSerrNotificationsTab();
    return;
  }
  ensureSerrProgressStyles();
  const host = document.getElementById("monwuiSerrNotifHost");
  if (!host) return;

  if (!cachedRequests.length) {
    host.innerHTML = `<div class="monwui-serr-empty">${escapeHtml(L("serrNoRequests", "Aktif Seerr isteği yok."))}</div>`;
    return;
  }

  host.innerHTML = `
    <ul class="monwui-serr-notif-list">
      ${cachedRequests.map((req) => renderRequest(req, lastIsAdmin)).join("")}
    </ul>
  `;

  host.querySelectorAll("[data-serr-approve]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await runAction(btn, () => approveSerrRequestWithArrFallback(btn.getAttribute("data-serr-approve")));
    });
  });

  host.querySelectorAll("[data-serr-decline]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await runAction(btn, () => declineSerrRequest(btn.getAttribute("data-serr-decline")));
    });
  });

  hydrateRequestPosters(host);
}

function bindSerrManagerButtons(scope = document) {
  scope.querySelectorAll?.("[data-serr-open-manager]").forEach((button) => {
    if (button.__monwuiSerrManagerBound) return;
    button.__monwuiSerrManagerBound = true;
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void openSerrRequestsModal();
    });
  });
}

function bindSerrCalendarButtons(scope = document) {
  scope.querySelectorAll?.("[data-serr-open-calendar]").forEach((button) => {
    if (button.__monwuiSerrCalendarBound) return;
    button.__monwuiSerrCalendarBound = true;
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void openSerrCalendarModal();
    });
  });
}

function renderRequest(req, isAdmin) {
  const status = text(req?.Status || req?.status).toLowerCase();
  const title = text(req?.Title || req?.title, L("serrUntitled", "İçerik"));
  const requestedBy = req?.requestedBy?.userName || req?.RequestedBy?.UserName || "";
  const error = text(req?.Error || req?.error);
  const time = formatTime(req?.UpdatedAtUtc || req?.updatedAtUtc || req?.CreatedAtUtc || req?.createdAtUtc);
  const canApprove = isAdmin && status === "pending";

  return `
    <li class="monwui-serr-notif-item">
      <div class="monwui-serr-notif-top">
        ${renderPoster(req, "compact")}
        <div class="monwui-serr-notif-main">
          <div class="monwui-serr-title-row">
            <span class="monwui-serr-status ${escapeHtml(status || "pending")}">${escapeHtml(statusLabel(status))}</span>
            ${renderRequest4KBadge(req)}
            ${time ? `<span class="monwui-serr-state">${escapeHtml(time)}</span>` : ""}
          </div>
          <div class="monwui-serr-name">${escapeHtml(title)}</div>
          <div class="monwui-serr-meta">${escapeHtml(mediaLabel(req))}</div>
          ${renderDownloadProgressHost(req)}
          ${requestedBy ? `<div class="monwui-serr-state">${escapeHtml(L("serrRequestedBy", "İsteyen"))}: ${escapeHtml(requestedBy)}</div>` : ""}
          ${error ? `<div class="monwui-serr-error">${escapeHtml(error)}</div>` : ""}
        </div>
        ${canApprove ? `
          <div class="monwui-serr-notif-actions">
            <button type="button" class="monwui-serr-mini-btn primary" data-serr-approve="${escapeHtml(req.Id || req.id)}">${escapeHtml(L("serrApprove", "Onayla"))}</button>
            <button type="button" class="monwui-serr-mini-btn" data-serr-decline="${escapeHtml(req.Id || req.id)}">${escapeHtml(L("serrDecline", "Reddet"))}</button>
          </div>
        ` : ""}
      </div>
    </li>
  `;
}

function ensureSerrRequestsModal() {
  let modal = document.getElementById("monwuiSerrRequestsModal");
  if (modal) return modal;

  modal = document.createElement("div");
  modal.id = "monwuiSerrRequestsModal";
  modal.className = "monwui-serr-requests-modal";
  modal.setAttribute("aria-hidden", "true");
  modal.innerHTML = `
    <div class="monwui-serr-requests-backdrop" data-serr-manager-close></div>
    <div class="monwui-serr-requests-dialog" role="dialog" aria-modal="true">
      <div class="monwui-serr-requests-head">
        <div class="monwui-serr-requests-title">${escapeHtml(L("serrRequestsModalTitle", "Seerr İstek Yönetimi"))}</div>
        <button type="button" class="monwui-serr-requests-close" data-serr-manager-close aria-label="${escapeHtml(L("close", "Kapat"))}">×</button>
      </div>
      <div class="monwui-serr-requests-body"></div>
    </div>
  `;
  modal.addEventListener("click", (event) => {
    if (event.target?.closest?.("[data-serr-manager-close]")) {
      closeSerrRequestsModal();
    }
  });
  document.body.appendChild(modal);
  return modal;
}

function closeSerrRequestsModal() {
  const modal = document.getElementById("monwuiSerrRequestsModal");
  if (!modal) return;
  modal.classList.remove("open");
  modal.setAttribute("aria-hidden", "true");
  scheduleNextPoll(nextPollDelay());
}

async function openSerrRequestsModal() {
  const modal = ensureSerrRequestsModal();
  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
  const body = modal.querySelector(".monwui-serr-requests-body");
  if (body) {
    body.innerHTML = `<div class="monwui-serr-loading">${escapeHtml(L("loadingText", "Yükleniyor..."))}</div>`;
  }
  const data = await refreshSerrRequestManager({ render: false, showError: true });
  if (data) renderSerrRequestManager();
  scheduleNextPoll(nextPollDelay());
}

async function refreshSerrRequestManager({ render = false, showError = render } = {}) {
  if (managerRefreshPromise) {
    const data = await managerRefreshPromise;
    if (render && data) renderSerrRequestManager();
    if (showError && !data) {
      const body = document.querySelector("#monwuiSerrRequestsModal .monwui-serr-requests-body");
      if (body) body.innerHTML = `<div class="monwui-serr-error">${escapeHtml(L("serrRequestFailed", "İşlem tamamlanamadı."))}</div>`;
    }
    return data;
  }
  managerRefreshPromise = (async () => {
    const modal = ensureSerrRequestsModal();
    const body = modal.querySelector(".monwui-serr-requests-body");
    if (render && body) {
      body.innerHTML = `<div class="monwui-serr-loading">${escapeHtml(L("loadingText", "Yükleniyor..."))}</div>`;
    }

    try {
      const data = await listSerrRequests({ includeHistory: true });
      managerRequests = Array.isArray(data?.requests) ? data.requests : [];
      managerIsAdmin = data?.isAdmin === true;
    } catch (error) {
      managerRequests = [];
      managerIsAdmin = false;
      if (showError && body) {
        body.innerHTML = `<div class="monwui-serr-error">${escapeHtml(error?.message || L("serrRequestFailed", "İşlem tamamlanamadı."))}</div>`;
      }
      return null;
    } finally {
      managerRefreshPromise = null;
    }

    if (render) renderSerrRequestManager();
    return { requests: managerRequests, isAdmin: managerIsAdmin };
  })();
  return managerRefreshPromise;
}

function renderSerrRequestManager() {
  ensureSerrProgressStyles();
  const modal = ensureSerrRequestsModal();
  const body = modal.querySelector(".monwui-serr-requests-body");
  if (!body) return;

  if (!managerRequests.length) {
    body.innerHTML = `<div class="monwui-serr-empty">${escapeHtml(L("serrNoRequestHistory", "Seerr istek geçmişi yok."))}</div>`;
    return;
  }

  body.innerHTML = `
    <div class="monwui-serr-requests-list">
      ${managerRequests.map((req) => renderManagerRequest(req, managerIsAdmin)).join("")}
    </div>
  `;

  body.querySelectorAll("[data-serr-manager-approve]").forEach((btn) => {
    btn.addEventListener("click", () => runManagerAction(btn, () => approveSerrRequestWithArrFallback(btn.getAttribute("data-serr-manager-approve"))));
  });
  body.querySelectorAll("[data-serr-manager-decline]").forEach((btn) => {
    btn.addEventListener("click", () => runManagerAction(btn, () => declineSerrRequest(btn.getAttribute("data-serr-manager-decline"))));
  });
  body.querySelectorAll("[data-serr-manager-withdraw]").forEach((btn) => {
    btn.addEventListener("click", () => runManagerAction(btn, () => withdrawSerrRequest(btn.getAttribute("data-serr-manager-withdraw"))));
  });

  hydrateRequestPosters(body);
}

function renderManagerRequest(req, isAdmin) {
  const id = text(req?.Id || req?.id);
  const status = text(req?.Status || req?.status).toLowerCase() || "pending";
  const title = text(req?.Title || req?.title, L("serrUntitled", "İçerik"));
  const requestedBy = req?.requestedBy?.userName || req?.RequestedBy?.UserName || "";
  const created = formatTime(req?.CreatedAtUtc || req?.createdAtUtc);
  const updated = formatTime(req?.UpdatedAtUtc || req?.updatedAtUtc);
  const completed = formatTime(req?.CompletedAtUtc || req?.completedAtUtc);
  const error = text(req?.Error || req?.error);
  const canApprove = isAdmin && (status === "pending" || status === "failed");
  const canDecline = isAdmin && status !== "declined" && status !== "withdrawn" && status !== "completed" && status !== "available";
  const canWithdraw = id && (
    (isAdmin && status !== "withdrawn" && status !== "completed" && status !== "available") ||
    (!isAdmin && status === "pending")
  );

  return `
    <section class="monwui-serr-request-card" data-serr-request-id="${escapeHtml(id)}">
      <div class="monwui-serr-request-main">
        ${renderPoster(req, "large")}
        <div class="monwui-serr-request-content">
          <div class="monwui-serr-title-row">
            <span class="monwui-serr-status ${escapeHtml(status)}" data-serr-status>${escapeHtml(statusLabel(status))}</span>
            ${renderRequest4KBadge(req)}
            <span class="monwui-serr-state" data-serr-updated ${updated ? "" : "hidden"}>${escapeHtml(updated)}</span>
          </div>
          <div class="monwui-serr-request-name">${escapeHtml(title)}</div>
          <div class="monwui-serr-request-meta">${escapeHtml(mediaLabel(req))}</div>
          ${renderDownloadProgressHost(req)}
        </div>
        <div class="monwui-serr-request-actions">
          ${canApprove ? `<button type="button" class="monwui-serr-mini-btn primary" data-serr-manager-approve="${escapeHtml(id)}">${escapeHtml(L("serrApprove", "Onayla"))}</button>` : ""}
          ${canDecline ? `<button type="button" class="monwui-serr-mini-btn" data-serr-manager-decline="${escapeHtml(id)}">${escapeHtml(L("serrDecline", "Reddet"))}</button>` : ""}
          ${canWithdraw ? `<button type="button" class="monwui-serr-mini-btn" data-serr-manager-withdraw="${escapeHtml(id)}">${escapeHtml(L("serrWithdraw", "Geri Çek"))}</button>` : ""}
        </div>
      </div>
      <div class="monwui-serr-request-details">
        ${requestedBy ? `<div><b>${escapeHtml(L("serrRequestedBy", "İsteyen"))}</b><span>${escapeHtml(requestedBy)}</span></div>` : ""}
        ${created ? `<div><b>${escapeHtml(L("created", "Oluşturuldu"))}</b><span>${escapeHtml(created)}</span></div>` : ""}
        ${updated ? `<div><b>${escapeHtml(L("updated", "Güncellendi"))}</b><span>${escapeHtml(updated)}</span></div>` : ""}
        ${completed ? `<div><b>${escapeHtml(L("serrStatusCompleted", "Tamamlandı"))}</b><span>${escapeHtml(completed)}</span></div>` : ""}
        <div><b>TMDb</b><span>${escapeHtml(text(req?.MediaId || req?.mediaId, "-"))}</span></div>
        ${req?.SerrRequestId || req?.serrRequestId ? `<div><b>Seerr</b><span>#${escapeHtml(req?.SerrRequestId || req?.serrRequestId)}</span></div>` : ""}
      </div>
      <div data-serr-error-host>${error ? `<div class="monwui-serr-error">${escapeHtml(error)}</div>` : ""}</div>
    </section>
  `;
}

function updateVisibleSerrRequestManager() {
  ensureSerrProgressStyles();
  const modal = document.querySelector(".monwui-serr-requests-modal.open");
  const body = modal?.querySelector(".monwui-serr-requests-body");
  if (!body) return;

  const cards = Array.from(body.querySelectorAll("[data-serr-request-id]"));
  if (!cards.length) {
    if (managerRequests.length) renderSerrRequestManager();
    return;
  }

  const requestsById = new Map(
    managerRequests
      .map((req) => [text(req?.Id || req?.id), req])
      .filter(([id]) => id)
  );

  for (const card of cards) {
    const id = text(card.getAttribute("data-serr-request-id"));
    const req = requestsById.get(id);
    if (!req) continue;

    const status = text(req?.Status || req?.status).toLowerCase() || "pending";
    const statusNode = card.querySelector("[data-serr-status]");
    if (statusNode) {
      statusNode.className = `monwui-serr-status ${status}`;
      statusNode.textContent = statusLabel(status);
    }

    const updated = formatTime(req?.UpdatedAtUtc || req?.updatedAtUtc);
    card.querySelectorAll("[data-serr-updated]").forEach((node) => {
      node.textContent = updated;
      if (updated) node.removeAttribute("hidden");
      else node.setAttribute("hidden", "");
    });

    const progressHost = card.querySelector("[data-serr-download-host]");
    if (progressHost) progressHost.innerHTML = renderDownloadProgress(req);

    const errorHost = card.querySelector("[data-serr-error-host]");
    if (errorHost) {
      const error = text(req?.Error || req?.error);
      errorHost.innerHTML = error ? `<div class="monwui-serr-error">${escapeHtml(error)}</div>` : "";
    }
  }

  hydrateRequestPosters(body);
}

async function runManagerAction(button, fn) {
  if (!button || button.disabled) return;
  const old = button.textContent;
  try {
    button.disabled = true;
    button.textContent = L("loadingText", "Yükleniyor...");
    await fn();
    await refresh({ render: true });
    const data = await refreshSerrRequestManager({ render: false, showError: true });
    if (data) renderSerrRequestManager();
    try { window.dispatchEvent(new CustomEvent("monwui:serr-notification-count-changed")); } catch {}
  } catch (error) {
    button.textContent = error?.message || L("serrRequestFailed", "İşlem tamamlanamadı.");
    setTimeout(() => {
      button.textContent = old;
      button.disabled = false;
    }, 1800);
  }
}

async function runAction(button, fn) {
  if (!button || button.disabled) return;
  const old = button.textContent;
  try {
    button.disabled = true;
    button.textContent = L("loadingText", "Yükleniyor...");
    await fn();
    await refresh({ render: true });
  } catch (error) {
    button.textContent = error?.message || L("serrRequestFailed", "İşlem tamamlanamadı.");
    setTimeout(() => { button.textContent = old; button.disabled = false; }, 1800);
    return;
  }
  button.disabled = false;
  button.textContent = old;
}

function isSerrPanelVisible() {
  const tab = document.querySelector('.jf-notif-tab.active[data-tab="serr"]');
  if (!tab) return false;
  const modal = tab.closest("#jfNotifModal");
  return !modal || modal.classList.contains("open");
}

function isSerrManagerVisible() {
  return document.querySelector(".monwui-serr-requests-modal.open") != null;
}

function hasActiveDownload(requests) {
  return (Array.isArray(requests) ? requests : []).some((req) => downloadInfo(req));
}

function nextPollDelay() {
  if (document.hidden) return BACKGROUND_POLL_MS;
  const visibleSurface = isSerrPanelVisible() || isSerrManagerVisible();
  if (visibleSurface && (hasActiveDownload(cachedRequests) || hasActiveDownload(managerRequests))) {
    return ACTIVE_DOWNLOAD_POLL_MS;
  }
  return visibleSurface ? OPEN_IDLE_POLL_MS : BACKGROUND_POLL_MS;
}

function syncNotificationsFromManager({ renderPanel = false } = {}) {
  applyNotificationData({ requests: managerRequests, isAdmin: managerIsAdmin }, { render: renderPanel });
}

async function refreshVisibleSerrSurfaces({ forcePanelRender = false } = {}) {
  const renderPanel = forcePanelRender || isSerrPanelVisible();
  if (isSerrManagerVisible()) {
    const data = await refreshSerrRequestManager({ render: false });
    if (data) {
      updateVisibleSerrRequestManager();
      syncNotificationsFromManager({ renderPanel });
      return data;
    }
  }

  return refresh({ render: renderPanel });
}

function scheduleNextPoll(delay = nextPollDelay()) {
  clearTimeout(pollTimer);
  if (!pollEnabled || !moduleEnabled()) return;
  pollTimer = setTimeout(() => {
    pollTimer = 0;
    if (document.hidden) {
      scheduleNextPoll();
      return;
    }
    refreshVisibleSerrSurfaces()
      .catch(() => {})
      .finally(() => scheduleNextPoll());
  }, Math.max(500, delay));
}

export function scheduleSerrNotificationsPoll() {
  if (!moduleEnabled()) {
    stopSerrNotificationsPoll();
    return;
  }
  pollEnabled = true;
  clearTimeout(pollTimer);
  refresh({ render: false }).finally(() => scheduleNextPoll());

  if (pollEventsBound) return;
  pollEventsBound = true;

  window.addEventListener("monwui:serr-requests-changed", () => {
    if (!pollEnabled || !moduleEnabled()) return;
    refreshVisibleSerrSurfaces({ forcePanelRender: true })
      .catch(() => {})
      .finally(() => scheduleNextPoll(ACTIVE_DOWNLOAD_POLL_MS));
  });
  window.addEventListener("focus", () => {
    if (!pollEnabled || !moduleEnabled()) return;
    refreshVisibleSerrSurfaces({ forcePanelRender: document.querySelector("#jfNotifModal.open") != null })
      .catch(() => {})
      .finally(() => scheduleNextPoll());
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && pollEnabled && moduleEnabled()) {
      refreshVisibleSerrSurfaces()
        .catch(() => {})
        .finally(() => scheduleNextPoll());
    }
  });
}

export function stopSerrNotificationsPoll() {
  pollEnabled = false;
  clearTimeout(pollTimer);
  pollTimer = 0;
  const previousCount = cachedCount;
  cachedRequests = [];
  cachedCount = 0;
  removeSerrNotificationsTab();
  if (previousCount !== cachedCount) dispatchSerrCountChanged();
}
