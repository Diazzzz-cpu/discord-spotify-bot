import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from 'discord.js';
import { KazagumoPlayer, KazagumoTrack } from 'kazagumo';
import { Bookmark, getMasterRank } from './bookmarks.js';

export function formatDuration(ms: number): string {
  if (!ms || ms <= 0) return '0:00';
  const seconds = Math.floor((ms / 1000) % 60);
  const minutes = Math.floor((ms / (1000 * 60)) % 60);
  const hours = Math.floor(ms / (1000 * 60 * 60));

  const pad = (n: number) => n.toString().padStart(2, '0');
  if (hours > 0) {
    return `${hours}:${pad(minutes)}:${pad(seconds)}`;
  }
  return `${minutes}:${pad(seconds)}`;
}

export function parseTimeInput(input: string): number | null {
  const clean = input.trim();
  if (/^\d+$/.test(clean)) {
    return parseInt(clean, 10) * 1000;
  }
  const parts = clean.split(':').map((p) => parseInt(p, 10));
  if (parts.some((n) => Number.isNaN(n) || n < 0)) return null;

  if (parts.length === 2) {
    return (parts[0] * 60 + parts[1]) * 1000;
  }
  if (parts.length === 3) {
    return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
  }
  return null;
}

export function createProgressBar(currentMs: number, totalMs: number, size = 14): string {
  if (!totalMs || totalMs <= 0) return '🔘' + '▬'.repeat(size - 1);
  const progress = Math.min(Math.max(currentMs / totalMs, 0), 1);
  const index = Math.round(progress * (size - 1));
  const before = '▬'.repeat(index);
  const after = '▬'.repeat(Math.max(0, size - 1 - index));
  return `${before}🔘${after}`;
}

export function getPlatformBadge(track: KazagumoTrack): {
  label: string;
  color: number;
} {
  const platform = (track as any).platform || track.sourceName;
  if (platform === 'spotify' || track.uri?.includes('spotify.com')) {
    return { label: '🟢 Spotify', color: 0x1db954 };
  }
  if (platform === 'youtube_music') {
    return { label: '🔴 YouTube Music', color: 0xff0033 };
  }
  return { label: '▶️ YouTube', color: 0xff4500 };
}

export function buildNowPlayingEmbed(player: KazagumoPlayer, track?: KazagumoTrack): EmbedBuilder {
  const current = track || player.queue.current;
  if (!current) {
    return new EmbedBuilder()
      .setColor(0x2b2d31)
      .setDescription('❌ Nothing is currently playing.');
  }

  const { label, color } = getPlatformBadge(current);
  const position = player.position || 0;
  const total = current.length || 0;
  const bar = createProgressBar(position, total);

  const loopText =
    player.loop === 'track'
      ? '🔂 Track'
      : player.loop === 'queue'
      ? '🔁 Queue'
      : 'Off';

  const autoplayEnabled = Boolean((player as any).autoplay);
  const activeFilter = (player as any).activeFilter || 'Off';
  const requester = (current.requester as any)?.username || 'Autoplay / User';
  const requesterRank = getMasterRank((current.requester as any)?.id);
  const rankBadge =
    requesterRank === 2
      ? `🤍 Zero Ultra (${requester}) • Unskippable`
      : requesterRank === 1
      ? `🌸 Pipeline Punch (${requester}) • Protected`
      : `🟢 Original (${requester})`;

  const embed = new EmbedBuilder()
    .setColor(color)
    .setAuthor({
      name: `${label} • Now Playing${
        requesterRank === 2
          ? ' • 🤍 ZERO ULTRA'
          : requesterRank === 1
          ? ' • 🌸 PIPELINE PUNCH'
          : ''
      }`,
    })
    .setTitle(current.title || 'Unknown Title')
    .setURL(current.uri || null)
    .setDescription(
      `👤 **Artist:** ${current.author || 'Unknown'}\n\n` +
        `\`${formatDuration(position)}\` ${bar} \`${formatDuration(total)}\``
    )
    .addFields(
      {
        name: 'Status',
        value: player.paused ? '⏸️ Paused' : '▶️ Playing',
        inline: true,
      },
      {
        name: 'Queue Remaining',
        value: `${player.queue.size} track(s)`,
        inline: true,
      },
      {
        name: 'Loop / Autoplay',
        value: `${loopText} • ${autoplayEnabled ? '🔄 On' : 'Off'}`,
        inline: true,
      }
    )
    .setFooter({
      text: `${rankBadge}${activeFilter !== 'Off' ? ` • FX: ${activeFilter}` : ''}`,
    });

  if (current.thumbnail) {
    embed.setThumbnail(current.thumbnail);
  }

  return embed;
}

export function buildPlayerButtons(
  player: KazagumoPlayer
): ActionRowBuilder<ButtonBuilder>[] {
  const isPaused = player.paused;
  const loopMode = player.loop; // 'none' | 'track' | 'queue'
  const autoplay = Boolean((player as any).autoplay);
  const hasPrev = Array.isArray((player as any).previousTracks) && (player as any).previousTracks.length > 0;

  const prevBtn = new ButtonBuilder()
    .setCustomId('music_prev')
    .setEmoji('⏮️')
    .setLabel('Prev')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(!hasPrev);

  const pauseResumeBtn = new ButtonBuilder()
    .setCustomId('music_toggle_pause')
    .setEmoji(isPaused ? '▶️' : '⏸️')
    .setLabel(isPaused ? 'Resume' : 'Pause')
    .setStyle(isPaused ? ButtonStyle.Success : ButtonStyle.Secondary);

  const skipBtn = new ButtonBuilder()
    .setCustomId('music_skip')
    .setEmoji('⏭️')
    .setLabel('Skip')
    .setStyle(ButtonStyle.Primary);

  const shuffleBtn = new ButtonBuilder()
    .setCustomId('music_shuffle')
    .setEmoji('🔀')
    .setLabel('Shuffle')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(player.queue.size < 2);

  const stopBtn = new ButtonBuilder()
    .setCustomId('music_stop')
    .setEmoji('⏹️')
    .setLabel('Stop')
    .setStyle(ButtonStyle.Danger);

  const loopBtn = new ButtonBuilder()
    .setCustomId('music_loop')
    .setEmoji(loopMode === 'track' ? '🔂' : '🔁')
    .setLabel(
      loopMode === 'track'
        ? 'Loop: Track'
        : loopMode === 'queue'
        ? 'Loop: Queue'
        : 'Loop: Off'
    )
    .setStyle(loopMode === 'none' ? ButtonStyle.Secondary : ButtonStyle.Success);

  const autoplayBtn = new ButtonBuilder()
    .setCustomId('music_autoplay')
    .setEmoji('🔄')
    .setLabel(autoplay ? 'Autoplay: On' : 'Autoplay: Off')
    .setStyle(autoplay ? ButtonStyle.Success : ButtonStyle.Secondary);

  const lyricsBtn = new ButtonBuilder()
    .setCustomId('music_lyrics')
    .setEmoji('🎤')
    .setLabel('Lyrics')
    .setStyle(ButtonStyle.Secondary);

  const grabBtn = new ButtonBuilder()
    .setCustomId('music_grab')
    .setEmoji('💾')
    .setLabel('Grab')
    .setStyle(ButtonStyle.Secondary);

  const queueBtn = new ButtonBuilder()
    .setCustomId('music_qpage_1')
    .setEmoji('📜')
    .setLabel(`Queue (${player.queue.size})`)
    .setStyle(ButtonStyle.Secondary);

  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    prevBtn,
    pauseResumeBtn,
    skipBtn,
    shuffleBtn,
    stopBtn
  );

  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    loopBtn,
    autoplayBtn,
    lyricsBtn,
    grabBtn,
    queueBtn
  );

  return [row1, row2];
}

export function buildBookmarkButtons(
  bookmarks: Bookmark[],
  requestedPage = 1
): ActionRowBuilder<ButtonBuilder>[] {
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  if (!bookmarks.length) return rows;

  const pageSize = 5;
  const totalPages = Math.max(1, Math.ceil(bookmarks.length / pageSize));
  const page = Math.min(Math.max(1, requestedPage), totalPages);
  const startIdx = (page - 1) * pageSize;
  const pageItems = bookmarks.slice(startIdx, startIdx + pageSize);

  const playRow = new ActionRowBuilder<ButtonBuilder>();
  const shufRow = new ActionRowBuilder<ButtonBuilder>();

  pageItems.forEach((b) => {
    const safeId = b.name.slice(0, 75);
    playRow.addComponents(
      new ButtonBuilder()
        .setCustomId(`music_bplay_${safeId}`)
        .setEmoji('▶️')
        .setLabel(b.name.slice(0, 20))
        .setStyle(ButtonStyle.Success)
    );
    shufRow.addComponents(
      new ButtonBuilder()
        .setCustomId(`music_bshuf_${safeId}`)
        .setEmoji('🔀')
        .setLabel(b.name.slice(0, 18))
        .setStyle(ButtonStyle.Secondary)
    );
  });

  if (playRow.components.length > 0) rows.push(playRow);
  if (shufRow.components.length > 0) rows.push(shufRow);

  if (totalPages > 1) {
    const navRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`music_bpage_${page - 1}`)
        .setEmoji('⬅️')
        .setLabel(`Prev (${page}/${totalPages})`)
        .setStyle(ButtonStyle.Primary)
        .setDisabled(page <= 1),
      new ButtonBuilder()
        .setCustomId(`music_bpage_${page + 1}`)
        .setEmoji('➡️')
        .setLabel(`Next (${page}/${totalPages})`)
        .setStyle(ButtonStyle.Primary)
        .setDisabled(page >= totalPages)
    );
    rows.push(navRow);
  }

  return rows;
}

export function buildQueueView(
  player: KazagumoPlayer,
  requestedPage = 1
): {
  embed: EmbedBuilder;
  components: ActionRowBuilder<ButtonBuilder>[];
} {
  const current = player.queue.current!;
  const pageSize = 10;
  const totalPages = Math.max(1, Math.ceil(player.queue.size / pageSize));
  const page = Math.min(Math.max(1, requestedPage), totalPages);

  const startIdx = (page - 1) * pageSize;
  const upcoming = player.queue.slice(startIdx, startIdx + pageSize);
  const { color } = getPlatformBadge(current);

  let description =
    `**Now Playing:**\n` +
    `[${current.title}](${current.uri}) — **${current.author}** \`[${formatDuration(
      current.length || 0
    )}]\`\n\n` +
    `**Upcoming Queue (${player.queue.size} tracks):**\n`;

  if (upcoming.length === 0) {
    description += '*No upcoming tracks. Use `/play` or `$play` to add songs or playlists!*';
  } else {
    description += upcoming
      .map((t: any, idx: number) => {
        const rRank = getMasterRank(t.requester?.id);
        const tag = rRank === 2 ? ' 🤍' : rRank === 1 ? ' 🌸' : ' 🟢';
        return `\`${startIdx + idx + 1}.\`${tag} [${t.title}](${t.uri}) — **${
          t.author
        }** \`[${formatDuration(t.length || 0)}]\``;
      })
      .join('\n');
    description += `\n\n💡 *Tip: Reorder tracks with \`$move 4 1\` or \`$move 4 to 1\`!*`;
  }

  const totalQueueMs =
    (current.length || 0) +
    player.queue.reduce((acc: number, t: any) => acc + (t.length || 0), 0);
  const autoplay = Boolean((player as any).autoplay);

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(`🎶 Server Music Queue (${player.queue.totalSize} Tracks)`)
    .setDescription(description)
    .setThumbnail(current.thumbnail || null)
    .setFooter({
      text: `Page ${page}/${totalPages} • Total Duration: ${formatDuration(
        totalQueueMs
      )} • Loop: ${player.loop.toUpperCase()} • Autoplay: ${autoplay ? 'ON' : 'OFF'}`,
    });

  const components: ActionRowBuilder<ButtonBuilder>[] = [];
  if (totalPages > 1) {
    const prevBtn = new ButtonBuilder()
      .setCustomId(`music_qpage_${page - 1}`)
      .setEmoji('⬅️')
      .setLabel('Prev')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 1);

    const nextBtn = new ButtonBuilder()
      .setCustomId(`music_qpage_${page + 1}`)
      .setEmoji('➡️')
      .setLabel('Next')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= totalPages);

    components.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(prevBtn, nextBtn)
    );
  }

  return { embed, components };
}
