import {
  ActivityType,
  Client,
  Events,
  GatewayIntentBits,
  Message,
  Partials,
  VoiceBasedChannel,
} from 'discord.js';
import { Connectors } from 'shoukaku';
import { Kazagumo, KazagumoPlayer, KazagumoTrack } from 'kazagumo';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { AllRounderSpotifyPlugin } from './spotifyPlugin.js';
import { buildNowPlayingEmbed, buildPlayerButtons } from './ui.js';

const execFileAsync = promisify(execFile);
const YTDLP_PATH = path.resolve(process.cwd(), 'bin', 'yt-dlp.exe');

// Clean up any legacy audio_cache directory so 0 bytes are ever stored on the SSD
const LEGACY_CACHE_DIR = path.resolve(process.cwd(), 'data', 'audio_cache');
try {
  fs.rmSync(LEGACY_CACHE_DIR, { recursive: true, force: true });
} catch {
  // ignore
}

interface CachedStream {
  encoded: string;
  videoId: string;
  length?: number;
  thumbnail?: string;
  expiresAt: number;
}

// Bounded O(1) in-memory LRU cache (45-minute TTL so links stay fresh across long pauses/loops)
const STREAM_CACHE_MAX = 500;
const STREAM_TTL_MS = 45 * 60 * 1000;
const streamCache = new Map<string, CachedStream>();
const inFlightResolutions = new Map<string, Promise<CachedStream | null>>();

function getCachedStream(key: string): CachedStream | null {
  const entry = streamCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    streamCache.delete(key);
    return null;
  }
  return entry;
}

function setCachedStream(key: string, entry: CachedStream): void {
  if (streamCache.size >= STREAM_CACHE_MAX) {
    const oldest = streamCache.keys().next().value;
    if (oldest) streamCache.delete(oldest);
  }
  streamCache.set(key, entry);
}

function evictTrackFromStreamCache(track: KazagumoTrack): void {
  const cleanAuthor = (track.author || '').replace(/ - Topic$/i, '').trim();
  const metaKey = `meta:${cleanAuthor.toLowerCase()}::${(track.title || '').toLowerCase()}`;
  streamCache.delete(metaKey);
  if (track.identifier) streamCache.delete(`yt:${track.identifier}`);
  if ((track as any)._resolvedVideoId) {
    streamCache.delete(`yt:${(track as any)._resolvedVideoId}`);
  }
}

/**
 * Verifies a direct stream URL and resolves any HTTP 302 Google Video CDN redirects
 * so Lavalink's PersistentHttpStream never hits "Not success status code: 302" or 403.
 */
async function verifyAndFollowRedirect(rawUrl: string): Promise<string | null> {
  if (!rawUrl) return null;
  if (rawUrl.includes('.m3u8') || rawUrl.includes('manifest.googlevideo.com')) {
    return rawUrl;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(rawUrl, {
      method: 'GET',
      headers: { Range: 'bytes=0-1024' },
      redirect: 'follow',
      signal: controller.signal,
    });
    const finalUrl = res.url || rawUrl;
    try {
      await res.body?.cancel();
    } catch {
      // ignore
    }
    if (res.status === 200 || res.status === 206) {
      return finalUrl;
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fast 2-stage extraction resistant to YouTube SABR/DASH 403 blocks and 302 CDN redirects:
 * 1. Stage 1: Uses `tv_simply` client with format `18` (44.1kHz stereo AAC progressive stream)
 *    which works across both normal YouTube videos and "- Topic" tracks without 403s.
 * 2. Stage 2: Falls back to `visionos` / `web_embedded` progressive & HLS streams (`139/234/93/18`).
 */
async function extractDirectAudioUrl(videoIdOrUrl: string): Promise<string | null> {
  const target = videoIdOrUrl.startsWith('http')
    ? videoIdOrUrl
    : `https://www.youtube.com/watch?v=${videoIdOrUrl}`;

  // Stage 1: Fast primary extraction using tv_simply format 18 (verified 200/206 + 302-resolved)
  try {
    const { stdout } = await execFileAsync(
      YTDLP_PATH,
      [
        '--js-runtimes',
        'node',
        '--extractor-args',
        'youtube:player_client=tv_simply',
        '-g',
        '-f',
        '18/bestaudio',
        '--no-playlist',
        '--no-warnings',
        target,
      ],
      { timeout: 12000 }
    );
    const candidateUrl = stdout.trim().split(/\r?\n/)[0]?.trim();
    if (candidateUrl) {
      const verified = await verifyAndFollowRedirect(candidateUrl);
      if (verified) return verified;
    }
  } catch {
    // Proceed to Stage 2 fallback
  }

  // Stage 2: Fallback using visionos / web_embedded formats (18, 139, 234, 93)
  try {
    const { stdout } = await execFileAsync(
      YTDLP_PATH,
      [
        '--js-runtimes',
        'node',
        '-g',
        '-f',
        '18/139/234/93/bestaudio[protocol*=m3u8]/bestaudio',
        '--no-playlist',
        '--no-warnings',
        target,
      ],
      { timeout: 14000 }
    );
    const candidateUrl = stdout.trim().split(/\r?\n/)[0]?.trim();
    if (candidateUrl) {
      const verified = await verifyAndFollowRedirect(candidateUrl);
      if (verified) return verified;
      return candidateUrl;
    }
    return null;
  } catch (err) {
    console.error(`[yt-dlp] Failed to extract stream URL for ${target}:`, err);
    return null;
  }
}

/**
 * Fetches genuine YouTube Radio Mix (RD<videoId>) recommendations for Autoplay
 */
async function fetchRadioMixCandidates(
  seedVideoId: string
): Promise<{ id: string; title: string; author: string }[]> {
  try {
    const mixUrl = `https://www.youtube.com/watch?v=${seedVideoId}&list=RD${seedVideoId}`;
    const { stdout } = await execFileAsync(
      YTDLP_PATH,
      [
        '--js-runtimes',
        'node',
        '--flat-playlist',
        '--playlist-end',
        '12',
        '--no-warnings',
        '--print',
        '%(id)s|||%(title)s|||%(uploader)s',
        mixUrl,
      ],
      { timeout: 10000 }
    );
    const lines = stdout
      .trim()
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    const results: { id: string; title: string; author: string }[] = [];
    for (const line of lines) {
      const [id, title, author] = line.split('|||');
      if (id && title && id !== seedVideoId) {
        results.push({
          id: id.trim(),
          title: title.trim(),
          author: (author || 'YouTube Radio').replace(/ - Topic$/i, '').trim(),
        });
      }
    }
    return results;
  } catch {
    return [];
  }
}

function normalizeSongTitle(title: string): string {
  return (title || '')
    .toLowerCase()
    .replace(/\s*\([^)]*\)|\s*\[[^\]]*\]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

export function updateBotPresence(track?: KazagumoTrack): void {
  if (!client.user) return;
  if (track && track.title) {
    const cleanAuthor = (track.author || '').replace(/ - Topic$/i, '').trim();
    const statusText = cleanAuthor
      ? `🎵 ${track.title} — ${cleanAuthor}`
      : `🎵 ${track.title}`;
    client.user.setActivity(statusText.slice(0, 120), {
      type: ActivityType.Listening,
    });
  } else {
    client.user.setActivity('$help | /play', {
      type: ActivityType.Listening,
    });
  }
}

const plugins: any[] = [];

if (config.spotify.clientId && config.spotify.clientSecret) {
  plugins.push(
    new AllRounderSpotifyPlugin({
      clientId: config.spotify.clientId,
      clientSecret: config.spotify.clientSecret,
      market: 'US',
      playlistPageLimit: 5,
    })
  );
  console.log('[Spotify & YTM] All-Rounder Plugin loaded successfully.');
} else {
  console.warn('[Spotify] Credentials not found in .env. Relying on YouTube Music / YouTube search.');
}

async function resolveCandidateVideoId(
  node: any,
  videoId: string,
  resolvedLength?: number,
  resolvedThumbnail?: string
): Promise<CachedStream | null> {
  const directStreamUrl = await extractDirectAudioUrl(videoId);
  if (!directStreamUrl) return null;

  const httpRes = await node.rest.resolve(directStreamUrl);
  if (httpRes?.loadType === 'track' && (httpRes.data as any)?.encoded) {
    return {
      encoded: (httpRes.data as any).encoded,
      videoId,
      length: resolvedLength,
      thumbnail: resolvedThumbnail,
      expiresAt: Date.now() + STREAM_TTL_MS,
    };
  }

  return null;
}

const NON_ORIGINAL_KEYWORDS = [
  'cover',
  'covered by',
  'karaoke',
  'instrumental',
  'tribute',
  'parody',
  'nightcore',
  'slowed',
  'reverb',
  '8d audio',
  'bass boosted',
  'piano version',
  'guitar version',
  'drum cover',
  'vocal cover',
  'acoustic version',
  'live at',
  'live performance',
  'live session',
  'fanmade',
  'lofi',
  'lo-fi',
];

/**
 * Scores a YouTube / YouTube Music search candidate to strongly prioritize the
 * authentic original studio recording by the real artist and reject covers/remakes.
 */
export function scoreStudioCandidate(
  info: { title?: string; author?: string; length?: number },
  targetTitle: string,
  targetAuthor: string,
  targetLength?: number,
  originalRankIndex = 0
): number {
  let score = Math.max(0, 20 - originalRankIndex * 3);
  const candTitle = (info.title || '').toLowerCase();
  const candAuthor = (info.author || '').toLowerCase();
  const candAuthorClean = candAuthor.replace(/ - topic$/i, '').trim();
  const reqTitle = (targetTitle || '').toLowerCase();
  const reqAuthor = (targetAuthor || '').toLowerCase();

  const primaryArtists = reqAuthor
    .split(/,|&|\bfeat\.?\b|\bft\.?\b/i)
    .map((a) => a.trim())
    .filter((a) => a.length >= 2);

  // 1. Heavy penalty for covers, karaoke, live, slowed, instrumental unless requested in targetTitle
  for (const kw of NON_ORIGINAL_KEYWORDS) {
    if (!reqTitle.includes(kw) && !reqAuthor.includes(kw)) {
      if (candTitle.includes(kw) || candAuthor.includes(kw)) {
        score -= 120;
      }
    }
  }

  if (!/\blive\b/i.test(reqTitle) && /\blive\b/i.test(candTitle)) {
    score -= 60;
  }
  if (!/\bremix\b/i.test(reqTitle) && /\bremix\b/i.test(candTitle)) {
    score -= 70;
  }

  // 2. Strong boost if the uploader/author matches the actual artist!
  if (primaryArtists.length > 0) {
    const matchesPrimary = primaryArtists.some(
      (artist) =>
        candAuthorClean.includes(artist) ||
        artist.includes(candAuthorClean) ||
        candTitle.includes(artist)
    );
    if (matchesPrimary) {
      score += 55;
      if (
        candAuthor.endsWith(' - topic') ||
        candAuthor.includes('official') ||
        candAuthor.includes('vevo')
      ) {
        score += 30;
      }
    } else {
      score -= 45;
    }
  } else if (candAuthor.endsWith(' - topic') || candAuthor.includes('vevo')) {
    score += 25;
  }

  // 3. Mandatory Title Match: ensure the candidate is actually the requested song (not just another song by the same artist!)
  const cleanReqTitle = reqTitle.replace(/\s*\([^)]*\)|\s*\[[^\]]*\]/g, '').trim();
  const titleWords = cleanReqTitle
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2);

  if (cleanReqTitle && candTitle.includes(cleanReqTitle)) {
    score += 65;
  } else if (titleWords.length > 0) {
    const matchedTitleWords = titleWords.filter((w) => candTitle.includes(w)).length;
    if (matchedTitleWords === titleWords.length) {
      score += 50;
    } else if (matchedTitleWords === 0 || matchedTitleWords / titleWords.length < 0.5) {
      score -= 180; // Wrong song title!
    }
  }

  // 4. Boost for studio duration match (if known from Spotify)
  if (targetLength && targetLength > 0 && info.length && info.length > 0) {
    const diff = Math.abs(info.length - targetLength);
    if (diff <= 2000) {
      score += 45;
    } else if (diff <= 5000) {
      score += 25;
    } else if (diff > 25000) {
      score -= 40;
    }
  }

  return score;
}

async function resolveTrackStream(
  track: KazagumoTrack,
  forceFresh = false
): Promise<boolean> {
  const now = Date.now();
  const resolvedAt = (track as any)._resolvedAt || 0;

  // Reuse existing stream only if it hasn't expired (45-min freshness window)
  if (
    !forceFresh &&
    (track as any)._httpStreamResolved &&
    track.track &&
    now - resolvedAt < STREAM_TTL_MS
  ) {
    return true;
  }

  const kaz = track.kazagumo || kazagumo;
  const node = await kaz.getLeastUsedNode();
  if (!node) return false;

  const cleanAuthor = (track.author || '').replace(/ - Topic$/i, '').trim();
  const primaryAuthor = cleanAuthor.split(',')[0]?.trim() || cleanAuthor;
  const cacheKey =
    track.sourceName === 'youtube' && track.identifier
      ? `yt:${track.identifier}`
      : `meta:${cleanAuthor.toLowerCase()}::${(track.title || '').toLowerCase()}`;

  if (forceFresh) {
    evictTrackFromStreamCache(track);
  } else {
    // 1. Check O(1) in-memory cache first (0ms latency)
    const cached = getCachedStream(cacheKey);
    if (cached) {
      track.track = cached.encoded;
      track.realUri = track.uri || `https://www.youtube.com/watch?v=${cached.videoId}`;
      if (!track.length && cached.length) track.length = cached.length;
      if (!track.thumbnail && cached.thumbnail) track.thumbnail = cached.thumbnail;
      (track as any)._httpStreamResolved = true;
      (track as any)._resolvedAt = Date.now();
      (track as any)._resolvedVideoId = cached.videoId;
      return true;
    }
  }

  // 2. Deduplicate if already resolving in background pre-fetcher
  let pending = !forceFresh ? inFlightResolutions.get(cacheKey) : undefined;
  if (!pending) {
    pending = (async (): Promise<CachedStream | null> => {
      try {
        // Direct YouTube / YTM track with known video ID
        const knownVideoId =
          (track as any)._resolvedVideoId ||
          (track.sourceName === 'youtube' && track.identifier ? track.identifier : '');

        if (knownVideoId) {
          const directEntry = await resolveCandidateVideoId(
            node,
            knownVideoId,
            track.length,
            track.thumbnail
          );
          if (directEntry) {
            setCachedStream(cacheKey, directEntry);
            setCachedStream(`yt:${directEntry.videoId}`, directEntry);
            return directEntry;
          }
        }

        // Search YouTube Music using primary artist + title for cleanest studio match
        const query = [primaryAuthor, track.title].filter(Boolean).join(' - ');
        let res = await node.rest.resolve(`ytmsearch:${query}`);
        let rawTracks: any[] = res?.loadType === 'search' ? (res.data as any[]) : [];

        if (!rawTracks.length) {
          res = await node.rest.resolve(`ytsearch:${query}`);
          rawTracks = res?.loadType === 'search' ? (res.data as any[]) : [];
        }

        if (!rawTracks.length) return null;

        // Score and sort candidates to reject covers/karaoke/live and pick the authentic original!
        const scored = rawTracks.map((c, idx) => ({
          candidate: c,
          score: scoreStudioCandidate(
            c.info || {},
            track.title || '',
            cleanAuthor,
            track.length,
            idx
          ),
        }));
        scored.sort((a, b) => b.score - a.score);

        // If YTM didn't find a strong match for the song title + artist, also check standard ytsearch
        if (scored[0] && scored[0].score < 60) {
          const fallbackRes = await node.rest.resolve(`ytsearch:${query}`);
          const fallbackTracks: any[] =
            fallbackRes?.loadType === 'search' ? (fallbackRes.data as any[]) : [];
          for (let i = 0; i < fallbackTracks.length; i++) {
            const ft = fallbackTracks[i];
            scored.push({
              candidate: ft,
              score: scoreStudioCandidate(
                ft.info || {},
                track.title || '',
                cleanAuthor,
                track.length,
                i
              ),
            });
          }
          scored.sort((a, b) => b.score - a.score);
        }

        for (const item of scored.slice(0, 3)) {
          const candidate = item.candidate;
          const cid = candidate?.info?.identifier;
          if (!cid) continue;

          const streamEntry = await resolveCandidateVideoId(
            node,
            cid,
            track.length || candidate.info?.length,
            track.thumbnail || candidate.info?.artworkUrl
          );
          if (streamEntry) {
            setCachedStream(cacheKey, streamEntry);
            setCachedStream(`yt:${cid}`, streamEntry);
            return streamEntry;
          }
        }

        return null;
      } finally {
        inFlightResolutions.delete(cacheKey);
      }
    })();

    inFlightResolutions.set(cacheKey, pending);
  }

  const result = await pending;
  if (!result) return false;

  track.track = result.encoded;
  track.realUri = track.uri || `https://www.youtube.com/watch?v=${result.videoId}`;
  if (!track.length && result.length) track.length = result.length;
  if (!track.thumbnail && result.thumbnail) track.thumbnail = result.thumbnail;
  (track as any)._httpStreamResolved = true;
  (track as any)._resolvedAt = Date.now();
  (track as any)._resolvedVideoId = result.videoId;
  return true;
}

/**
 * Non-blocking background pre-fetcher for the next 2 tracks in the queue.
 * Pre-resolves upcoming stream URLs in RAM so transitions and skips are 0ms.
 */
export function prefetchNextTrack(player: KazagumoPlayer): void {
  const candidates = [player.queue[0], player.queue[1]].filter(Boolean);
  for (const nextTrack of candidates) {
    if (!nextTrack) continue;
    const isFresh =
      (nextTrack as any)._httpStreamResolved &&
      Date.now() - ((nextTrack as any)._resolvedAt || 0) < STREAM_TTL_MS;
    if (isFresh) continue;
    setImmediate(() => {
      resolveTrackStream(nextTrack).catch(() => {});
    });
  }
}

export const kazagumo = new Kazagumo(
  {
    defaultSearchEngine: 'youtube_music',
    send: (guildId, payload) => {
      const guild = client.guilds.cache.get(guildId);
      if (guild) guild.shard.send(payload);
    },
    plugins,
    trackResolver: async function (this: KazagumoTrack) {
      return resolveTrackStream(this);
    },
  },
  new Connectors.DiscordJS(client),
  [config.lavalink]
);

const emptyTimeouts = new Map<string, NodeJS.Timeout>();
const aloneTimeouts = new Map<string, NodeJS.Timeout>();
const nowPlayingMessages = new Map<string, Message>();

export async function refreshNowPlayingMessage(player: KazagumoPlayer): Promise<void> {
  const msg = nowPlayingMessages.get(player.guildId);
  if (!msg || !player.queue.current) return;
  try {
    const embed = buildNowPlayingEmbed(player);
    const rows = buildPlayerButtons(player);
    await msg.edit({ embeds: [embed], components: rows });
  } catch {
    // Message may have been deleted
  }
}

// Kazagumo Event Listeners
kazagumo.on('playerStart', async (player, track) => {
  if (emptyTimeouts.has(player.guildId)) {
    clearTimeout(emptyTimeouts.get(player.guildId));
    emptyTimeouts.delete(player.guildId);
  }

  // Apply automatic Anti-Spike / Ear-Safe EQ protection on initial playback
  // Uses 0.95 base filter gain + default 85% player volume for crisp loudness with zero clipping
  if (!(player as any)._earSafeInitialized) {
    (player as any)._earSafeInitialized = true;
    player.shoukaku
      .setFilters({
        volume: 0.95,
        equalizer: [
          { band: 9, gain: -0.05 },  // 2.5 kHz (harsh upper-mids)
          { band: 10, gain: -0.08 }, // 4.0 kHz (ear canal resonance peak)
          { band: 11, gain: -0.08 }, // 6.3 kHz (piercing sibilance)
          { band: 12, gain: -0.06 }, // 10 kHz (sharp treble transients)
          { band: 13, gain: -0.04 }, // 16 kHz (high-frequency hiss/spikes)
        ],
      })
      .catch(() => {});
  }

  // Maintain previousTracks stack for $back / $prev & ⏮️ Prev button
  if (!(player as any).previousTracks) {
    (player as any).previousTracks = [];
  }
  const prevStack: KazagumoTrack[] = (player as any).previousTracks;
  const prevLast: KazagumoTrack | undefined = (player as any).lastTrack;
  if (
    prevLast &&
    !(player as any)._isGoingBack &&
    (prevLast.identifier !== track.identifier || prevLast.title !== track.title)
  ) {
    prevStack.push(prevLast);
    if (prevStack.length > 25) prevStack.shift();
  }
  (player as any)._isGoingBack = false;

  // Record last played track and rolling history for Smart Autoplay
  (player as any).lastTrack = track;
  if (!(player as any).historyIds) {
    (player as any).historyIds = new Set<string>();
  }
  const historySet: Set<string> = (player as any).historyIds;
  historySet.add(normalizeSongTitle(track.title || ''));
  if (track.identifier) historySet.add(track.identifier);
  if ((track as any)._resolvedVideoId) historySet.add((track as any)._resolvedVideoId);
  if (historySet.size > 40) {
    const first = historySet.values().next().value;
    if (first) historySet.delete(first);
  }

  // Update Live Discord Bot Status
  updateBotPresence(track);

  // Kick off non-blocking background pre-fetch for the next 2 tracks in queue
  prefetchNextTrack(player);

  if (!player.textId) return;
  const channel = client.channels.cache.get(player.textId);
  if (channel && channel.isTextBased() && 'send' in channel) {
    const prevMsg = nowPlayingMessages.get(player.guildId);
    if (prevMsg) {
      prevMsg.delete().catch(() => {});
      nowPlayingMessages.delete(player.guildId);
    }

    try {
      const embed = buildNowPlayingEmbed(player, track);
      const rows = buildPlayerButtons(player);
      const sent = await channel.send({ embeds: [embed], components: rows });
      nowPlayingMessages.set(player.guildId, sent);
    } catch (err) {
      console.error('[NowPlaying Send Error]:', err);
    }
  }
});

kazagumo.on('playerEmpty', async (player) => {
  // Check if Autoplay / Radio mode is enabled
  const autoplay = Boolean((player as any).autoplay);
  const lastTrack: KazagumoTrack | undefined = (player as any).lastTrack;

  if (autoplay && lastTrack) {
    try {
      const historySet: Set<string> = (player as any).historyIds || new Set();
      const lastNormTitle = normalizeSongTitle(lastTrack.title || '');
      const seedVideoId =
        (lastTrack as any)._resolvedVideoId ||
        (lastTrack.sourceName === 'youtube' ? lastTrack.identifier : '') ||
        '';

      // 1. Primary: Fetch genuine YouTube Radio Mix (RD<videoId>) for real artist/vibe variety
      if (seedVideoId) {
        const mixCandidates = await fetchRadioMixCandidates(seedVideoId);
        const chosenMix = mixCandidates.find((c) => {
          const norm = normalizeSongTitle(c.title);
          return (
            !historySet.has(c.id) &&
            !historySet.has(norm) &&
            norm !== lastNormTitle &&
            !/\b(cover|karaoke|instrumental|slowed|nightcore)\b/i.test(c.title)
          );
        });

        if (chosenMix) {
          const searchRes = await kazagumo.search(
            `https://www.youtube.com/watch?v=${chosenMix.id}`,
            {
              requester: lastTrack.requester,
            }
          );
          if (searchRes.tracks[0]) {
            player.queue.add(searchRes.tracks[0]);
            await player.play();
            return;
          }
        }
      }

      // 2. Fallback: Search other songs by the artist (excluding the same song title!)
      const cleanAuthor = (lastTrack.author || '').replace(/ - Topic$/i, '').trim();
      const primaryAuthor = cleanAuthor.split(',')[0]?.trim() || cleanAuthor;
      const searchRes = await kazagumo.search(`${primaryAuthor} top songs`, {
        engine: 'youtube_music',
        requester: lastTrack.requester,
      });

      const candidate = searchRes.tracks.find((t) => {
        const norm = normalizeSongTitle(t.title || '');
        return (
          t.identifier !== lastTrack.identifier &&
          norm !== lastNormTitle &&
          !historySet.has(norm) &&
          !historySet.has(t.identifier)
        );
      });

      if (candidate) {
        player.queue.add(candidate);
        await player.play();
        return;
      }
    } catch (err) {
      console.error('[Autoplay Error]:', err);
    }
  }

  updateBotPresence();

  const prevMsg = nowPlayingMessages.get(player.guildId);
  if (prevMsg) {
    prevMsg.edit({ components: [] }).catch(() => {});
    nowPlayingMessages.delete(player.guildId);
  }

  if (!player.textId) return;
  const channel = client.channels.cache.get(player.textId);

  if (!emptyTimeouts.has(player.guildId)) {
    const timeout = setTimeout(() => {
      if (player && player.queue.isEmpty && !player.playing) {
        if (channel && channel.isTextBased() && 'send' in channel) {
          channel.send('📭 Queue has been empty for 1 minute. Disconnecting...');
        }
        player.destroy();
      }
      emptyTimeouts.delete(player.guildId);
    }, 60000);

    emptyTimeouts.set(player.guildId, timeout);
  }
});

kazagumo.on('playerDestroy', (player) => {
  if (emptyTimeouts.has(player.guildId)) {
    clearTimeout(emptyTimeouts.get(player.guildId));
    emptyTimeouts.delete(player.guildId);
  }
  if (aloneTimeouts.has(player.guildId)) {
    clearTimeout(aloneTimeouts.get(player.guildId));
    aloneTimeouts.delete(player.guildId);
  }
  const prevMsg = nowPlayingMessages.get(player.guildId);
  if (prevMsg) {
    prevMsg.edit({ components: [] }).catch(() => {});
    nowPlayingMessages.delete(player.guildId);
  }
  updateBotPresence();
});

// Automatic Mid-Song 403/302 Stream Recovery (fetches fresh URL & resumes at exact millisecond)
kazagumo.on('playerException', async (player, data) => {
  console.error(`[Player Exception] Guild ${player.guildId}:`, data);
  const current = player.queue.current || (player as any).lastTrack;

  if (current && !(current as any)._retriedMidStream) {
    (current as any)._retriedMidStream = true;
    const resumePos = Math.max(
      0,
      (player.position || (data as any)?.track?.info?.position || 0) - 500
    );
    console.log(
      `[Stream Recovery] Attempting seamless recovery for "${current.title}" at ${resumePos}ms...`
    );

    try {
      const ok = await resolveTrackStream(current, true);
      if (ok && current.track) {
        if (!player.queue.current) {
          player.queue.current = current;
        }
        player.playing = true;
        await player.shoukaku.playTrack({
          track: { encoded: current.track },
          position: resumePos,
        });
        console.log(
          `[Stream Recovery] Successfully resumed "${current.title}" at ${resumePos}ms!`
        );
        return;
      }
    } catch (recErr) {
      console.error(`[Stream Recovery] Retry failed for "${current.title}":`, recErr);
    }
  }

  if (player.textId) {
    const channel = client.channels.cache.get(player.textId);
    if (channel && channel.isTextBased() && 'send' in channel) {
      channel.send('⚠️ Encountered an issue streaming that audio source. Skipping to next track...');
    }
  }
});

kazagumo.on('playerResolveError', (player, track, message) => {
  console.error(`[Player Resolve Error] Guild ${player.guildId} (${track.title}):`, message);
  if (player.textId) {
    const channel = client.channels.cache.get(player.textId);
    if (channel && channel.isTextBased() && 'send' in channel) {
      channel.send(`⚠️ Could not find an audio stream for **${track.title}**. Skipping...`);
    }
  }
});

// Zero-overhead Empty Voice Channel Detection (uses in-memory cache, 0 network calls)
client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  const guildId = oldState.guild.id || newState.guild.id;
  const player = kazagumo.players.get(guildId);
  if (!player || !player.voiceId) return;

  const vc = client.channels.cache.get(player.voiceId) as VoiceBasedChannel | undefined;
  if (!vc || !vc.members) return;

  const humanCount = vc.members.filter((m) => !m.user.bot).size;
  const textChannel = player.textId ? client.channels.cache.get(player.textId) : undefined;

  if (humanCount === 0) {
    if (!aloneTimeouts.has(guildId)) {
      if (!player.paused && player.playing) {
        player.pause(true);
        (player as any)._autoPausedByEmptyVC = true;
        refreshNowPlayingMessage(player);
      }

      const timeout = setTimeout(() => {
        const currentPlayer = kazagumo.players.get(guildId);
        if (currentPlayer) {
          if (textChannel && textChannel.isTextBased() && 'send' in textChannel) {
            textChannel.send('👋 Everyone left the voice channel. Disconnecting to save resources!');
          }
          currentPlayer.destroy();
        }
        aloneTimeouts.delete(guildId);
      }, 60000);

      aloneTimeouts.set(guildId, timeout);
    }
  } else {
    // A human rejoined the voice channel!
    if (aloneTimeouts.has(guildId)) {
      clearTimeout(aloneTimeouts.get(guildId));
      aloneTimeouts.delete(guildId);

      if ((player as any)._autoPausedByEmptyVC && player.paused) {
        (player as any)._autoPausedByEmptyVC = false;
        player.pause(false);
        refreshNowPlayingMessage(player);
      }
    }
  }
});

// Shoukaku (Lavalink) Node Events
kazagumo.shoukaku.on('ready', (name) => {
  console.log(`[Lavalink] Node "${name}" is connected and ready!`);
  updateBotPresence();
});

kazagumo.shoukaku.on('error', (name, error) => {
  console.error(`[Lavalink] Node "${name}" error:`, error);
});

kazagumo.shoukaku.on('close', (name, code, reason) => {
  console.warn(`[Lavalink] Node "${name}" closed (${code}): ${reason}`);
});

kazagumo.shoukaku.on('disconnect', (name, count) => {
  console.warn(`[Lavalink] Node "${name}" disconnected. Reconnect attempt #${count}`);
});
