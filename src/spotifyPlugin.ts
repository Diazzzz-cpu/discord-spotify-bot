import {
  Kazagumo,
  KazagumoError,
  KazagumoPlugin as BaseKazagumoPlugin,
  KazagumoSearchOptions,
  KazagumoSearchResult,
  KazagumoTrack,
  SearchResultTypes,
} from 'kazagumo';

export interface CustomSpotifyOptions {
  clientId: string;
  clientSecret: string;
  market?: string;
  playlistPageLimit?: number;
}

const SPOTIFY_REGEX =
  /(?:https?:\/\/open\.spotify\.com\/(?:intl-[a-zA-Z-]+\/)?|spotify:)(?:user\/[A-Za-z0-9]+\/)?(track|playlist|album|artist)[/:]([A-Za-z0-9]+)/;
const SHORT_LINK_REGEX = /^https?:\/\/(?:spotify\.link|spoti\.fi)\/[A-Za-z0-9]+/;

function getQueryWords(query: string): string[] {
  const stopWords = new Set([
    'the',
    'and',
    'for',
    'with',
    'official',
    'lyrics',
    'lyric',
    'audio',
    'video',
    'song',
    'music',
    'by',
  ]);
  const words = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !stopWords.has(w));
  if (words.length > 0) return words;
  return query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function isFuzzyWordMatch(word: string, textWords: string[], fullText: string): boolean {
  if (fullText.includes(word)) return true;
  if (word.length < 4) return false;
  for (const tw of textWords) {
    if (tw.length < 4) continue;
    if (tw.startsWith(word) || word.startsWith(tw)) return true;
    // Allow 1-character typo (e.g. "galaway" vs "galway", "willi" vs "willie")
    if (Math.abs(word.length - tw.length) <= 1 && word.slice(0, 3) === tw.slice(0, 3)) {
      let diffs = 0;
      let i = 0;
      let j = 0;
      while (i < word.length && j < tw.length) {
        if (word[i] === tw[j]) {
          i++;
          j++;
        } else {
          diffs++;
          if (diffs > 1) break;
          if (word.length > tw.length) i++;
          else if (tw.length > word.length) j++;
          else {
            i++;
            j++;
          }
        }
      }
      diffs += word.length - i + (tw.length - j);
      if (diffs <= 1) return true;
    }
  }
  return false;
}

function isCoverOrAiTrack(title: string, author: string, rawQuery: string): boolean {
  const qLower = rawQuery.toLowerCase();
  const tLower = (title || '').toLowerCase();
  const aLower = (author || '').toLowerCase();
  const penaltyKeywords = [
    'cover',
    'covered by',
    'karaoke',
    'instrumental',
    'tribute',
    'parody',
    'nightcore',
    'slowed',
    'reverb',
    '8d',
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
    'ai cover',
    'ai soul',
    'raimagined',
    'wanderers of the dark',
    'soul cover',
  ];

  for (const kw of penaltyKeywords) {
    if (!qLower.includes(kw) && (tLower.includes(kw) || aLower.includes(kw))) {
      return true;
    }
  }
  if (
    !/\b(soul|acoustic|piano|guitar|live|lofi|lo-fi|remix)\b/i.test(qLower) &&
    /\((?:soul|acoustic|piano|guitar|live|lofi|lo-fi|remix)[^)]*\)/i.test(title)
  ) {
    return true;
  }
  return false;
}

function matchesAllQueryWords(title: string, author: string, queryWords: string[]): boolean {
  if (!queryWords.length) return true;
  const cleanTitle = (title || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
  const cleanAuthor = (author || '')
    .replace(/ - Topic$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ');
  const combined = `${cleanTitle} ${cleanAuthor}`;
  const combinedTokens = combined.split(/\s+/).filter(Boolean);
  const titleTokens = cleanTitle.split(/\s+/).filter(Boolean);

  const allInCombined = queryWords.every((w) => isFuzzyWordMatch(w, combinedTokens, combined));
  const anyInTitle = queryWords.some((w) => isFuzzyWordMatch(w, titleTokens, cleanTitle));
  return allInCombined && anyInTitle;
}

export class KazagumoPlugin extends BaseKazagumoPlugin {
  private readonly options: CustomSpotifyOptions;
  private kazagumo: Kazagumo | null = null;
  private _search:
    | ((query: string, options?: KazagumoSearchOptions) => Promise<KazagumoSearchResult>)
    | null = null;
  private accessToken = '';
  private tokenExpiresAt = 0;

  constructor(options: CustomSpotifyOptions) {
    super();
    this.options = {
      market: 'US',
      playlistPageLimit: 5,
      ...options,
    };
  }

  public load(kazagumo: Kazagumo): void {
    this.kazagumo = kazagumo;
    this._search = kazagumo.search.bind(kazagumo);
    kazagumo.search = this.search.bind(this);
  }

  public unload(): void {
    if (this.kazagumo && this._search) {
      this.kazagumo.search = this._search;
    }
  }

  private async getToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt) {
      return this.accessToken;
    }

    const basic = Buffer.from(`${this.options.clientId}:${this.options.clientSecret}`).toString(
      'base64'
    );
    const response = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });

    if (!response.ok) {
      throw new Error(`Spotify auth failed with status ${response.status}`);
    }

    const data = (await response.json()) as { access_token: string; expires_in: number };
    this.accessToken = data.access_token;
    this.tokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;
    return this.accessToken;
  }

  private async apiRequest<T = any>(endpoint: string): Promise<T> {
    const token = await this.getToken();
    const url = endpoint.startsWith('http')
      ? endpoint
      : `https://api.spotify.com/v1${endpoint}`;

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      throw new Error(`Spotify API error ${res.status} on ${endpoint}`);
    }

    return (await res.json()) as T;
  }

  /**
   * Fallback/Primary extractor using Spotify's Embed JSON (__NEXT_DATA__).
   * Works even on Spotify playlists where /v1/playlists/{id}/tracks returns 403 in Dev Mode,
   * as well as algorithmic/editorial Spotify playlists.
   */
  private async fetchEmbedEntity(type: string, id: string): Promise<any> {
    const url = `https://open.spotify.com/embed/${type}/${id}`;
    const res = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      },
    });

    if (!res.ok) {
      throw new Error(`Spotify embed fetch failed (${res.status})`);
    }

    const html = await res.text();
    const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([^<]+)<\/script>/);
    if (!match || !match[1]) {
      throw new Error('Could not parse Spotify embed data');
    }

    const json = JSON.parse(match[1]);
    return json?.props?.pageProps?.state?.data?.entity;
  }

  public async search(
    query: string,
    options?: KazagumoSearchOptions
  ): Promise<KazagumoSearchResult> {
    if (!this.kazagumo || !this._search) {
      throw new KazagumoError(1, 'AllRounderSpotifyPlugin is not initialized');
    }

    let targetQuery = query.trim();

    // Resolve short links like spotify.link / spoti.fi
    if (SHORT_LINK_REGEX.test(targetQuery)) {
      try {
        const res = await fetch(targetQuery, { method: 'HEAD', redirect: 'follow' });
        if (res.url) targetQuery = res.url;
      } catch {
        // ignore redirect failure and continue
      }
    }

    const match = SPOTIFY_REGEX.exec(targetQuery);
    if (match) {
      const [, type, id] = match;
      try {
        switch (type) {
          case 'track': {
            const track = await this.fetchTrack(id, options?.requester);
            return this.buildResult(undefined, track ? [track] : [], 'TRACK');
          }
          case 'playlist': {
            const playlist = await this.fetchPlaylist(id, options?.requester);
            return this.buildResult(playlist.name, playlist.tracks, 'PLAYLIST');
          }
          case 'album': {
            const album = await this.fetchAlbum(id, options?.requester);
            return this.buildResult(album.name, album.tracks, 'PLAYLIST');
          }
          case 'artist': {
            const artist = await this.fetchArtist(id, options?.requester);
            return this.buildResult(artist.name, artist.tracks, 'PLAYLIST');
          }
        }
      } catch (err) {
        console.error(`[SpotifyPlugin] Failed to resolve Spotify ${type} (${id}):`, err);
        return this.buildResult(undefined, [], 'SEARCH');
      }
    }

    // Handle explicit Spotify text search when options.engine === 'spotify'
    const isUrl = /^https?:\/\//.test(targetQuery);
    if (options?.engine === 'spotify' && !isUrl) {
      try {
        const tracks = await this.searchTracks(targetQuery, options?.requester);
        return this.buildResult(undefined, tracks, 'SEARCH');
      } catch (err) {
        console.error('[SpotifyPlugin] Spotify search failed, falling back to default:', err);
      }
    }

    // Delegate non-Spotify queries to Kazagumo's base search (e.g. YouTube Music / YouTube)
    const result = await this._search(targetQuery, options);

    // Ensure text searches actually fulfill the requested song & reject covers/unrelated YTM results
    if (result.type === 'SEARCH' && !isUrl) {
      const queryWords = getQueryWords(targetQuery);
      const firstTrack = result.tracks[0];
      const firstIsExactOriginal =
        firstTrack &&
        matchesAllQueryWords(firstTrack.title || '', firstTrack.author || '', queryWords) &&
        !isCoverOrAiTrack(firstTrack.title || '', firstTrack.author || '', targetQuery);

      if (!firstIsExactOriginal) {
        // YTM's #1 result did not match the requested song (e.g. song isn't in YTM's Songs tab)
        // or was a cover/AI remake — fetch standard YouTube search results as well!
        let ytTracks: KazagumoTrack[] = [];
        if (options?.engine !== 'youtube') {
          try {
            const ytRes = await this._search(targetQuery, {
              ...options,
              requester: options?.requester,
              engine: 'youtube',
            });
            if (ytRes?.tracks?.length) {
              ytTracks = ytRes.tracks;
            }
          } catch {
            // ignore fallback error
          }
        }

        // First look for valid YouTube tracks that match all query words and aren't covers
        const validYt = ytTracks.filter(
          (t) =>
            matchesAllQueryWords(t.title || '', t.author || '', queryWords) &&
            !isCoverOrAiTrack(t.title || '', t.author || '', targetQuery)
        );
        const officialYt = validYt.find((t) =>
          /\b(official|vevo|topic)\b/i.test(`${t.title || ''} ${t.author || ''}`)
        );
        const validYtm = result.tracks.filter(
          (t) =>
            matchesAllQueryWords(t.title || '', t.author || '', queryWords) &&
            !isCoverOrAiTrack(t.title || '', t.author || '', targetQuery)
        );

        const bestMatch = officialYt || validYt[0] || validYtm[0] || ytTracks[0] || firstTrack;
        if (bestMatch) {
          const remaining = [...result.tracks, ...ytTracks].filter(
            (t) => t.identifier !== bestMatch.identifier
          );
          result.tracks = [bestMatch, ...remaining];
        }
      }
    }

    // Enhance YouTube Music / YouTube track metadata (preserve square cover art & clean "- Topic" author)
    const isYtm =
      options?.engine === 'youtube_music' ||
      targetQuery.includes('music.youtube.com') ||
      (!options?.engine &&
        this.kazagumo.KazagumoOptions.defaultSearchEngine === 'youtube_music');

    for (const track of result.tracks) {
      this.enhanceTrackMetadata(track, isYtm ? 'youtube_music' : track.sourceName);
    }

    return result;
  }

  private enhanceTrackMetadata(track: KazagumoTrack, platformHint?: string): void {
    const rawInfo = (track.getRaw()?._raw as any)?.info;
    // Restore high-res artworkUrl from Lavalink if Kazagumo replaced it with standard hqdefault.jpg
    if (rawInfo?.artworkUrl) {
      track.thumbnail = rawInfo.artworkUrl;
    }
    // Clean up YouTube Music auto-generated "- Topic" suffix on artist names
    if (track.author && track.author.endsWith(' - Topic')) {
      track.author = track.author.replace(/ - Topic$/i, '').trim();
    }
    (track as any).platform = platformHint || track.sourceName;
  }

  private async searchTracks(query: string, requester: unknown): Promise<KazagumoTrack[]> {
    const market = this.options.market || 'US';
    const data = await this.apiRequest(
      `/search?q=${encodeURIComponent(query)}&type=track&limit=10&market=${market}`
    );
    const items = data?.tracks?.items || [];
    return items
      .filter((item: any) => item && item.id)
      .map((item: any) => this.createSpotifyKazagumoTrack(item, requester));
  }

  private async fetchTrack(id: string, requester: unknown): Promise<KazagumoTrack | null> {
    try {
      const data = await this.apiRequest(`/tracks/${id}`);
      return this.createSpotifyKazagumoTrack(data, requester);
    } catch {
      const entity = await this.fetchEmbedEntity('track', id);
      if (!entity) return null;
      const artwork = entity.visualIdentity?.image?.[0]?.url;
      return this.createFromEmbedTrack(
        {
          id: entity.id || id,
          title: entity.title,
          subtitle: entity.subtitle,
          duration: entity.duration,
        },
        requester,
        artwork
      );
    }
  }

  private async fetchPlaylist(
    id: string,
    requester: unknown
  ): Promise<{ name: string; tracks: KazagumoTrack[] }> {
    let playlistName = 'Spotify Playlist';
    let coverUrl: string | undefined;

    // 1. Try official API first
    try {
      const data = await this.apiRequest(`/playlists/${id}`);
      if (data?.name) playlistName = data.name;
      if (data?.images?.[0]?.url) coverUrl = data.images[0].url;

      if (data?.tracks?.items?.length) {
        const tracks: KazagumoTrack[] = data.tracks.items
          .filter((item: any) => item?.track?.id)
          .map((item: any) => this.createSpotifyKazagumoTrack(item.track, requester, coverUrl));

        let nextUrl: string | null = data.tracks.next;
        let page = 1;
        const maxPages = this.options.playlistPageLimit || 5;

        while (nextUrl && page < maxPages) {
          const nextData = await this.apiRequest(nextUrl);
          page++;
          if (nextData?.items?.length) {
            for (const item of nextData.items) {
              if (item?.track?.id) {
                tracks.push(this.createSpotifyKazagumoTrack(item.track, requester, coverUrl));
              }
            }
            nextUrl = nextData.next;
          } else {
            break;
          }
        }

        if (tracks.length > 0) {
          return { name: playlistName, tracks };
        }
      }
    } catch {
      // Fallback to embed extractor below
    }

    // 2. Fallback to Spotify Embed extractor (works on all public & editorial playlists)
    const entity = await this.fetchEmbedEntity('playlist', id);
    if (!entity) {
      return { name: playlistName, tracks: [] };
    }

    playlistName = entity.title || entity.name || playlistName;
    if (!coverUrl && entity.visualIdentity?.image?.length) {
      // Pick largest image
      const images = entity.visualIdentity.image;
      coverUrl = images[images.length - 1]?.url || images[0]?.url;
    }

    const trackList: any[] = entity.trackList || [];
    const tracks = trackList
      .filter((t) => t && t.title)
      .map((t) => {
        const trackId = t.uri?.split(':')?.pop() || '';
        return this.createFromEmbedTrack(
          {
            id: trackId,
            title: t.title,
            subtitle: t.subtitle || 'Unknown Artist',
            duration: t.duration || 0,
          },
          requester,
          coverUrl
        );
      });

    return { name: playlistName, tracks };
  }

  private async fetchAlbum(
    id: string,
    requester: unknown
  ): Promise<{ name: string; tracks: KazagumoTrack[] }> {
    try {
      const market = this.options.market || 'US';
      const album = await this.apiRequest(`/albums/${id}?market=${market}`);
      const coverUrl = album?.images?.[0]?.url;
      const items: any[] = album?.tracks?.items || [];

      const tracks = items
        .filter((t) => t && t.id)
        .map((t) => this.createSpotifyKazagumoTrack(t, requester, coverUrl));

      if (tracks.length > 0) {
        return { name: album.name || 'Spotify Album', tracks };
      }
    } catch {
      // Fallback to embed
    }

    const entity = await this.fetchEmbedEntity('album', id);
    if (!entity) return { name: 'Spotify Album', tracks: [] };

    const images = entity.visualIdentity?.image || [];
    const coverUrl = images[images.length - 1]?.url || images[0]?.url;
    const tracks = (entity.trackList || []).map((t: any) =>
      this.createFromEmbedTrack(
        {
          id: t.uri?.split(':')?.pop() || '',
          title: t.title,
          subtitle: t.subtitle || entity.subtitle || 'Unknown Artist',
          duration: t.duration || 0,
        },
        requester,
        coverUrl
      )
    );

    return { name: entity.title || 'Spotify Album', tracks };
  }

  private async fetchArtist(
    id: string,
    requester: unknown
  ): Promise<{ name: string; tracks: KazagumoTrack[] }> {
    try {
      const market = this.options.market || 'US';
      const [artist, topTracks] = await Promise.all([
        this.apiRequest(`/artists/${id}`),
        this.apiRequest(`/artists/${id}/top-tracks?market=${market}`),
      ]);
      const tracks = (topTracks?.tracks || [])
        .filter((t: any) => t && t.id)
        .map((t: any) => this.createSpotifyKazagumoTrack(t, requester));
      if (tracks.length > 0) {
        return { name: `${artist.name} - Top Tracks`, tracks };
      }
    } catch {
      // Fallback to embed
    }

    const entity = await this.fetchEmbedEntity('artist', id);
    if (!entity) return { name: 'Artist Top Tracks', tracks: [] };

    const images = entity.visualIdentity?.image || [];
    const coverUrl = images[images.length - 1]?.url || images[0]?.url;
    const tracks = (entity.trackList || []).map((t: any) =>
      this.createFromEmbedTrack(
        {
          id: t.uri?.split(':')?.pop() || '',
          title: t.title,
          subtitle: t.subtitle || entity.title || 'Unknown Artist',
          duration: t.duration || 0,
        },
        requester,
        coverUrl
      )
    );

    return { name: `${entity.title || 'Artist'} - Top Tracks`, tracks };
  }

  private createSpotifyKazagumoTrack(
    spotifyTrack: any,
    requester: unknown,
    fallbackThumbnail?: string
  ): KazagumoTrack {
    const artists = Array.isArray(spotifyTrack.artists)
      ? spotifyTrack.artists.map((a: any) => a.name).join(', ')
      : 'Unknown Artist';
    const artworkUrl =
      spotifyTrack.album?.images?.[0]?.url || fallbackThumbnail || undefined;

    const track = new KazagumoTrack(
      {
        encoded: '',
        pluginInfo: {
          name: 'all-rounder@spotify',
        },
        info: {
          sourceName: 'spotify',
          identifier: spotifyTrack.id,
          isSeekable: true,
          author: artists,
          length: spotifyTrack.duration_ms || 0,
          isStream: false,
          position: 0,
          title: spotifyTrack.name,
          uri: `https://open.spotify.com/track/${spotifyTrack.id}`,
          artworkUrl,
          isrc: spotifyTrack.external_ids?.isrc || undefined,
        },
      },
      requester
    ).setKazagumo(this.kazagumo!);

    (track as any).platform = 'spotify';
    return track;
  }

  private createFromEmbedTrack(
    embedTrack: { id: string; title: string; subtitle: string; duration: number },
    requester: unknown,
    artworkUrl?: string
  ): KazagumoTrack {
    const cleanSubtitle = embedTrack.subtitle.replace(/\u00a0/g, ' ').trim();
    const track = new KazagumoTrack(
      {
        encoded: '',
        pluginInfo: {
          name: 'all-rounder@spotify',
        },
        info: {
          sourceName: 'spotify',
          identifier: embedTrack.id || `${embedTrack.title}-${cleanSubtitle}`,
          isSeekable: true,
          author: cleanSubtitle || 'Unknown Artist',
          length: embedTrack.duration || 0,
          isStream: false,
          position: 0,
          title: embedTrack.title,
          uri: embedTrack.id
            ? `https://open.spotify.com/track/${embedTrack.id}`
            : 'https://open.spotify.com',
          artworkUrl,
          isrc: undefined,
        },
      },
      requester
    ).setKazagumo(this.kazagumo!);

    (track as any).platform = 'spotify';
    return track;
  }

  private buildResult(
    playlistName: string | undefined,
    tracks: KazagumoTrack[],
    type: SearchResultTypes
  ): KazagumoSearchResult {
    return {
      playlistName,
      tracks,
      type,
    };
  }
}

export { KazagumoPlugin as AllRounderSpotifyPlugin };
