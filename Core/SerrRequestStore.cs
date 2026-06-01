using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;

namespace Jellyfin.Plugin.JMSFusion
{
    internal static class SerrRequestStore
    {
        private const int MaxStoredRequests = 300;
        private const string StoreFileName = "requests.json";
        private static readonly object SyncRoot = new();
        private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
        {
            WriteIndented = false
        };

        public static bool Save(JMSFusionConfiguration cfg)
        {
            if (cfg is null) return false;

            lock (SyncRoot)
            {
                var disk = ReadNoLock();
                var current = Normalize(cfg.SerrRequests);
                var merged = Merge(current, disk);
                var changed = !Equivalent(current, merged);
                if (changed)
                {
                    cfg.SerrRequests = merged;
                    cfg.SerrRequestsRevision = NowMs();
                }

                if (merged.Count > 0)
                {
                    WriteNoLock(merged);
                }

                return changed;
            }
        }

        private static List<SerrRequestEntry> Merge(IEnumerable<SerrRequestEntry> current, IEnumerable<SerrRequestEntry> disk)
        {
            var byId = new Dictionary<string, SerrRequestEntry>(StringComparer.OrdinalIgnoreCase);
            foreach (var entry in Normalize(current))
            {
                byId[entry.Id] = entry;
            }

            foreach (var entry in Normalize(disk))
            {
                if (!byId.TryGetValue(entry.Id, out var existing) || VersionOf(entry) > VersionOf(existing))
                {
                    byId[entry.Id] = entry;
                }
            }

            return byId.Values
                .OrderByDescending(entry => VersionOf(entry))
                .Take(MaxStoredRequests)
                .ToList();
        }

        private static List<SerrRequestEntry> Normalize(IEnumerable<SerrRequestEntry>? source)
        {
            return (source ?? Array.Empty<SerrRequestEntry>())
                .Where(entry => entry is not null)
                .Select(NormalizeEntry)
                .OrderByDescending(entry => VersionOf(entry))
                .Take(MaxStoredRequests)
                .ToList();
        }

        private static SerrRequestEntry NormalizeEntry(SerrRequestEntry entry)
        {
            entry.Id = string.IsNullOrWhiteSpace(entry.Id) ? Guid.NewGuid().ToString("N") : entry.Id.Trim();
            entry.JellyfinUserId = entry.JellyfinUserId?.Trim() ?? string.Empty;
            entry.JellyfinUserName = entry.JellyfinUserName?.Trim() ?? string.Empty;
            entry.Title = entry.Title?.Trim() ?? string.Empty;
            entry.MediaType = NormalizeMediaType(entry.MediaType);
            entry.Source = entry.Source?.Trim() ?? string.Empty;
            entry.JellyfinItemId = entry.JellyfinItemId?.Trim() ?? string.Empty;
            entry.Status = string.IsNullOrWhiteSpace(entry.Status) ? "pending" : entry.Status.Trim().ToLowerInvariant();
            entry.Error = entry.Error?.Trim() ?? string.Empty;
            entry.Seasons = (entry.Seasons ?? new List<int>())
                .Where(season => season > 0)
                .Distinct()
                .OrderBy(season => season)
                .ToList();
            entry.Episodes = (entry.Episodes ?? new List<SerrEpisodeSelectionEntry>())
                .Where(ep => ep is not null && ep.SeasonNumber > 0 && ep.EpisodeNumber > 0)
                .OrderBy(ep => ep.SeasonNumber)
                .ThenBy(ep => ep.EpisodeNumber)
                .ToList();
            return entry;
        }

        private static string NormalizeMediaType(string? value)
        {
            var clean = (value ?? string.Empty).Trim().ToLowerInvariant();
            return clean switch
            {
                "movie" or "movies" => "movie",
                "tv" or "series" or "show" or "shows" => "tv",
                _ => clean
            };
        }

        private static long VersionOf(SerrRequestEntry entry)
            => Math.Max(entry.UpdatedAtUtc, Math.Max(entry.CompletedAtUtc, entry.CreatedAtUtc));

        private static bool Equivalent(List<SerrRequestEntry> left, List<SerrRequestEntry> right)
            => JsonSerializer.Serialize(left, JsonOptions) == JsonSerializer.Serialize(right, JsonOptions);

        private static List<SerrRequestEntry> ReadNoLock()
        {
            try
            {
                var path = StorePath();
                if (string.IsNullOrWhiteSpace(path) || !File.Exists(path)) return new List<SerrRequestEntry>();
                var raw = File.ReadAllText(path);
                return JsonSerializer.Deserialize<List<SerrRequestEntry>>(raw, JsonOptions) ?? new List<SerrRequestEntry>();
            }
            catch
            {
                return new List<SerrRequestEntry>();
            }
        }

        private static void WriteNoLock(List<SerrRequestEntry> requests)
        {
            try
            {
                var path = StorePath();
                if (string.IsNullOrWhiteSpace(path)) return;
                var directory = Path.GetDirectoryName(path);
                if (!string.IsNullOrWhiteSpace(directory)) Directory.CreateDirectory(directory);
                var tmp = path + ".tmp";
                File.WriteAllText(tmp, JsonSerializer.Serialize(requests, JsonOptions));
                File.Move(tmp, path, true);
            }
            catch
            {
            }
        }

        private static string StorePath()
        {
            var plugin = JMSFusionPlugin.Instance;
            return plugin is null ? string.Empty : Path.Combine(plugin.GetStorageDirectory("seerr"), StoreFileName);
        }

        private static long NowMs() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    }
}
