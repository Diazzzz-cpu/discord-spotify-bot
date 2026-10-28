import { EmbedBuilder } from 'discord.js';

export interface LyricsResult {
  trackName: string;
  artistName: string;
  albumName?: string;
  lyrics: string;
}

// Bounded O(1) in-memory LRU cache for instant repeated lyrics lookups
const LYRICS_CACHE_MAX = 200;
const lyricsCache = new Map<string, LyricsResult>();

function setCachedLyrics(key: string, value: LyricsResult): void {
  if (lyricsCache.size >= LYRICS_CACHE_MAX) {
    const oldestKey = lyricsCache.keys().next().value;
    if (oldestKey) lyricsCache.delete(oldestKey);
  }
  lyricsCache.set(key, value);
}

function cleanTrackTitle(title: string): string {
  return title
    .replace(/\((?:official|lyric|music|audio|video|visualizer|clean|explicit|hd|4k)[^)]*\)/gi, '')
    .replace(/\[(?:official|lyric|music|audio|video|visualizer|clean|explicit|hd|4k)[^\]]*\]/gi, '')
    .replace(/\s*-\s*topic$/i, '')
    .trim();
}

export async function fetchLyrics(
  title: string,
  artist?: string
): Promise<LyricsResult | null> {
  const cleanedTitle = cleanTrackTitle(title);
  const cleanedArtist = artist
    ? artist.replace(/\s*-\s*topic$/i, '').split(',')[0].trim()
    : '';

  const cacheKey = `${cleanedArtist.toLowerCase()}::${cleanedTitle.toLowerCase()}`;
  const cached = lyricsCache.get(cacheKey);
  if (cached) return cached;

  // 1. Try LRCLIB structured search (track_name + artist_name)
  if (cleanedArtist) {
    try {
      const url = `https://lrclib.net/api/search?track_name=${encodeURIComponent(
        cleanedTitle
      )}&artist_name=${encodeURIComponent(cleanedArtist)}`;
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Spotbot-Discord-Music-Bot/1.0' },
      });
      if (res.ok) {
        const items = (await res.json()) as any[];
        const withLyrics = items.find((item) => item && item.plainLyrics);
        if (withLyrics) {
          const result: LyricsResult = {
            trackName: withLyrics.trackName || cleanedTitle,
            artistName: withLyrics.artistName || cleanedArtist,
            albumName: withLyrics.albumName,
            lyrics: withLyrics.plainLyrics.trim(),
          };
          setCachedLyrics(cacheKey, result);
          return result;
        }
      }
    } catch {
      // Fall through to general search
    }
  }

  // 2. Try LRCLIB general query search
  try {
    const query = [cleanedTitle, cleanedArtist].filter(Boolean).join(' ');
    const url = `https://lrclib.net/api/search?q=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Spotbot-Discord-Music-Bot/1.0' },
    });
    if (res.ok) {
      const items = (await res.json()) as any[];
      const withLyrics = items.find((item) => item && item.plainLyrics);
      if (withLyrics) {
        const result: LyricsResult = {
          trackName: withLyrics.trackName || cleanedTitle,
          artistName: withLyrics.artistName || cleanedArtist || 'Unknown Artist',
          albumName: withLyrics.albumName,
          lyrics: withLyrics.plainLyrics.trim(),
        };
        setCachedLyrics(cacheKey, result);
        return result;
      }
    }
  } catch {
    // Fall through to backup
  }

  // 3. Fallback: lyrics.ovh
  if (cleanedArtist) {
    try {
      const url = `https://api.lyrics.ovh/v1/${encodeURIComponent(
        cleanedArtist
      )}/${encodeURIComponent(cleanedTitle)}`;
      const res = await fetch(url);
      if (res.ok) {
        const data = (await res.json()) as { lyrics?: string };
        if (data?.lyrics) {
          const result: LyricsResult = {
            trackName: cleanedTitle,
            artistName: cleanedArtist,
            lyrics: data.lyrics.trim(),
          };
          setCachedLyrics(cacheKey, result);
          return result;
        }
      }
    } catch {
      // Ignore
    }
  }

  return null;
}

export function buildLyricsEmbed(
  result: LyricsResult,
  thumbnailUrl?: string,
  color = 0x1db954
): EmbedBuilder {
  const maxLen = 3900;
  const text =
    result.lyrics.length > maxLen
      ? result.lyrics.slice(0, maxLen) + '\n\n*... (Lyrics truncated due to length)*'
      : result.lyrics;

  const embed = new EmbedBuilder()
    .setColor(color)
    .setAuthor({ name: `🎤 Lyrics • ${result.artistName}` })
    .setTitle(result.trackName)
    .setDescription(text)
    .setFooter({
      text: result.albumName
        ? `Album: ${result.albumName} • Powered by LRCLIB`
        : 'Powered by LRCLIB',
    });

  if (thumbnailUrl) {
    embed.setThumbnail(thumbnailUrl);
  }

  return embed;
}
