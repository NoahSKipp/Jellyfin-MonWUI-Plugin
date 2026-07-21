// Online recommendation discovery for MonWUI's home recommendation rows.
//
// Fetches recommendations from TMDb / Overseerr / Jellyseerr (via the backend
// SerrController "online/*" endpoints) and normalizes them into card items that
// personalRecommendations.js can render with the exact same cards/CSS as local
// items. Items already present in the local Jellyfin library are returned with
// a real Jellyfin Id (so they open the details modal), while missing items are
// flagged as online so the card renders a "Request" button.

import {
  getSerrAccess,
  fetchOnlineTrending,
  fetchOnlineDiscover,
  fetchOnlineRecommendations,
  fetchOnlineGenres
} from "./api.js";
import { makeApiRequest } from "../../../Plugins/JMSFusion/runtime/api.js";

const TMDB_IMG_BASE = "https://image.tmdb.org/t/p";

let __accessValue = null;
let __accessAt = 0;
const ACCESS_TTL_MS = 30_000;

const genreMapCache = new Map(); // mediaType -> Map(id -> name)
const seedCache = new Map();     // userId|mediaType -> { at, seeds }
const SEED_TTL_MS = 5 * 60_000;

/** Whether online recommendations are enabled and a source is configured. */
export async function onlineRecsAvailable() {
  const now = Date.now();
  if (__accessValue !== null && (now - __accessAt) < ACCESS_TTL_MS) return __accessValue;
  try {
    // Guard the home-render critical path against a hung access request.
    const access = await Promise.race([
      getSerrAccess(),
      new Promise((resolve) => setTimeout(() => resolve(null), 3000))
    ]);
    if (access === null) return __accessValue === true; // timed out: don't poison cache
    const value = access?.onlineRecommendations === true;
    __accessValue = value;
    __accessAt = now;
    return value;
  } catch {
    __accessValue = false;
    __accessAt = now;
    return false;
  }
}

export function invalidateOnlineRecsAccess() {
  __accessValue = null;
  __accessAt = 0;
}

function tmdbImage(path, size) {
  const clean = String(path || "").trim();
  if (!clean) return "";
  const rel = clean.startsWith("/") ? clean : `/${clean}`;
  return `${TMDB_IMG_BASE}/${size}${rel}`;
}

function normalizeOnlineDto(dto) {
  if (!dto || typeof dto !== "object") return null;
  const tmdbId = Number(dto.tmdbId);
  if (!Number.isFinite(tmdbId) || tmdbId <= 0) return null;

  const mediaType = dto.mediaType === "tv" ? "tv" : "movie";
  const type = mediaType === "tv" ? "Series" : "Movie";
  const name = String(dto.title || "").trim();
  if (!name) return null;

  const posterPath = String(dto.posterPath || "");
  const backdropPath = String(dto.backdropPath || "");
  const vote = Number(dto.voteAverage);
  const year = Number(dto.year);
  const localId = dto.local && dto.local.id ? String(dto.local.id).trim() : "";

  const item = {
    Type: type,
    Name: name,
    Overview: String(dto.overview || ""),
    Genres: [],
    // Request pipeline (seerr/ui.js) reads these:
    __tmdbId: tmdbId,
    __mediaType: mediaType,
    posterPath,
    // Card rendering hints:
    __posterUrl: tmdbImage(posterPath, "w500"),
    __backdropUrl: tmdbImage(backdropPath, "w780"),
    __tmdbGenreIds: Array.isArray(dto.genreIds) ? dto.genreIds.slice(0, 6) : [],
    __available: dto.available === true,
    __onlineSource: true
  };

  if (Number.isFinite(year) && year > 0) item.ProductionYear = year;
  if (Number.isFinite(vote) && vote > 0) item.CommunityRating = vote;

  if (localId) {
    // Owned locally: render as a normal, openable Jellyfin card (no Request btn).
    item.Id = localId;
    item.__online = false;
  } else {
    // Missing locally: render as an online card with a Request button.
    item.__online = true;
  }

  return item;
}

async function ensureGenreMap(mediaType) {
  const key = mediaType === "tv" ? "tv" : "movie";
  if (genreMapCache.has(key)) return genreMapCache.get(key);
  const map = new Map();
  try {
    const r = await fetchOnlineGenres({ mediaType: key });
    for (const g of (r?.genres || [])) {
      const id = Number(g?.id);
      if (Number.isFinite(id) && g?.name) map.set(id, String(g.name));
    }
  } catch {}
  genreMapCache.set(key, map);
  return map;
}

async function applyGenreNames(items) {
  const needMovie = items.some(i => i.__mediaType === "movie" && i.__tmdbGenreIds?.length);
  const needTv = items.some(i => i.__mediaType === "tv" && i.__tmdbGenreIds?.length);
  if (!needMovie && !needTv) return;
  const [movieMap, tvMap] = await Promise.all([
    needMovie ? ensureGenreMap("movie") : Promise.resolve(new Map()),
    needTv ? ensureGenreMap("tv") : Promise.resolve(new Map())
  ]);
  for (const item of items) {
    const map = item.__mediaType === "tv" ? tvMap : movieMap;
    const names = (item.__tmdbGenreIds || [])
      .map(id => map.get(Number(id)))
      .filter(Boolean)
      .slice(0, 3);
    if (names.length) item.Genres = names;
  }
}

function interleaveArrays(lists) {
  const out = [];
  const arrays = (lists || []).filter(a => Array.isArray(a) && a.length);
  if (!arrays.length) return out;
  const max = Math.max(...arrays.map(a => a.length));
  for (let i = 0; i < max; i++) {
    for (const arr of arrays) {
      if (i < arr.length) out.push(arr[i]);
    }
  }
  return out;
}

async function finalizeOnlineItems(dtos, { limit = 20 } = {}) {
  const out = [];
  const seen = new Set();
  for (const dto of (dtos || [])) {
    const item = normalizeOnlineDto(dto);
    if (!item) continue;
    const key = `${item.__mediaType}:${item.__tmdbId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= limit) break;
  }
  await applyGenreNames(out);
  return out;
}

async function getWatchHistorySeeds(userId, { mediaType = "", limit = 10 } = {}) {
  if (!userId) return [];
  const cacheKey = `${userId}|${mediaType || "all"}`;
  const cached = seedCache.get(cacheKey);
  if (cached && (Date.now() - cached.at) < SEED_TTL_MS) return cached.seeds.slice(0, limit);

  const types = mediaType === "movie" ? "Movie" : mediaType === "tv" ? "Series" : "Movie,Series";
  const url =
    `/Users/${encodeURIComponent(userId)}/Items?` +
    `Recursive=true&IncludeItemTypes=${types}&Filters=IsPlayed&` +
    `SortBy=DatePlayed,LastPlayedDate&SortOrder=Descending&Limit=${Math.max(1, limit * 2)}&` +
    `Fields=ProviderIds`;
  let seeds = [];
  try {
    const r = await makeApiRequest(url);
    const items = Array.isArray(r?.Items) ? r.Items : [];
    const seen = new Set();
    for (const it of items) {
      const ids = it?.ProviderIds || {};
      const raw = ids.Tmdb ?? ids.TMDb ?? ids.tmdb ?? ids.TheMovieDb ?? ids.MovieDb;
      const tmdbId = Number(raw);
      if (!Number.isFinite(tmdbId) || tmdbId <= 0) continue;
      const t = it?.Type === "Series" ? "tv" : "movie";
      const key = `${t}:${tmdbId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      seeds.push({ tmdbId, mediaType: t });
    }
  } catch {
    seeds = [];
  }
  seedCache.set(cacheKey, { at: Date.now(), seeds });
  return seeds.slice(0, limit);
}

/** Recommendations seeded from what the user recently watched. */
export async function getSeededOnlineItems(userId, { limit = 12, mediaType = "", seedCount = 5 } = {}) {
  if (!(await onlineRecsAvailable())) return [];
  const seeds = await getWatchHistorySeeds(userId, { mediaType, limit: Math.max(seedCount, 6) });
  if (!seeds.length) return [];

  const chosen = seeds.slice(0, Math.max(1, seedCount));
  const lists = await Promise.all(chosen.map(seed =>
    fetchOnlineRecommendations({ mediaType: seed.mediaType, tmdbId: seed.tmdbId })
      .then(r => (Array.isArray(r?.results) ? r.results : []))
      .catch(() => [])
  ));

  const merged = interleaveArrays(lists);
  return finalizeOnlineItems(merged, { limit });
}

/** Online recommendations seeded from a specific "Because you watched" item. */
export async function getSeedItemOnlineRecs({ seedItem = null, seedId = "", userId = "", mediaType = "", limit = 12 } = {}) {
  if (!(await onlineRecsAvailable())) return [];

  let tmdbId = 0;
  let type = mediaType;

  const readTmdb = (ids = {}) => Number(ids.Tmdb ?? ids.TMDb ?? ids.tmdb ?? ids.TheMovieDb ?? ids.MovieDb ?? 0);

  if (seedItem) {
    tmdbId = readTmdb(seedItem.ProviderIds || {}) || Number(seedItem.__tmdbId || 0);
    if (!type) type = seedItem.Type === "Series" ? "tv" : "movie";
  }

  if ((!Number.isFinite(tmdbId) || tmdbId <= 0) && seedId && userId) {
    try {
      const detail = await makeApiRequest(
        `/Users/${encodeURIComponent(userId)}/Items/${encodeURIComponent(seedId)}?Fields=ProviderIds`
      );
      tmdbId = readTmdb(detail?.ProviderIds || {});
      if (!type) type = detail?.Type === "Series" ? "tv" : "movie";
    } catch {}
  }

  if (!Number.isFinite(tmdbId) || tmdbId <= 0) return [];

  const r = await fetchOnlineRecommendations({
    mediaType: type === "tv" ? "tv" : "movie",
    tmdbId
  }).catch(() => null);
  const results = Array.isArray(r?.results) ? r.results : [];
  return finalizeOnlineItems(results, { limit });
}

/** Trending items for a single media type ("movie" | "tv"). */
export async function getTrendingOnlineItems(mediaType = "movie", { limit = 20 } = {}) {
  if (!(await onlineRecsAvailable())) return [];
  const type = mediaType === "tv" ? "tv" : "movie";
  const r = await fetchOnlineTrending({ mediaType: type }).catch(() => null);
  const results = Array.isArray(r?.results) ? r.results : [];
  return finalizeOnlineItems(results, { limit });
}

/** Discover items filtered by a genre name; blends movies and series. */
export async function getGenreOnlineItems(genreName, { limit = 20, mediaType = "" } = {}) {
  if (!genreName || !(await onlineRecsAvailable())) return [];
  const types = mediaType ? [mediaType] : ["movie", "tv"];
  const lists = await Promise.all(types.map(t =>
    fetchOnlineDiscover({ mediaType: t, genre: genreName })
      .then(r => (Array.isArray(r?.results) ? r.results : []))
      .catch(() => [])
  ));
  const merged = interleaveArrays(lists);
  return finalizeOnlineItems(merged, { limit });
}

/** Personalized online items: watch-history seeded, trending as a fallback. */
export async function getPersonalOnlineItems(userId, { limit = 12 } = {}) {
  if (!(await onlineRecsAvailable())) return [];
  let items = await getSeededOnlineItems(userId, { limit: limit * 2 });

  if (items.length < limit) {
    const [movies, series] = await Promise.all([
      getTrendingOnlineItems("movie", { limit }),
      getTrendingOnlineItems("tv", { limit })
    ]);
    items = items.concat(interleaveArrays([movies, series]));
  }

  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = `${item.__mediaType}:${item.__tmdbId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

/** True if the item was produced by this module (online-sourced). */
export function isOnlineSourcedItem(item) {
  return !!(item && item.__onlineSource === true);
}

/** True if the item is missing locally and should show a Request button. */
export function isRequestableOnlineItem(item) {
  return !!(item && item.__online === true && Number(item.__tmdbId) > 0);
}
