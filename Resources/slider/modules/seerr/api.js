const SERR_ENDPOINT = "/Plugins/MonWUI/seerr";

let accessCache = null;
let accessCacheAt = 0;
const ACCESS_CACHE_MS = 30_000;

function tokenSafe() {
  try {
    return window.ApiClient?.accessToken?.() || window.ApiClient?._accessToken || "";
  } catch {
    return "";
  }
}

async function userIdSafe() {
  try {
    const user = await window.ApiClient?.getCurrentUser?.();
    return user?.Id || "";
  } catch {
    return "";
  }
}

async function headers(json = true) {
  const h = { Accept: "application/json" };
  if (json) h["Content-Type"] = "application/json";
  const token = tokenSafe();
  const userId = await userIdSafe();
  if (token) h["X-Emby-Token"] = token;
  if (userId) h["X-Emby-UserId"] = userId;
  return h;
}

async function request(path = "", options = {}) {
  const res = await fetch(`${SERR_ENDPOINT}${path}`, {
    cache: "no-store",
    ...options,
    headers: {
      ...(await headers(options.body !== undefined)),
      ...(options.headers || {})
    }
  });

  const text = await res.text();
  let data = {};
  if (text) {
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
  }

  if (!res.ok) {
    const message = data?.error || data?.message || `Seerr HTTP ${res.status}`;
    const error = new Error(message);
    error.status = res.status;
    error.payload = data;
    throw error;
  }

  return data;
}

export async function getSerrAccess({ force = false } = {}) {
  const now = Date.now();
  if (!force && accessCache && (now - accessCacheAt) < ACCESS_CACHE_MS) {
    return accessCache;
  }

  accessCache = await request("/access");
  accessCacheAt = Date.now();
  return accessCache;
}

export async function getSerrSettings() {
  return request("/settings");
}

export async function saveSerrSettings(settings = {}) {
  accessCache = null;
  return request("/settings", {
    method: "POST",
    body: JSON.stringify(settings || {})
  });
}

export async function testSerrConnection() {
  return request("/test", { method: "POST", body: JSON.stringify({}) });
}

export async function searchSerr(query, { page = 1, language = "" } = {}) {
  const qs = new URLSearchParams();
  qs.set("query", String(query || "").trim());
  qs.set("page", String(Math.max(1, Number(page) || 1)));
  if (language) qs.set("language", language);
  return request(`/search?${qs.toString()}`);
}

function metadataQuery({ language = "" } = {}) {
  const qs = new URLSearchParams();
  if (language) qs.set("language", language);
  const out = qs.toString();
  return out ? `?${out}` : "";
}

export async function getSerrTvDetails(id, options = {}) {
  const clean = Number(id);
  if (!Number.isFinite(clean) || clean <= 0) return null;
  return request(`/metadata/tv/${encodeURIComponent(String(Math.floor(clean)))}${metadataQuery(options)}`);
}

export async function getSerrTvSeasonDetails(id, seasonNumber, options = {}) {
  const clean = Number(id);
  const season = Number(seasonNumber);
  if (!Number.isFinite(clean) || clean <= 0 || !Number.isFinite(season) || season < 0) return null;
  return request(`/metadata/tv/${encodeURIComponent(String(Math.floor(clean)))}/season/${encodeURIComponent(String(Math.floor(season)))}${metadataQuery(options)}`);
}

export async function getSerrMovieDetails(id, options = {}) {
  const clean = Number(id);
  if (!Number.isFinite(clean) || clean <= 0) return null;
  return request(`/metadata/movie/${encodeURIComponent(String(Math.floor(clean)))}${metadataQuery(options)}`);
}

export async function getSerrCollectionDetails(id, options = {}) {
  const clean = Number(id);
  if (!Number.isFinite(clean) || clean <= 0) return null;
  return request(`/metadata/collection/${encodeURIComponent(String(Math.floor(clean)))}${metadataQuery(options)}`);
}

export async function searchSerrCollections(query, { page = 1, language = "" } = {}) {
  const qs = new URLSearchParams();
  qs.set("query", String(query || "").trim());
  qs.set("page", String(Math.max(1, Number(page) || 1)));
  if (language) qs.set("language", language);
  return request(`/metadata/collection/search?${qs.toString()}`);
}

export async function searchJellyfinByTmdbId(id) {
  const clean = Number(id);
  if (!Number.isFinite(clean) || clean <= 0) return { ok: false, items: [] };
  return request(`/local/tmdb/${encodeURIComponent(String(Math.floor(clean)))}`);
}

function onlineQuery(params = {}) {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    qs.set(key, String(value));
  }
  const out = qs.toString();
  return out ? `?${out}` : "";
}

export async function fetchOnlineTrending({ mediaType = "movie", page = 1, language = "", limit = 0 } = {}) {
  return request(`/online/trending${onlineQuery({ mediaType, page, language, limit: limit || undefined })}`);
}

export async function fetchOnlineDiscover({ mediaType = "movie", genre = "", sortBy = "", page = 1, language = "", limit = 0 } = {}) {
  return request(`/online/discover${onlineQuery({ mediaType, genre, sortBy, page, language, limit: limit || undefined })}`);
}

export async function fetchOnlinePopular({ mediaType = "movie", region = "", page = 1, language = "", limit = 0 } = {}) {
  return request(`/online/popular${onlineQuery({ mediaType, region, page, language, limit: limit || undefined })}`);
}

export async function fetchOnlineRecommendations({ mediaType = "movie", tmdbId = 0, page = 1, language = "", limit = 0 } = {}) {
  const clean = Number(tmdbId);
  if (!Number.isFinite(clean) || clean <= 0) return { ok: true, results: [] };
  return request(`/online/recommendations${onlineQuery({ mediaType, tmdbId: Math.floor(clean), page, language, limit: limit || undefined })}`);
}

export async function fetchOnlineGenres({ mediaType = "movie", language = "" } = {}) {
  return request(`/online/genres${onlineQuery({ mediaType, language })}`);
}

export async function createSerrRequest(payload = {}) {
  return request("/request", {
    method: "POST",
    body: JSON.stringify(payload || {})
  });
}

export async function listSerrRequests({ includeHistory = false, includeDownloads = true } = {}) {
  const qs = new URLSearchParams();
  if (includeHistory) qs.set("includeHistory", "true");
  if (!includeDownloads) qs.set("includeDownloads", "false");
  const query = qs.toString();
  return request(`/requests${query ? `?${query}` : ""}`);
}

export async function approveSerrRequest(id) {
  return request(`/requests/${encodeURIComponent(String(id || ""))}/approve`, {
    method: "POST",
    body: JSON.stringify({})
  });
}

export async function upgradeSerrRequest4K(id) {
  return request(`/requests/${encodeURIComponent(String(id || ""))}/upgrade4k`, {
    method: "POST",
    body: JSON.stringify({})
  });
}

export async function declineSerrRequest(id) {
  return request(`/requests/${encodeURIComponent(String(id || ""))}/decline`, {
    method: "POST",
    body: JSON.stringify({})
  });
}

export async function withdrawSerrRequest(id) {
  return request(`/requests/${encodeURIComponent(String(id || ""))}/withdraw`, {
    method: "POST",
    body: JSON.stringify({})
  });
}
