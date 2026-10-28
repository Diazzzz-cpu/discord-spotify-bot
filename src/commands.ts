import {
  AutocompleteInteraction,
  ButtonInteraction,
  ChatInputCommandInteraction,
  EmbedBuilder,
  GuildMember,
  Message,
  MessageFlags,
  SlashCommandBuilder,
  User,
} from 'discord.js';
import { kazagumo, prefetchNextTrack, refreshNowPlayingMessage } from './client.js';
import {
  buildBookmarkButtons,
  buildNowPlayingEmbed,
  buildPlayerButtons,
  buildQueueView,
  formatDuration,
  getPlatformBadge,
  parseTimeInput,
} from './ui.js';
import { buildLyricsEmbed, fetchLyrics } from './lyrics.js';
import {
  SUPREME_MASTER_ID,
  addCoMaster,
  banishUser,
  forgiveUser,
  getBanishedUsers,
  getBookmark,
  getCoMasters,
  getMasterRank,
  isAnyMaster,
  isMasterModeLocked,
  isSupremeMaster,
  isUserBanished,
  listBookmarks,
  removeBookmark,
  removeCoMaster,
  saveBookmark,
  setMasterModeLocked,
} from './bookmarks.js';

export const MASTER_USER_ID = SUPREME_MASTER_ID;
const NOT_MASTER_MESSAGE = "You're not my master! You do not get to order me around";
const OUTRANKED_BY_ZERO_ULTRA_MESSAGE =
  '🤍 Nice try! You may be **🌸 Pipeline Punch**, but you do not outrank **🤍 Zero Ultra**!';

const VALID_PREFIX_COMMANDS = new Set([
  'p',
  'play',
  'pn',
  'playnext',
  'hijack',
  'playnow',
  'promote',
  'addmaster',
  'demote',
  'removemaster',
  'strip',
  'masters',
  'flavors',
  'flavor',
  'ranks',
  'rank',
  'replay',
  'restart',
  'top',
  'boost',
  'lock',
  'unlock',
  'banish',
  'forgive',
  'unbanish',
  'banished',
  'save',
  'bookmark',
  'bookmarks',
  'saved',
  'unsave',
  's',
  'skip',
  'back',
  'prev',
  'previous',
  'grab',
  'savecurrent',
  'move',
  'mv',
  'rm',
  'remove',
  'clear',
  'pause',
  'resume',
  'shuffle',
  'autoplay',
  'ap',
  'loop',
  'vol',
  'volume',
  'seek',
  'fx',
  'filter',
  'tune',
  'l',
  'ly',
  'lyrics',
  'stop',
  'leave',
  'dc',
  'disconnect',
  'np',
  'nowplaying',
  'q',
  'queue',
  'help',
]);

function getTrackRank(track: any): number {
  const reqId = (track?.requester as User | undefined)?.id;
  return getMasterRank(reqId);
}

function getDenialForTrack(actorId: string, track: any, actionVerb: string): string | null {
  const actorRank = getMasterRank(actorId);
  const trackRank = getTrackRank(track);

  if (trackRank === 0 || actorRank >= trackRank) {
    return null; // Allowed!
  }
  if (actorRank === 1 && trackRank === 2) {
    return `🤍 Nice try! You may be **🌸 Pipeline Punch**, but you cannot ${actionVerb} **🤍 Zero Ultra's** music!`;
  }
  return `🥫 You cannot ${actionVerb} a **Zero Ultra / Pipeline Punch** track! You do not get to order me around`;
}

function getDenialForStop(actorId: string, player: any): string | null {
  if (!player) return null;
  if (player.queue?.current) {
    const denyCurrent = getDenialForTrack(actorId, player.queue.current, 'stop');
    if (denyCurrent) return denyCurrent;
  }
  const actorRank = getMasterRank(actorId);
  if (actorRank < 2 && player.queue?.size) {
    const highestQueuedRank = Math.max(
      0,
      ...[...player.queue].map((t: any) => getTrackRank(t))
    );
    if (actorRank < highestQueuedRank) {
      return highestQueuedRank === 2 && actorRank === 1
        ? "🤍 Nice try! You may be **🌸 Pipeline Punch**, but you cannot stop playback while **🤍 Zero Ultra** has songs in the queue!"
        : "🥫 You cannot stop the bot while a **Zero Ultra / Pipeline Punch** song is in the queue! You do not get to order me around";
    }
  }
  return null;
}

function getBookmarkRank(existing: { createdBy: string; createdById?: string }): number {
  if (existing.createdById) {
    return getMasterRank(existing.createdById);
  }
  return 2;
}

/**
 * Inserts track(s) at the highest priority position allowed by the user's Flavor rank.
 * - Zero Ultra (rank 2) inserts at index 0 (very top of queue).
 * - Pipeline Punch (rank 1) inserts right after any queued Zero Ultra tracks!
 */
function insertTracksByMasterRank(player: any, tracksToInsert: any[], actorId: string): number {
  const actorRank = getMasterRank(actorId);
  if (actorRank >= 2 || player.queue.size === 0) {
    player.queue.unshift(...tracksToInsert);
    return 1;
  }
  let insertIdx = 0;
  while (insertIdx < player.queue.size && getTrackRank(player.queue[insertIdx]) > actorRank) {
    insertIdx++;
  }
  player.queue.splice(insertIdx, 0, ...tracksToInsert);
  return insertIdx + 1;
}

export const slashCommands = [
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play a song, Spotify/YTM playlist, or saved bookmark shortcut')
    .addStringOption((opt) =>
      opt
        .setName('query')
        .setDescription('Song name, Spotify / YTM link, or saved bookmark name')
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addStringOption((opt) =>
      opt
        .setName('source')
        .setDescription('Search engine for text queries (URLs & bookmarks are auto-detected)')
        .setRequired(false)
        .addChoices(
          { name: '🔴 YouTube Music (Default - Studio Audio)', value: 'youtube_music' },
          { name: '🟢 Spotify (Spotify Catalog)', value: 'spotify' },
          { name: '▶️ YouTube (Videos & Remixes)', value: 'youtube' }
        )
    )
    .addStringOption((opt) =>
      opt
        .setName('priority')
        .setDescription('Queue priority (Zero Ultra & Pipeline Punch only)')
        .setRequired(false)
        .addChoices(
          { name: '📋 Normal (Add to end of queue)', value: 'normal' },
          { name: '⚡ Play Next (Cut to front of queue)', value: 'next' },
          { name: '🤍 Hijack Now (Interrupt & play immediately)', value: 'hijack' }
        )
    )
    .addBooleanOption((opt) =>
      opt
        .setName('shuffle')
        .setDescription('Shuffle tracks if adding a playlist or album')
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('queue')
    .setDescription('View the queue, move/boost a track, shuffle, loop, toggle autoplay, or remove a track')
    .addStringOption((opt) =>
      opt
        .setName('action')
        .setDescription('Action to perform on the queue')
        .setRequired(false)
        .addChoices(
          { name: '📜 View Queue', value: 'view' },
          { name: '🔀 Shuffle Queue', value: 'shuffle' },
          { name: '🔄 Toggle Autoplay (Radio Mode)', value: 'autoplay' },
          { name: '🗑️ Clear Upcoming Tracks (VIP Only)', value: 'clear' },
          { name: '🔂 Loop: Current Track', value: 'loop_track' },
          { name: '🔁 Loop: Entire Queue', value: 'loop_queue' },
          { name: '➡️ Loop: Off', value: 'loop_off' }
        )
    )
    .addIntegerOption((opt) =>
      opt
        .setName('move_from')
        .setDescription('Track number in the queue you want to move (e.g., 4)')
        .setMinValue(1)
        .setRequired(false)
    )
    .addIntegerOption((opt) =>
      opt
        .setName('move_to')
        .setDescription('New position number to move the track to (e.g., 1)')
        .setMinValue(1)
        .setRequired(false)
    )
    .addIntegerOption((opt) =>
      opt
        .setName('top')
        .setDescription('Rocket a specific track number straight to #1 in the queue (VIP Only)')
        .setMinValue(1)
        .setRequired(false)
    )
    .addIntegerOption((opt) =>
      opt
        .setName('remove')
        .setDescription('Remove a specific track number from the upcoming queue')
        .setMinValue(1)
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('skip')
    .setDescription('Skip the current song or jump to a specific track in the queue')
    .addIntegerOption((opt) =>
      opt
        .setName('to')
        .setDescription('Queue position number to jump directly to (e.g., 3)')
        .setMinValue(1)
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('back')
    .setDescription('Replay the previous track from session history'),

  new SlashCommandBuilder()
    .setName('replay')
    .setDescription('Rewind the current song back to 0:00 (Zero Ultra / Pipeline Punch)'),

  new SlashCommandBuilder()
    .setName('grab')
    .setDescription('Save the current playing song card & Spotify/YTM links to your DMs'),

  new SlashCommandBuilder()
    .setName('pause')
    .setDescription('Toggle pause / resume on the current playback'),

  new SlashCommandBuilder()
    .setName('tune')
    .setDescription('Adjust volume (1-100%), seek to a timestamp, or apply DSP audio filters (VIP Only)')
    .addStringOption((opt) =>
      opt
        .setName('filter')
        .setDescription('Apply a hardware-accelerated Lavalink audio filter')
        .setRequired(false)
        .addChoices(
          { name: '✨ Off (Normal Ear-Safe Audio)', value: 'off' },
          { name: '🔊 Bass Boost', value: 'bassboost' },
          { name: '⚡ Nightcore (Speed + Pitch Up)', value: 'nightcore' },
          { name: '🌙 Slowed + Aesthetic', value: 'slowed' },
          { name: '🎧 8D Surround Audio', value: '8d' },
          { name: '🎤 Karaoke (Vocal Reduction)', value: 'karaoke' }
        )
    )
    .addIntegerOption((opt) =>
      opt
        .setName('volume')
        .setDescription('Set distortion-free playback volume percentage (1 - 100)')
        .setMinValue(1)
        .setMaxValue(100)
        .setRequired(false)
    )
    .addStringOption((opt) =>
      opt
        .setName('seek')
        .setDescription('Jump to a timestamp in the current track (e.g. 1:30 or 90)')
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('bookmark')
    .setDescription('Save or manage playlist/song shortcuts for instant 1-word playback')
    .addStringOption((opt) =>
      opt
        .setName('action')
        .setDescription('Save, list, or delete a bookmark')
        .setRequired(true)
        .addChoices(
          { name: '💾 Save Bookmark', value: 'save' },
          { name: '📋 List All Bookmarks', value: 'list' },
          { name: '🗑️ Delete Bookmark', value: 'delete' }
        )
    )
    .addStringOption((opt) =>
      opt
        .setName('name')
        .setDescription('Short nickname for the playlist/song (e.g., chill, gym)')
        .setRequired(false)
    )
    .addStringOption((opt) =>
      opt
        .setName('url')
        .setDescription('Spotify or YouTube Music playlist/track URL (required when saving)')
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('ranks')
    .setDescription('View the Monster Energy Flavor Hierarchy or manage VIP ranks & locks')
    .addStringOption((opt) =>
      opt
        .setName('action')
        .setDescription('Hierarchy action (defaults to viewing the Flavor Hierarchy card)')
        .setRequired(false)
        .addChoices(
          { name: '🥫 View Flavor Hierarchy', value: 'view' },
          { name: '🌸 Promote to Pipeline Punch (Zero Ultra Only)', value: 'promote' },
          { name: '📉 Demote to Original (Zero Ultra Only)', value: 'demote' },
          { name: '🔒 Lock Bot to VIPs Only (Zero Ultra Only)', value: 'lock' },
          { name: '🔓 Unlock Bot for Originals (Zero Ultra Only)', value: 'unlock' },
          { name: '⚡ Banish User (VIP Only)', value: 'banish' },
          { name: '🕊️ Forgive User (VIP Only)', value: 'forgive' }
        )
    )
    .addUserOption((opt) =>
      opt
        .setName('user')
        .setDescription('Target user for promote, demote, banish, or forgive')
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('lyrics')
    .setDescription('Find lyrics for the currently playing song (or search a specific song)')
    .addStringOption((opt) =>
      opt
        .setName('song')
        .setDescription('Optional song title/artist to search (defaults to current playing song)')
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('nowplaying')
    .setDescription('Display the current song card with progress bar and interactive controls'),

  new SlashCommandBuilder()
    .setName('leave')
    .setDescription('Stop all playback, clear the queue, and leave the voice channel (VIP Only)'),

  new SlashCommandBuilder()
    .setName('help')
    .setDescription('View the command list available for your Monster Energy Flavor rank'),
];

/**
 * O(1) Autocomplete handler for /play saved bookmarks
 */
export async function handleAutocomplete(interaction: AutocompleteInteraction) {
  if (interaction.commandName !== 'play') return;
  if (
    !isAnyMaster(interaction.user.id) &&
    (isMasterModeLocked() || isUserBanished(interaction.user.id))
  ) {
    await interaction.respond([]).catch(() => {});
    return;
  }

  const focused = interaction.options.getFocused().trim().toLowerCase();
  const all = listBookmarks();

  const matches = all
    .filter((b) => !focused || b.name.toLowerCase().includes(focused))
    .slice(0, 25)
    .map((b) => ({
      name: `⭐ [Bookmark] ${b.name} (${
        b.url.includes('spotify.com') ? 'Spotify' : 'Music Link'
      })`,
      value: b.name,
    }));

  await interaction.respond(matches).catch(() => {});
}

export async function handleInteraction(interaction: ChatInputCommandInteraction) {
  const { commandName, guildId, member } = interaction;
  if (!guildId || !(member instanceof GuildMember)) {
    return interaction.reply({
      content: '❌ This command can only be used inside a server.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const userId = interaction.user.id;
  const userRank = getMasterRank(userId);
  const userIsMaster = userRank >= 1;
  const userIsSupreme = userRank === 2;

  // 1. Check Lock & Banish List (Zero Ultra & Pipeline Punch bypass lock)
  if (!userIsMaster && (isMasterModeLocked() || isUserBanished(userId))) {
    return interaction.reply(NOT_MASTER_MESSAGE);
  }

  const voiceChannel = member.voice.channel;

  if (['play', 'skip', 'back', 'replay', 'pause', 'tune', 'leave', 'stop'].includes(commandName)) {
    if (!voiceChannel) {
      return interaction.reply({
        content: '❌ You must be in a voice channel to use this command!',
        flags: MessageFlags.Ephemeral,
      });
    }
  }

  const player = kazagumo.players.get(guildId);

  switch (commandName) {
    case 'play': {
      const priority = (interaction.options.getString('priority') || 'normal') as
        | 'normal'
        | 'next'
        | 'hijack';

      if (priority !== 'normal' && !userIsMaster) {
        return interaction.reply(NOT_MASTER_MESSAGE);
      }

      if (priority === 'hijack' && player?.queue?.current) {
        const deny = getDenialForTrack(userId, player.queue.current, 'hijack');
        if (deny) return interaction.reply(deny);
      }

      await interaction.deferReply();
      const rawQuery = interaction.options.getString('query', true);
      const source = interaction.options.getString('source') || 'youtube_music';
      const shuffle = interaction.options.getBoolean('shuffle') || false;

      const reply = await executePlay(
        guildId,
        voiceChannel!.id,
        interaction.channelId,
        rawQuery,
        interaction.user,
        source,
        shuffle,
        priority
      );

      if (typeof reply === 'string') {
        await interaction.editReply(reply);
      } else {
        await interaction.editReply({ embeds: [reply] });
      }
      break;
    }

    case 'queue': {
      const topPos = interaction.options.getInteger('top');
      if (topPos !== null) {
        if (!userIsMaster) return interaction.reply(NOT_MASTER_MESSAGE);
        if (!voiceChannel) {
          return interaction.reply({
            content: '❌ Join the voice channel first to boost a track.',
            flags: MessageFlags.Ephemeral,
          });
        }
        let targetPos = 1;
        if (!userIsSupreme && player?.queue?.size) {
          while (
            targetPos <= player.queue.size &&
            getTrackRank(player.queue[targetPos - 1]) > userRank
          ) {
            targetPos++;
          }
        }
        return interaction.reply(executeMoveTrack(player, topPos, targetPos, userId));
      }

      const moveFrom = interaction.options.getInteger('move_from');
      const moveTo = interaction.options.getInteger('move_to');
      if (moveFrom !== null || moveTo !== null) {
        if (!voiceChannel) {
          return interaction.reply({
            content: '❌ Join the voice channel first to reorder the queue.',
            flags: MessageFlags.Ephemeral,
          });
        }
        if (moveFrom === null || moveTo === null) {
          return interaction.reply({
            content: 'ℹ️ Specify both `move_from` and `move_to` (or use `$move 4 to 1`).',
            flags: MessageFlags.Ephemeral,
          });
        }
        return interaction.reply(executeMoveTrack(player, moveFrom, moveTo, userId));
      }

      const removeIdx = interaction.options.getInteger('remove');
      if (removeIdx) {
        if (!voiceChannel) {
          return interaction.reply({
            content: '❌ Join the voice channel first to modify the queue.',
            flags: MessageFlags.Ephemeral,
          });
        }
        return interaction.reply(executeRemoveTrack(player, removeIdx, userId));
      }

      const action = interaction.options.getString('action') || 'view';

      if (action !== 'view' && !voiceChannel) {
        return interaction.reply({
          content: '❌ Join the voice channel first to modify the queue.',
          flags: MessageFlags.Ephemeral,
        });
      }

      if (action === 'view') {
        if (!player || !player.queue.current) {
          return interaction.reply({
            content: '❌ The queue is currently empty.',
            flags: MessageFlags.Ephemeral,
          });
        }
        const view = buildQueueView(player, 1);
        return interaction.reply({ embeds: [view.embed], components: view.components });
      }

      const res = executeQueueAction(player, action, userId);
      return interaction.reply(res);
    }

    case 'skip': {
      const jumpTo = interaction.options.getInteger('to');
      const res = executeSkip(player, userId, jumpTo || undefined);
      return interaction.reply(res);
    }

    case 'back': {
      const res = await executePrevious(player, userId);
      return interaction.reply(res);
    }

    case 'replay': {
      if (!player || !player.queue.current) {
        return interaction.reply({
          content: '❌ Nothing is currently playing to replay.',
          flags: MessageFlags.Ephemeral,
        });
      }
      const deny = getDenialForTrack(userId, player.queue.current, 'restart');
      if (deny) return interaction.reply(deny);
      player.seek(0);
      await refreshNowPlayingMessage(player);
      return interaction.reply(
        `🔁 Rewinded **${player.queue.current.title}** back to \`0:00\`!`
      );
    }

    case 'grab': {
      if (!player || !player.queue.current) {
        return interaction.reply({
          content: '❌ Nothing is currently playing to grab.',
          flags: MessageFlags.Ephemeral,
        });
      }
      const grabEmbed = buildGrabEmbed(player.queue.current);
      await interaction.user.send({ embeds: [grabEmbed] }).catch(() => {});
      return interaction.reply({
        content: '💾 Sent the track details to your DMs (and shown below)!',
        embeds: [grabEmbed],
        flags: MessageFlags.Ephemeral,
      });
    }

    case 'pause': {
      const res = executeTogglePause(player, userId);
      return interaction.reply(res);
    }

    case 'tune': {
      if (!player || !player.queue.current) {
        return interaction.reply({
          content: '❌ Nothing is currently playing.',
          flags: MessageFlags.Ephemeral,
        });
      }

      const filter = interaction.options.getString('filter');
      const volume = interaction.options.getInteger('volume');
      const seekStr = interaction.options.getString('seek');

      if (!filter && volume === null && !seekStr) {
        return interaction.reply({
          content: 'ℹ️ Specify at least one option (`filter`, `volume`, or `seek`).',
          flags: MessageFlags.Ephemeral,
        });
      }

      const deny = getDenialForTrack(userId, player.queue.current, 'tune');
      if (deny) return interaction.reply(deny);

      const messages: string[] = [];
      if (volume !== null) {
        const clampedVol = Math.min(100, Math.max(1, volume));
        player.setVolume(clampedVol);
        messages.push(`🔊 Volume set to **${clampedVol}%**`);
      }
      if (seekStr) {
        const ms = parseTimeInput(seekStr);
        if (ms === null || ms > (player.queue.current.length || 0)) {
          messages.push(`❌ Invalid seek timestamp \`${seekStr}\``);
        } else {
          player.seek(ms);
          messages.push(`⏩ Seeked to **${formatDuration(ms)}**`);
        }
      }
      if (filter) {
        const label = await applyAudioFilter(player, filter);
        messages.push(`🎛️ Audio Filter set to **${label}**`);
      }

      await refreshNowPlayingMessage(player);
      return interaction.reply(messages.join('\n'));
    }

    case 'bookmark': {
      const action = interaction.options.getString('action', true);
      const name = interaction.options.getString('name');
      const url = interaction.options.getString('url');

      const res = await executeBookmarkCommand(
        action,
        name,
        url,
        interaction.user.username,
        userId
      );
      if (typeof res === 'string') return interaction.reply(res);
      const components = action === 'list' ? buildBookmarkButtons(listBookmarks(), 1) : [];
      return interaction.reply({ embeds: [res], components });
    }

    case 'ranks': {
      const action = interaction.options.getString('action') || 'view';
      const targetUser = interaction.options.getUser('user');

      if (action === 'view') {
        return interaction.reply({ embeds: [buildFlavorHierarchyEmbed()] });
      }

      if (['promote', 'demote', 'lock', 'unlock'].includes(action) && !userIsSupreme) {
        return interaction.reply(
          userIsMaster ? OUTRANKED_BY_ZERO_ULTRA_MESSAGE : NOT_MASTER_MESSAGE
        );
      }

      if (['banish', 'forgive'].includes(action) && !userIsMaster) {
        return interaction.reply(NOT_MASTER_MESSAGE);
      }

      if (action === 'lock') {
        setMasterModeLocked(true);
        return interaction.reply(
          '🔒 **Locked!** Only **🤍 Zero Ultra** and **🌸 Pipeline Punch** can give me orders right now.'
        );
      }
      if (action === 'unlock') {
        setMasterModeLocked(false);
        return interaction.reply(
          '🔓 **Unlocked!** **🟢 Original** members can queue songs & save bookmarks again.'
        );
      }

      if (!targetUser) {
        return interaction.reply({
          content: 'ℹ️ Please select a `user` for that action.',
          flags: MessageFlags.Ephemeral,
        });
      }

      if (action === 'promote') {
        if (isSupremeMaster(targetUser.id)) {
          return interaction.reply('🤍 You are already **Zero Ultra**!');
        }
        addCoMaster(targetUser.id);
        return interaction.reply(
          `🌸 **Upgraded to Pipeline Punch!** <@${targetUser.id}> has been promoted from **🟢 Original** to **🌸 Pipeline Punch** by **🤍 Zero Ultra**!`
        );
      }

      if (action === 'demote') {
        if (isSupremeMaster(targetUser.id)) {
          return interaction.reply('🤍 **Zero Ultra** can never be demoted!');
        }
        const removed = removeCoMaster(targetUser.id);
        return interaction.reply(
          removed
            ? `📉 <@${targetUser.id}> has been demoted from **🌸 Pipeline Punch** back to **🟢 Original**!`
            : `ℹ️ <@${targetUser.id}> is already **🟢 Original**.`
        );
      }

      if (action === 'banish') {
        if (isSupremeMaster(targetUser.id)) {
          return interaction.reply('🤍 How dare you! I would never banish **Zero Ultra**!');
        }
        if (!userIsSupreme && isAnyMaster(targetUser.id)) {
          return interaction.reply(
            '🌸 You cannot banish a fellow **Pipeline Punch**! Only **🤍 Zero Ultra** holds that power.'
          );
        }
        banishUser(targetUser.id);
        return interaction.reply(
          `⚡ <@${targetUser.id}> has been **banished** from ordering me around!`
        );
      }

      if (action === 'forgive') {
        forgiveUser(targetUser.id);
        return interaction.reply(`🕊️ <@${targetUser.id}> has been **forgiven**.`);
      }
      break;
    }

    case 'nowplaying': {
      if (!player || !player.queue.current) {
        return interaction.reply({
          content: '❌ Nothing is currently playing.',
          flags: MessageFlags.Ephemeral,
        });
      }
      const embed = buildNowPlayingEmbed(player);
      const rows = buildPlayerButtons(player);
      return interaction.reply({ embeds: [embed], components: rows });
    }

    case 'lyrics': {
      await interaction.deferReply();
      const customQuery = interaction.options.getString('song');
      const res = await executeLyrics(player, customQuery || undefined);
      if (typeof res === 'string') {
        return interaction.editReply(res);
      }
      return interaction.editReply({ embeds: [res] });
    }

    case 'leave':
    case 'stop': {
      const deny = getDenialForStop(userId, player);
      if (deny) return interaction.reply(deny);
      const res = await executeLeave(player, interaction.guild);
      return interaction.reply(res);
    }

    case 'help': {
      const embeds = getHelpEmbeds(userRank);
      return interaction.reply({ embeds, flags: MessageFlags.Ephemeral });
    }
  }
}

export async function handleButtonInteraction(interaction: ButtonInteraction) {
  const { customId, guildId, member } = interaction;
  if (!guildId || !(member instanceof GuildMember)) return;

  const userId = interaction.user.id;
  const userIsMaster = isAnyMaster(userId);

  // 1. Check Lock & Banish List
  if (!userIsMaster && (isMasterModeLocked() || isUserBanished(userId))) {
    return interaction.reply(NOT_MASTER_MESSAGE);
  }

  // Bookmark Pagination Buttons
  if (customId.startsWith('music_bpage_')) {
    const requestedPage = parseInt(customId.replace('music_bpage_', ''), 10) || 1;
    const components = buildBookmarkButtons(listBookmarks(), requestedPage);
    await interaction.update({ components });
    return;
  }

  // One-click Bookmark Play / Shuffle Buttons
  if (customId.startsWith('music_bplay_') || customId.startsWith('music_bshuf_')) {
    const isShuffle = customId.startsWith('music_bshuf_');
    const bookmarkName = customId.replace(/^music_b(play|shuf)_/, '');
    const voiceChannel = member.voice.channel;
    if (!voiceChannel) {
      return interaction.reply({
        content: '❌ Join a voice channel first to play a bookmark!',
        flags: MessageFlags.Ephemeral,
      });
    }
    await interaction.deferReply();
    const reply = await executePlay(
      guildId,
      voiceChannel.id,
      interaction.channelId,
      bookmarkName,
      interaction.user,
      'youtube_music',
      isShuffle,
      'normal'
    );
    if (typeof reply === 'string') {
      await interaction.editReply(reply);
    } else {
      await interaction.editReply({ embeds: [reply] });
    }
    return;
  }

  const player = kazagumo.players.get(guildId);
  if (!player || !player.queue.current) {
    return interaction.reply({
      content: '❌ Nothing is currently playing.',
      flags: MessageFlags.Ephemeral,
    });
  }

  // Stateless Queue Pagination Buttons
  if (customId.startsWith('music_qpage_')) {
    const requestedPage = parseInt(customId.replace('music_qpage_', ''), 10) || 1;
    const view = buildQueueView(player, requestedPage);
    if (interaction.message.embeds[0]?.title?.includes('Server Music Queue')) {
      await interaction.update({ embeds: [view.embed], components: view.components });
    } else {
      await interaction.reply({
        embeds: [view.embed],
        components: view.components,
        flags: MessageFlags.Ephemeral,
      });
    }
    return;
  }

  // Lyrics Button
  if (customId === 'music_lyrics') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const res = await executeLyrics(player);
    if (typeof res === 'string') {
      await interaction.editReply(res);
    } else {
      await interaction.editReply({ embeds: [res] });
    }
    return;
  }

  // Grab Song Info Button
  if (customId === 'music_grab') {
    const grabEmbed = buildGrabEmbed(player.queue.current);
    await interaction.user.send({ embeds: [grabEmbed] }).catch(() => {});
    return interaction.reply({
      content: '💾 Sent the track details to your DMs (and shown below)!',
      embeds: [grabEmbed],
      flags: MessageFlags.Ephemeral,
    });
  }

  // Playback modification buttons require being in the voice channel
  const voiceChannel = member.voice.channel;
  if (!voiceChannel) {
    return interaction.reply({
      content: '❌ Join the voice channel to control playback!',
      flags: MessageFlags.Ephemeral,
    });
  }

  switch (customId) {
    case 'music_prev': {
      const res = await executePrevious(player, userId);
      if (res.startsWith('🤍') || res.startsWith('🥫') || res.startsWith('❌')) {
        return interaction.reply({
          content: res,
          flags: res.startsWith('❌') ? MessageFlags.Ephemeral : undefined,
        });
      }
      await interaction.reply({
        content: `⏮️ **${interaction.user.username}**: ${res.replace(/^⏮️\s*/, '')}`,
      });
      break;
    }

    case 'music_toggle_pause': {
      const deny = getDenialForTrack(userId, player.queue.current, 'pause');
      if (deny) return interaction.reply(deny);

      (player as any)._autoPausedByEmptyVC = false;
      player.pause(!player.paused);
      const embed = buildNowPlayingEmbed(player);
      const rows = buildPlayerButtons(player);
      await interaction.update({ embeds: [embed], components: rows });
      break;
    }

    case 'music_skip': {
      const deny = getDenialForTrack(userId, player.queue.current, 'skip');
      if (deny) return interaction.reply(deny);

      const skippedTitle = player.queue.current.title;
      player.skip();
      await interaction.reply({
        content: `⏭️ **${interaction.user.username}** skipped **${skippedTitle}**.`,
      });
      break;
    }

    case 'music_shuffle': {
      const res = executeQueueAction(player, 'shuffle', userId);
      if (res.startsWith('🤍') || res.startsWith('🥫') || res.startsWith('⚠️')) {
        return interaction.reply({
          content: res,
          flags: res.startsWith('⚠️') ? MessageFlags.Ephemeral : undefined,
        });
      }
      const embed = buildNowPlayingEmbed(player);
      const rows = buildPlayerButtons(player);
      await interaction.update({ embeds: [embed], components: rows });
      break;
    }

    case 'music_loop': {
      const nextLoop =
        player.loop === 'none'
          ? 'track'
          : player.loop === 'track'
          ? 'queue'
          : 'none';
      player.setLoop(nextLoop);
      const embed = buildNowPlayingEmbed(player);
      const rows = buildPlayerButtons(player);
      await interaction.update({ embeds: [embed], components: rows });
      break;
    }

    case 'music_autoplay': {
      (player as any).autoplay = !Boolean((player as any).autoplay);
      const embed = buildNowPlayingEmbed(player);
      const rows = buildPlayerButtons(player);
      await interaction.update({ embeds: [embed], components: rows });
      break;
    }

    case 'music_stop': {
      const deny = getDenialForStop(userId, player);
      if (deny) return interaction.reply(deny);
      await executeLeave(player, interaction.guild);
      await interaction.update({
        content: `👋 Stopped playback, cleared the queue, and left the voice channel (by **${interaction.user.username}**).`,
        embeds: [],
        components: [],
      });
      break;
    }
  }
}

function buildFlavorHierarchyEmbed(): EmbedBuilder {
  const coMasters = getCoMasters();
  const coMasterList = coMasters.length
    ? coMasters.map((id, i) => `\`${i + 1}.\` 🌸 <@${id}>`).join('\n')
    : '*None appointed yet. Use `$promote @user` to promote someone to Pipeline Punch.*';

  return new EmbedBuilder()
    .setColor(0xffffff)
    .setTitle('🥫 Monster Energy Flavor Hierarchy')
    .setDescription(
      `**Tier 1 — 🤍 Zero Ultra (Untouchable):**\n` +
        `🤍 <@${SUPREME_MASTER_ID}>\n\n` +
        `**Tier 2 — 🌸 Pipeline Punch (${coMasters.length}):**\n` +
        `${coMasterList}\n\n` +
        `**Tier 3 — 🟢 Original:**\n` +
        `*All other server members*`
    )
    .setFooter({
      text: `Server Lock: ${
        isMasterModeLocked()
          ? '🔒 LOCKED (Zero Ultra & Pipeline Punch Only)'
          : '🔓 UNLOCKED (All Flavors)'
      }`,
    });
}

export async function handleMessage(message: Message) {
  if (message.author.bot || !message.guild) return;

  const prefixes = ['$'];
  const prefix = prefixes.find((p) => message.content.startsWith(p));
  if (!prefix) return;

  const args = message.content.slice(prefix.length).trim().split(/ +/);
  const command = args.shift()?.toLowerCase();
  if (!command || !VALID_PREFIX_COMMANDS.has(command)) return;

  const userId = message.author.id;
  const userRank = getMasterRank(userId); // 2 = Zero Ultra, 1 = Pipeline Punch, 0 = Original
  const userIsMaster = userRank >= 1;
  const userIsSupreme = userRank === 2;

  const sendNotMaster = (msg = NOT_MASTER_MESSAGE) =>
    message.channel.isSendable() ? message.channel.send(msg) : message.reply(msg);

  // 1. Check Lock & Banish List (Zero Ultra & Pipeline Punch bypass lock)
  if (!userIsMaster && (isMasterModeLocked() || isUserBanished(userId))) {
    return sendNotMaster();
  }

  // 2. Check Zero-Ultra-Exclusive Commands ($promote, $demote, $lock, $unlock)
  const zeroUltraOnlyCommands = new Set([
    'promote',
    'addmaster',
    'demote',
    'removemaster',
    'strip',
    'lock',
    'unlock',
  ]);

  if (zeroUltraOnlyCommands.has(command)) {
    if (!userIsSupreme) {
      return sendNotMaster(
        userIsMaster ? OUTRANKED_BY_ZERO_ULTRA_MESSAGE : NOT_MASTER_MESSAGE
      );
    }
  }

  // 3. Check VIP Tier Commands (Zero Ultra + Pipeline Punch)
  const vipOnlyCommands = new Set([
    'banish',
    'forgive',
    'unbanish',
    'banished',
    'pn',
    'playnext',
    'hijack',
    'playnow',
    'top',
    'boost',
  ]);

  if (!userIsMaster && vipOnlyCommands.has(command)) {
    return sendNotMaster();
  }

  const member = message.member;
  const voiceChannel = member?.voice.channel;
  const guildId = message.guild.id;
  const player = kazagumo.players.get(guildId);

  switch (command) {
    // ── Zero Ultra Hierarchy Commands ──
    case 'promote':
    case 'addmaster': {
      const targetUser = message.mentions.users.first();
      const targetId = targetUser?.id || args[0]?.replace(/[<@!>]/g, '');
      if (!targetId) {
        return message.reply('ℹ️ Usage: `$promote @user`');
      }
      if (isSupremeMaster(targetId)) {
        return message.reply('🤍 You are already **Zero Ultra**!');
      }
      addCoMaster(targetId);
      return message.reply(
        `🌸 **Upgraded to Pipeline Punch!** <@${targetId}> has been promoted from **🟢 Original** to **🌸 Pipeline Punch** by **🤍 Zero Ultra**!\n` +
          `*Perks unlocked: \`$playnext\`, \`$hijack\`, \`$top\`, \`$replay\`, \`$fx\`, \`$vol\`, protected tracks vs. Originals, and \`$lock\` immunity!*`
      );
    }

    case 'demote':
    case 'removemaster':
    case 'strip': {
      const targetUser = message.mentions.users.first();
      const targetId = targetUser?.id || args[0]?.replace(/[<@!>]/g, '');
      if (!targetId) {
        return message.reply('ℹ️ Usage: `$demote @user`');
      }
      if (isSupremeMaster(targetId)) {
        return message.reply('🤍 **Zero Ultra** can never be demoted!');
      }
      const removed = removeCoMaster(targetId);
      if (!removed) {
        return message.reply(`ℹ️ <@${targetId}> is already **🟢 Original**.`);
      }
      return message.reply(
        `📉 <@${targetId}> has been demoted from **🌸 Pipeline Punch** back to **🟢 Original**!`
      );
    }

    case 'masters':
    case 'flavors':
    case 'flavor':
    case 'ranks':
    case 'rank': {
      return message.reply({ embeds: [buildFlavorHierarchyEmbed()] });
    }

    // ── Lock & Banish Control Commands ──
    case 'lock': {
      setMasterModeLocked(true);
      return message.reply(
        '🔒 **Locked!** Only **🤍 Zero Ultra** and **🌸 Pipeline Punch** can give me orders right now.'
      );
    }

    case 'unlock': {
      setMasterModeLocked(false);
      return message.reply(
        '🔓 **Unlocked!** **🟢 Original** members can queue songs & save bookmarks again.'
      );
    }

    case 'banish': {
      const targetUser = message.mentions.users.first();
      const targetId = targetUser?.id || args[0]?.replace(/[<@!>]/g, '');
      if (!targetId) {
        return message.reply('ℹ️ Usage: `$banish @user`');
      }
      if (isSupremeMaster(targetId)) {
        return message.reply('🤍 How dare you! I would never banish **Zero Ultra**!');
      }
      if (!userIsSupreme && isAnyMaster(targetId)) {
        return message.reply(
          '🌸 You cannot banish a fellow **Pipeline Punch**! Only **🤍 Zero Ultra** holds that power.'
        );
      }
      banishUser(targetId);
      return message.reply(
        `⚡ <@${targetId}> has been **banished** from ordering me around!`
      );
    }

    case 'forgive':
    case 'unbanish': {
      const targetUser = message.mentions.users.first();
      const targetId = targetUser?.id || args[0]?.replace(/[<@!>]/g, '');
      if (!targetId) {
        return message.reply('ℹ️ Usage: `$forgive @user`');
      }
      forgiveUser(targetId);
      return message.reply(`🕊️ <@${targetId}> has been **forgiven**.`);
    }

    case 'banished': {
      const banishedList = getBanishedUsers();
      if (!banishedList.length) {
        return message.reply('🕊️ No users are currently banished.');
      }
      const list = banishedList.map((id) => `<@${id}>`).join(', ');
      return message.reply(`⚡ **Banished Users:** ${list}`);
    }

    // ── Instant Rewind ($replay / $restart) & Rocket-to-Top ($top / $boost) ──
    case 'replay':
    case 'restart': {
      if (!player || !player.queue.current) {
        return message.reply('❌ Nothing is currently playing to replay.');
      }
      const deny = getDenialForTrack(userId, player.queue.current, 'restart');
      if (deny) return message.reply(deny);

      player.seek(0);
      await refreshNowPlayingMessage(player);
      return message.reply(
        `🔁 Rewinded **${player.queue.current.title}** back to \`0:00\`!`
      );
    }

    case 'top':
    case 'boost': {
      if (!voiceChannel) {
        return message.reply('❌ Join the voice channel first to boost a track!');
      }
      const fromPos = args[0] ? parseInt(args[0].replace(/^#/, ''), 10) : NaN;
      if (Number.isNaN(fromPos)) {
        return message.reply(
          'ℹ️ Usage: `$top <queue_number>` (e.g. `$top 4` to rocket song #4 to the front of the queue)'
        );
      }
      let targetPos = 1;
      if (!userIsSupreme && player?.queue?.size) {
        while (
          targetPos <= player.queue.size &&
          getTrackRank(player.queue[targetPos - 1]) > userRank
        ) {
          targetPos++;
        }
      }
      return message.reply(executeMoveTrack(player, fromPos, targetPos, userId));
    }

    // ── Playback & Priority Queue Commands ──
    case 'p':
    case 'play':
    case 'pn':
    case 'playnext':
    case 'hijack':
    case 'playnow': {
      if (!voiceChannel) {
        return message.reply('❌ You must be in a voice channel to play music!');
      }
      const query = args.join(' ');
      if (!query) {
        return message.reply(
          `❌ Provide a song name, Spotify/YTM link, or saved bookmark! Example: \`$${command} espresso\``
        );
      }

      const priority: 'normal' | 'next' | 'hijack' =
        command === 'pn' || command === 'playnext'
          ? 'next'
          : command === 'hijack' || command === 'playnow'
          ? 'hijack'
          : 'normal';

      if (priority === 'hijack' && player?.queue?.current) {
        const deny = getDenialForTrack(userId, player.queue.current, 'hijack');
        if (deny) return message.reply(deny);
      }

      const statusMsg = await message.reply(
        priority === 'hijack'
          ? userIsSupreme
            ? '🤍 Hijacking playback for **Zero Ultra**...'
            : '🌸 Hijacking playback for **Pipeline Punch**...'
          : priority === 'next'
          ? userIsSupreme
            ? '⚡ Cutting to #1 in the queue for **Zero Ultra**...'
            : '⚡ Cutting to the front of the queue for **Pipeline Punch**...'
          : '🔍 Searching...'
      );

      const reply = await executePlay(
        guildId,
        voiceChannel.id,
        message.channel.id,
        query,
        message.author,
        'youtube_music',
        false,
        priority
      );

      if (typeof reply === 'string') {
        await statusMsg.edit(reply);
      } else {
        await statusMsg.edit({ content: '', embeds: [reply] });
      }
      break;
    }

    case 'save':
    case 'bookmark': {
      const name = args[0];
      const url = args[1];
      const res = await executeBookmarkCommand(
        'save',
        name,
        url,
        message.author.username,
        userId
      );
      if (typeof res === 'string') return message.reply(res);
      return message.reply({ embeds: [res] });
    }

    case 'bookmarks':
    case 'saved': {
      const res = await executeBookmarkCommand(
        'list',
        null,
        null,
        message.author.username,
        userId
      );
      if (typeof res === 'string') return message.reply(res);
      const components = buildBookmarkButtons(listBookmarks(), 1);
      return message.reply({ embeds: [res], components });
    }

    case 'unsave': {
      const name = args[0];
      const res = await executeBookmarkCommand(
        'delete',
        name,
        null,
        message.author.username,
        userId
      );
      if (typeof res === 'string') return message.reply(res);
      return message.reply({ embeds: [res] });
    }

    case 's':
    case 'skip': {
      const jumpTo = args[0] ? parseInt(args[0], 10) : undefined;
      message.reply(executeSkip(player, userId, Number.isNaN(jumpTo) ? undefined : jumpTo));
      break;
    }

    case 'back':
    case 'prev':
    case 'previous': {
      if (!voiceChannel) {
        return message.reply('❌ You must be in the voice channel to go back a track!');
      }
      const res = await executePrevious(player, userId);
      return message.reply(res);
    }

    case 'grab':
    case 'savecurrent': {
      if (!player || !player.queue.current) {
        return message.reply('❌ Nothing is currently playing to grab.');
      }
      const grabEmbed = buildGrabEmbed(player.queue.current);
      await message.author.send({ embeds: [grabEmbed] }).catch(() => {});
      return message.reply({
        content: '💾 Saved! Here is the song card (also sent to your DMs):',
        embeds: [grabEmbed],
      });
    }

    case 'move':
    case 'mv': {
      if (!voiceChannel) {
        return message.reply('❌ Join the voice channel first to reorder the queue!');
      }
      const numericArgs = args
        .filter((tok) => !['to', '->', 'into', 'at'].includes(tok.toLowerCase()))
        .map((tok) => parseInt(tok.replace(/^#/, ''), 10));

      const fromPos = numericArgs[0];
      const toPos = numericArgs[1];

      if (Number.isNaN(fromPos) || Number.isNaN(toPos) || fromPos === undefined || toPos === undefined) {
        return message.reply(
          'ℹ️ Usage: `$move <from> to <position>` or `$move <from> <position>` (e.g., `$move 4 to 1` or `$move 4 1`)'
        );
      }

      return message.reply(executeMoveTrack(player, fromPos, toPos, userId));
    }

    case 'rm':
    case 'remove': {
      const idx = args[0] ? parseInt(args[0], 10) : NaN;
      if (Number.isNaN(idx)) return message.reply('❌ Specify a track number to remove: `$remove 2`');
      message.reply(executeRemoveTrack(player, idx, userId));
      break;
    }

    case 'clear': {
      message.reply(executeQueueAction(player, 'clear', userId));
      break;
    }

    case 'pause':
    case 'resume': {
      message.reply(executeTogglePause(player, userId));
      break;
    }

    case 'shuffle': {
      message.reply(executeQueueAction(player, 'shuffle', userId));
      break;
    }

    case 'autoplay':
    case 'ap': {
      message.reply(executeQueueAction(player, 'autoplay', userId));
      break;
    }

    case 'loop': {
      if (!player) return message.reply('❌ Nothing is playing.');
      const nextLoop =
        player.loop === 'none'
          ? 'loop_track'
          : player.loop === 'track'
          ? 'loop_queue'
          : 'loop_off';
      message.reply(executeQueueAction(player, nextLoop, userId));
      break;
    }

    case 'tune':
    case 'vol':
    case 'volume': {
      if (!player || !player.queue.current) return message.reply('❌ Nothing is playing.');
      const deny = getDenialForTrack(userId, player.queue.current, 'tune');
      if (deny) return message.reply(deny);
      const arg = (args[0] || '').toLowerCase();
      const validFilters = ['off', 'bassboost', 'nightcore', 'slowed', '8d', 'karaoke'];
      if (validFilters.includes(arg)) {
        const label = await applyAudioFilter(player, arg);
        await refreshNowPlayingMessage(player);
        return message.reply(`🎛️ Audio Filter set to **${label}**.`);
      }
      const vol = parseInt(arg, 10);
      if (Number.isNaN(vol) || vol < 1 || vol > 100) {
        return message.reply(
          'ℹ️ Usage: `$vol <1-100>` (capped at 100% to prevent audio clipping) or `$tune <1-100 | bassboost | nightcore | slowed | 8d | off>`'
        );
      }
      player.setVolume(vol);
      return message.reply(`🔊 Volume set to **${vol}%**.`);
    }

    case 'seek': {
      if (!player || !player.queue.current) return message.reply('❌ Nothing is playing.');
      const deny = getDenialForTrack(userId, player.queue.current, 'seek');
      if (deny) return message.reply(deny);

      const ms = parseTimeInput(args[0] || '');
      if (ms === null || ms > (player.queue.current.length || 0)) {
        return message.reply('ℹ️ Usage: `$seek 1:30` or `$seek 90`');
      }
      player.seek(ms);
      return message.reply(`⏩ Seeked to **${formatDuration(ms)}**.`);
    }

    case 'fx':
    case 'filter': {
      if (!player || !player.queue.current) return message.reply('❌ Nothing is playing.');
      const deny = getDenialForTrack(userId, player.queue.current, 'filter');
      if (deny) return message.reply(deny);
      const mode = (args[0] || 'off').toLowerCase();
      const valid = ['off', 'bassboost', 'nightcore', 'slowed', '8d', 'karaoke'];
      if (!valid.includes(mode)) {
        return message.reply(`ℹ️ Available filters: \`${valid.join('`, `')}\``);
      }
      const label = await applyAudioFilter(player, mode);
      await refreshNowPlayingMessage(player);
      return message.reply(`🎛️ Audio Filter set to **${label}**.`);
    }

    case 'l':
    case 'ly':
    case 'lyrics': {
      const customQuery = args.join(' ').trim();
      const statusMsg = await message.reply('🎤 Searching for lyrics...');
      const res = await executeLyrics(player, customQuery || undefined);
      if (typeof res === 'string') {
        await statusMsg.edit(res);
      } else {
        await statusMsg.edit({ content: '', embeds: [res] });
      }
      break;
    }

    case 'stop':
    case 'leave':
    case 'dc':
    case 'disconnect': {
      const deny = getDenialForStop(userId, player);
      if (deny) return message.reply(deny);
      const res = await executeLeave(player, message.guild);
      message.reply(res);
      break;
    }

    case 'np':
    case 'nowplaying': {
      if (!player || !player.queue.current) {
        return message.reply('❌ Nothing is currently playing.');
      }
      const embed = buildNowPlayingEmbed(player);
      const rows = buildPlayerButtons(player);
      return message.reply({ embeds: [embed], components: rows });
    }

    case 'q':
    case 'queue': {
      if (!player || !player.queue.current) {
        return message.reply('❌ The queue is currently empty.');
      }
      const page = args[0] ? parseInt(args[0], 10) || 1 : 1;
      const view = buildQueueView(player, page);
      return message.reply({ embeds: [view.embed], components: view.components });
    }

    case 'help': {
      // Only show VIP embed if the user is part of the VIP tier (Zero Ultra or Pipeline Punch),
      // and post once in the channel (no duplicate DM + channel spam)
      const embeds = getHelpEmbeds(userRank);
      return message.reply({ embeds });
    }
  }
}

export function getHelpEmbeds(userRank = 2): EmbedBuilder[] {
  const publicEmbed = new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle('🥫 White Monster Energy Drink — Command Guide')
    .setDescription(
      '**Flavor Ranks:** `🤍 Zero Ultra` (Top Boss) ❯ `🌸 Pipeline Punch` (VIP) ❯ `🟢 Original` (Members)'
    )
    .addFields({
      name: '🟢 Original Commands (Available to Everyone When Unlocked)',
      value:
        '• **`$play <song/link>`** *(or `$p` / `/play`)* — Play a song, playlist, or bookmark\n' +
        '• **`$bookmarks`** *(or `/bookmark`)* — View & 1-click play saved playlists\n' +
        '• **`$save <name> <link>`** / **`$unsave <name>`** — Save or delete your own bookmark\n' +
        '• **`$pause`** / **`$resume`** / **`$replay`** — Pause, resume, or restart current track\n' +
        '• **`$skip`** *(or `$s`)* / **`$back`** *(or `/back`)* — Next or previous song\n' +
        '• **`$stop`** *(or `$leave`, `$dc`, `/leave`)* — Stop playback & leave voice channel\n' +
        '• **`$queue`** *(or `$q` / `/queue`)* / **`$clear`** — View or clear upcoming queue\n' +
        '• **`$move 4 to 1`** / **`$remove 2`** — Reorder or remove queued tracks\n' +
        '• **`$shuffle`** / **`$loop`** / **`$autoplay`** — Queue modes\n' +
        '• **`$vol <1-100>`** / **`$seek 1:30`** / **`$fx <effect>`** — Volume, seek & audio filters\n' +
        '• **`$lyrics`** / **`$grab`** / **`$np`** / **`$ranks`** — Lyrics, DM song link, player card, or ranks',
    });

  // Non-VIP (🟢 Original) users ONLY see the commands they can execute!
  if (userRank < 1) {
    return [publicEmbed];
  }

  const masterEmbed = new EmbedBuilder()
    .setColor(0xffffff)
    .setTitle('🤍 Zero Ultra & 🌸 Pipeline Punch Perks')
    .addFields({
      name: '🌸 Pipeline Punch & 🤍 Zero Ultra Commands',
      value:
        '• **`$playnext <song>`** *(or `$pn`)* — Cut straight to the front of the queue\n' +
        '• **`$hijack <song>`** — Stop current song & play yours immediately\n' +
        '• **`$top 4`** *(or `$boost 4` / `/queue top:4`)* — Rocket song #4 to #1 in the queue\n' +
        '• **`$banish @user`** / **`$forgive @user`** / **`$banished`** — Block/unblock Originals\n' +
        '• **🔓 Lock Immunity:** Full access to all commands even when `$lock` is active\n' +
        '• **🛡️ Flavor Shield:** Originals cannot stop, skip, pause, remove, or cut in front of your songs!',
    });

  if (userRank >= 2) {
    masterEmbed.addFields({
      name: '🤍 Zero Ultra ONLY (Exclusively You)',
      value:
        '• **`$promote @user`** *(or `/ranks action:Promote`)* — Promote someone to **🌸 Pipeline Punch**\n' +
        '• **`$demote @user`** *(or `/ranks action:Demote`)* — Demote someone back to **🟢 Original**\n' +
        '• **`$lock`** / **`$unlock`** — Lock the bot to Zero Ultra & Pipeline Punch only\n' +
        '• **👑 Untouchable:** Even **🌸 Pipeline Punch** cannot skip, pause, move, or hijack your songs!',
    });
  }

  return [publicEmbed, masterEmbed];
}

function buildGrabEmbed(track: any): EmbedBuilder {
  const { label, color } = getPlatformBadge(track);
  const cleanQuery = encodeURIComponent(
    `${(track.author || '').replace(/ - Topic$/i, '')} ${track.title || ''}`.trim()
  );
  const spotifySearch = `https://open.spotify.com/search/${cleanQuery}`;
  const ytmSearch = `https://music.youtube.com/search?q=${cleanQuery}`;

  const embed = new EmbedBuilder()
    .setColor(color)
    .setAuthor({ name: `${label} • Saved Track Info` })
    .setTitle(track.title || 'Unknown Title')
    .setURL(track.uri || null)
    .setDescription(
      `👤 **Artist:** ${track.author || 'Unknown'}\n` +
        `⏱️ **Duration:** \`${formatDuration(track.length || 0)}\`\n\n` +
        `🔗 **Quick Links:**\n` +
        `• [Direct Track Link](${track.uri || ytmSearch})\n` +
        `• [Find on Spotify](${spotifySearch})\n` +
        `• [Find on YouTube Music](${ytmSearch})`
    );

  if (track.thumbnail) {
    embed.setThumbnail(track.thumbnail);
  }
  return embed;
}

async function executePrevious(player: any, userId: string): Promise<string> {
  if (!player || !player.queue.current) {
    return '❌ Nothing is currently playing.';
  }
  const deny = getDenialForTrack(userId, player.queue.current, 'interrupt');
  if (deny) return deny;

  const prevStack: any[] = (player as any).previousTracks || [];
  if (!prevStack.length) {
    return '❌ There is no previous track in the session history yet!';
  }

  const prevTrack = prevStack.pop()!;
  const currentTrack = player.queue.current;

  player.queue.unshift(prevTrack, currentTrack);
  (player as any)._isGoingBack = true;
  player.skip();

  return `⏮️ Replaying previous track: **${prevTrack.title}** — **${prevTrack.author}**!`;
}

function executeMoveTrack(
  player: any,
  fromPos: number,
  toPos: number,
  userId: string
): string {
  if (!player || !player.queue.size) {
    return '❌ There are no upcoming tracks in the queue to move.';
  }

  const queueSize = player.queue.size;
  if (fromPos < 1 || fromPos > queueSize || toPos < 1 || toPos > queueSize) {
    return `❌ Invalid queue position! Please choose numbers between **1** and **${queueSize}**.`;
  }

  if (fromPos === toPos) {
    return `ℹ️ Track **#${fromPos}** is already at position **#${toPos}**.`;
  }

  const actorRank = getMasterRank(userId);
  const movingTrack = player.queue[fromPos - 1];
  const movingRank = getTrackRank(movingTrack);

  if (actorRank < movingRank && toPos > fromPos) {
    return actorRank === 1
      ? "🤍 Nice try! You may be **🌸 Pipeline Punch**, but you cannot push **🤍 Zero Ultra's** song back in the queue!"
      : "🥫 You cannot push a **Zero Ultra / Pipeline Punch** song further back in the queue! You do not get to order me around";
  }

  if (toPos < fromPos) {
    const displacedSlice = player.queue.slice(toPos - 1, fromPos - 1);
    const highestDisplacedRank = Math.max(0, ...displacedSlice.map((t: any) => getTrackRank(t)));
    if (actorRank < highestDisplacedRank) {
      return highestDisplacedRank === 2 && actorRank === 1
        ? "🤍 Nice try! You may be **🌸 Pipeline Punch**, but you cannot cut in front of **🤍 Zero Ultra's** queued songs!"
        : "🥫 You cannot cut in front of a **Zero Ultra / Pipeline Punch** song! You do not get to order me around";
    }
  }

  player.queue.splice(fromPos - 1, 1);
  player.queue.splice(toPos - 1, 0, movingTrack);

  if (toPos <= 2 || fromPos <= 2) {
    prefetchNextTrack(player);
  }
  refreshNowPlayingMessage(player);

  return `🔀 Moved **[${movingTrack.title}](${movingTrack.uri})** from position **#${fromPos}** to **#${toPos}**!`;
}

async function applyAudioFilter(player: any, filterKey: string): Promise<string> {
  switch (filterKey) {
    case 'bassboost': {
      await player.shoukaku.setFilters({
        volume: 0.9,
        equalizer: [
          { band: 0, gain: 0.2 },
          { band: 1, gain: 0.16 },
          { band: 2, gain: 0.12 },
          { band: 3, gain: 0.06 },
          { band: 10, gain: -0.09 },
          { band: 11, gain: -0.09 },
        ],
      });
      player.activeFilter = 'Bass Boost';
      return '🔊 Bass Boost';
    }
    case 'nightcore': {
      await player.shoukaku.setFilters({
        volume: 0.9,
        timescale: { speed: 1.2, pitch: 1.2, rate: 1.0 },
        equalizer: [
          { band: 10, gain: -0.1 },
          { band: 11, gain: -0.1 },
          { band: 12, gain: -0.08 },
        ],
      });
      player.activeFilter = 'Nightcore';
      return '⚡ Nightcore';
    }
    case 'slowed': {
      await player.shoukaku.setFilters({
        volume: 0.95,
        timescale: { speed: 0.85, pitch: 0.9, rate: 1.0 },
      });
      player.activeFilter = 'Slowed';
      return '🌙 Slowed + Aesthetic';
    }
    case '8d': {
      await player.shoukaku.setFilters({
        volume: 0.95,
        rotation: { rotationHz: 0.15 },
      });
      player.activeFilter = '8D Audio';
      return '🎧 8D Surround Audio';
    }
    case 'karaoke': {
      await player.shoukaku.setFilters({
        volume: 0.95,
        karaoke: { level: 1.0, monoLevel: 1.0, filterBand: 220.0, filterWidth: 100.0 },
      });
      player.activeFilter = 'Karaoke';
      return '🎤 Karaoke';
    }
    case 'off':
    default: {
      await player.shoukaku.setFilters({
        volume: 0.95,
        equalizer: [
          { band: 9, gain: -0.05 },
          { band: 10, gain: -0.08 },
          { band: 11, gain: -0.08 },
          { band: 12, gain: -0.06 },
          { band: 13, gain: -0.04 },
        ],
      });
      player.activeFilter = 'Off';
      return '✨ Off (Ear-Safe Studio)';
    }
  }
}

async function executeBookmarkCommand(
  action: string,
  name: string | null | undefined,
  url: string | null | undefined,
  username: string,
  userId: string
): Promise<string | EmbedBuilder> {
  const actorRank = getMasterRank(userId);

  if (action === 'list') {
    const all = listBookmarks();
    if (!all.length) {
      return '📋 No bookmarks saved yet! Save a playlist with `/bookmark action:Save name:chill url:<spotify_url>` or `$save chill <url>`.';
    }
    const listStr = all
      .map((b, i) => {
        const bRank = getBookmarkRank(b);
        const badge = bRank === 2 ? '🤍' : bRank === 1 ? '🌸' : '🟢';
        return `\`${i + 1}.\` ${badge} **${b.name}** — [Open Link](${b.url}) *(by ${b.createdBy})*`;
      })
      .join('\n');

    return new EmbedBuilder()
      .setColor(0x1db954)
      .setTitle(`⭐ Saved Playlist & Song Bookmarks (${all.length})`)
      .setDescription(
        `${listStr}\n\n💡 *Click a button below to play or shuffle immediately, or type \`$play <name>\`!*`
      );
  }

  if (action === 'delete') {
    if (!name) return '❌ Please specify the bookmark name to delete.';
    const existing = getBookmark(name);
    if (!existing) {
      return `❌ Could not find a bookmark named **${name}**.`;
    }
    const ownerRank = getBookmarkRank(existing);
    if (actorRank < ownerRank) {
      return ownerRank === 2
        ? '🤍 You cannot delete a bookmark created by **Zero Ultra**!'
        : '🌸 You cannot delete a bookmark created by **Pipeline Punch**!';
    }
    const ok = await removeBookmark(name);
    return ok
      ? `🗑️ Deleted bookmark **${name}**.`
      : `❌ Could not find a bookmark named **${name}**.`;
  }

  if (!name || !url) {
    return '❌ Usage: `$save <shortcut_name> <spotify_or_ytm_url>` (e.g. `$save chill https://open.spotify.com/playlist/...`)';
  }

  const existing = getBookmark(name);
  if (existing) {
    const ownerRank = getBookmarkRank(existing);
    if (actorRank < ownerRank) {
      return ownerRank === 2
        ? `🤍 The bookmark **${existing.name}** belongs to **Zero Ultra** and cannot be overwritten! Pick a different name.`
        : `🌸 The bookmark **${existing.name}** belongs to **Pipeline Punch** and cannot be overwritten! Pick a different name.`;
    }
  }

  const saved = await saveBookmark(name, url, username, userId);
  return `⭐ Saved bookmark **${saved.name}**! Anyone can now play it anytime by typing \`$play ${saved.name}\` or clicking it in \`$bookmarks\`.`;
}

async function executeLyrics(
  player: any,
  customQuery?: string
): Promise<string | EmbedBuilder> {
  let title = '';
  let artist = '';
  let thumbnail: string | undefined;
  let color = 0x1db954;

  if (customQuery) {
    title = customQuery;
  } else {
    const current = player?.queue?.current;
    if (!current) {
      return '❌ Nothing is currently playing! Start playing a song first, or specify one: `$lyrics <song name>`';
    }
    title = current.title || '';
    artist = current.author || '';
    thumbnail = current.thumbnail;
    color = getPlatformBadge(current).color;
  }

  const result = await fetchLyrics(title, artist);
  if (!result) {
    const label = artist ? `**${title}** by **${artist}**` : `**${title}**`;
    return `❌ Could not find lyrics for ${label}.`;
  }

  return buildLyricsEmbed(result, thumbnail, color);
}

async function executePlay(
  guildId: string,
  voiceId: string,
  textId: string,
  rawQuery: string,
  user: User,
  engine = 'youtube_music',
  shufflePlaylist = false,
  priority: 'normal' | 'next' | 'hijack' = 'normal'
): Promise<string | EmbedBuilder> {
  const bookmark = getBookmark(rawQuery);
  const query = bookmark ? bookmark.url : rawQuery;
  const userRank = getMasterRank(user.id);

  let player = kazagumo.players.get(guildId);
  if (!player) {
    player = await kazagumo.createPlayer({
      guildId,
      textId,
      voiceId,
      deaf: true,
      volume: 85, // Crisp 85% default volume (with 0.95 anti-spike filter = distortion-free loudness)
    });
  } else {
    player.setTextChannel(textId);
  }

  const result = await kazagumo.search(query, {
    requester: user,
    engine,
  });

  if (!result.tracks.length) {
    return '❌ No results found for that search or link.';
  }

  const wasAlreadyPlaying = player.playing || player.paused;

  if (result.type === 'PLAYLIST') {
    const tracks = [...result.tracks];
    if (shufflePlaylist) {
      for (let i = tracks.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [tracks[i], tracks[j]] = [tracks[j], tracks[i]];
      }
    }

    if (priority === 'hijack') {
      player.queue.unshift(...tracks);
    } else if (priority === 'next') {
      insertTracksByMasterRank(player, tracks, user.id);
    } else {
      player.queue.add(tracks);
    }

    const totalMs = tracks.reduce((acc, t) => acc + (t.length || 0), 0);
    const { label, color } = getPlatformBadge(tracks[0]);
    const rankIcon =
      userRank === 2 ? '🤍 Zero Ultra' : userRank === 1 ? '🌸 Pipeline Punch' : '🟢 Original';
    const priorityTag =
      priority === 'hijack'
        ? `${rankIcon} Hijack`
        : priority === 'next'
        ? `${rankIcon} Play Next`
        : bookmark
        ? `Bookmark "${bookmark.name}"`
        : 'Playlist';

    const embed = new EmbedBuilder()
      .setColor(color)
      .setAuthor({
        name: `${label} • ${priorityTag} Queued`,
      })
      .setTitle(`📂 ${result.playlistName || 'Loaded Playlist'}`)
      .setDescription(
        `Added **${tracks.length}** tracks ${
          priority !== 'normal' ? 'to the **front of the queue**' : 'to the queue'
        }` +
          (shufflePlaylist ? ' *(🔀 Shuffled)*' : '') +
          `.\n**First Track:** [${tracks[0].title}](${tracks[0].uri}) — **${tracks[0].author}**`
      )
      .addFields(
        { name: 'Total Tracks', value: `${tracks.length}`, inline: true },
        { name: 'Total Duration', value: formatDuration(totalMs), inline: true },
        { name: 'Queue Size', value: `${player.queue.totalSize}`, inline: true }
      )
      .setFooter({
        text: `${rankIcon} • Requested by ${user.username}`,
      });

    if (tracks[0].thumbnail) {
      embed.setThumbnail(tracks[0].thumbnail);
    }

    if (!wasAlreadyPlaying) {
      await player.play();
    } else if (priority === 'hijack') {
      player.skip();
    } else {
      prefetchNextTrack(player);
    }
    return embed;
  } else {
    const track = result.tracks[0];
    let insertedSlot = player.queue.size + 1;
    if (priority === 'hijack') {
      player.queue.unshift(track);
      insertedSlot = 1;
    } else if (priority === 'next') {
      insertedSlot = insertTracksByMasterRank(player, [track], user.id);
    } else {
      player.queue.add(track);
      insertedSlot = player.queue.size;
    }

    const { label, color } = getPlatformBadge(track);
    const rankTitle =
      userRank === 2 ? '🤍 Zero Ultra' : userRank === 1 ? '🌸 Pipeline Punch' : '🟢 Original';
    const authorHeader =
      priority === 'hijack'
        ? `${label} • ${rankTitle} Hijacked Playback`
        : priority === 'next'
        ? `${label} • ⚡ ${rankTitle} Priority (#${insertedSlot} Next)`
        : `${label} • Track Added (${rankTitle})`;

    const positionLabel =
      !wasAlreadyPlaying || priority === 'hijack'
        ? 'Playing Now'
        : priority === 'next'
        ? `#${insertedSlot} (Priority)`
        : `#${insertedSlot}`;

    const embed = new EmbedBuilder()
      .setColor(color)
      .setAuthor({ name: authorHeader })
      .setTitle(track.title || 'Unknown Track')
      .setURL(track.uri || null)
      .setDescription(`👤 **Artist:** ${track.author || 'Unknown'}`)
      .addFields(
        {
          name: 'Duration',
          value: formatDuration(track.length || 0),
          inline: true,
        },
        {
          name: 'Position in Queue',
          value: positionLabel,
          inline: true,
        }
      )
      .setFooter({
        text: `${rankTitle} • Requested by ${user.username}`,
      });

    if (track.thumbnail) {
      embed.setThumbnail(track.thumbnail);
    }

    if (!wasAlreadyPlaying) {
      await player.play();
    } else if (priority === 'hijack') {
      player.skip();
    } else {
      prefetchNextTrack(player);
    }
    return embed;
  }
}

function executeRemoveTrack(player: any, position: number, userId: string): string {
  if (!player || !player.queue.size) {
    return '❌ There are no upcoming tracks in the queue to remove.';
  }
  if (position < 1 || position > player.queue.size) {
    return `❌ Invalid track number! Choose between **1** and **${player.queue.size}**.`;
  }
  const targetTrack = player.queue[position - 1];
  const deny = getDenialForTrack(userId, targetTrack, 'remove');
  if (deny) return deny;

  player.queue.remove(position - 1);
  if (position <= 2) {
    prefetchNextTrack(player);
  }
  return `🗑️ Removed **${targetTrack?.title || `#${position}`}** from the queue.`;
}

function executeSkip(player: any, userId: string, jumpTo?: number): string {
  if (!player || !player.queue.current) {
    return '❌ There is no song playing to skip.';
  }

  const denyCurrent = getDenialForTrack(userId, player.queue.current, 'skip');
  if (denyCurrent) return denyCurrent;

  const actorRank = getMasterRank(userId);

  if (jumpTo && jumpTo > 1) {
    if (jumpTo > player.queue.size) {
      return `❌ Invalid queue position! There are only **${player.queue.size}** upcoming track(s).`;
    }
    const skippedRange = player.queue.slice(0, jumpTo - 1);
    const highestSkippedRank = Math.max(0, ...skippedRange.map((t: any) => getTrackRank(t)));
    if (actorRank < highestSkippedRank) {
      return highestSkippedRank === 2 && actorRank === 1
        ? "🤍 Nice try! You may be **🌸 Pipeline Punch**, but you cannot skip over **🤍 Zero Ultra's** queued songs!"
        : "🥫 You cannot skip over a **Zero Ultra / Pipeline Punch** queued song! You do not get to order me around";
    }
    player.queue.splice(0, jumpTo - 1);
  }

  const skippedTrack = player.queue.current;
  player.skip();
  return jumpTo && jumpTo > 1
    ? `⏭️ Jumped to track **#${jumpTo}** in the queue!`
    : `⏭️ Skipped **${skippedTrack.title}**.`;
}

function executeTogglePause(player: any, userId: string): string {
  if (!player || !player.queue.current) {
    return '❌ Nothing is currently playing.';
  }
  const deny = getDenialForTrack(userId, player.queue.current, 'pause');
  if (deny) return deny;

  (player as any)._autoPausedByEmptyVC = false;
  const newPausedState = !player.paused;
  player.pause(newPausedState);
  refreshNowPlayingMessage(player);
  return newPausedState ? '⏸️ Playback **paused**.' : '▶️ Playback **resumed**.';
}

async function executeLeave(player: any, guild: any): Promise<string> {
  const botVoiceChannel = guild?.members?.me?.voice?.channel;

  if (!player && !botVoiceChannel) {
    return '❌ The bot is not currently in a voice channel.';
  }

  if (player) {
    try {
      player.autoplay = false;
      player.queue.clear();
      player.destroy();
    } catch {
      // ignore if already destroyed
    }
  }

  if (botVoiceChannel) {
    try {
      await guild.members.me.voice.disconnect();
    } catch {
      // ignore
    }
  }

  return '👋 Stopped all playback, cleared the queue, and left the voice channel.';
}

function executeQueueAction(player: any, action: string, userId: string): string {
  if (!player || !player.queue.current) {
    return '❌ The queue is currently empty.';
  }

  const actorRank = getMasterRank(userId);

  switch (action) {
    case 'shuffle': {
      if (player.queue.size < 2) {
        return '⚠️ Need at least 2 upcoming tracks in the queue to shuffle.';
      }
      if (actorRank < 2) {
        const allTracks = [...player.queue];
        const protectedTracks = allTracks.filter((t) => getTrackRank(t) > actorRank);
        const shuffleableTracks = allTracks.filter((t) => getTrackRank(t) <= actorRank);

        if (shuffleableTracks.length < 2) {
          return actorRank === 1
            ? "🤍 You cannot shuffle **Zero Ultra's** playlist!"
            : "🥫 You cannot shuffle a **Zero Ultra / Pipeline Punch** playlist! You do not get to order me around";
        }

        for (let i = shuffleableTracks.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [shuffleableTracks[i], shuffleableTracks[j]] = [
            shuffleableTracks[j],
            shuffleableTracks[i],
          ];
        }

        player.queue.clear();
        player.queue.add([...protectedTracks, ...shuffleableTracks]);
        prefetchNextTrack(player);
        refreshNowPlayingMessage(player);
        return `🔀 Shuffled **${shuffleableTracks.length}** track(s) (${
          protectedTracks.length
            ? `🤍 ${protectedTracks.length} higher-rank track(s) remain pinned at the front`
            : 'done'
        })!`;
      }

      player.queue.shuffle();
      prefetchNextTrack(player);
      refreshNowPlayingMessage(player);
      return `🔀 Shuffled **${player.queue.size}** upcoming tracks in the queue!`;
    }
    case 'autoplay': {
      player.autoplay = !Boolean(player.autoplay);
      refreshNowPlayingMessage(player);
      return `🔄 Autoplay (Radio Mode) is now **${player.autoplay ? 'ENABLED' : 'DISABLED'}**.`;
    }
    case 'clear': {
      if (actorRank < 2) {
        const allTracks = [...player.queue];
        const protectedTracks = allTracks.filter((t) => getTrackRank(t) > actorRank);
        const removedCount = allTracks.length - protectedTracks.length;
        if (removedCount === 0 && protectedTracks.length > 0) {
          return actorRank === 1
            ? "🤍 Nice try! You may be **🌸 Pipeline Punch**, but you cannot clear **🤍 Zero Ultra's** queue!"
            : "🥫 You cannot clear a **Zero Ultra / Pipeline Punch** queue! You do not get to order me around";
        }
        player.queue.clear();
        if (protectedTracks.length) {
          player.queue.add(protectedTracks);
        }
        prefetchNextTrack(player);
        refreshNowPlayingMessage(player);
        return protectedTracks.length
          ? `🗑️ Cleared **${removedCount}** track(s) from the queue (🛡️ **${protectedTracks.length}** higher-rank VIP track(s) remained untouched!).`
          : `🗑️ Cleared **${removedCount}** upcoming track(s) from the queue.`;
      }

      const count = player.queue.size;
      player.queue.clear();
      refreshNowPlayingMessage(player);
      return `🗑️ Cleared **${count}** upcoming track(s) from the queue.`;
    }
    case 'loop_track': {
      player.setLoop('track');
      refreshNowPlayingMessage(player);
      return '🔂 Loop mode set to **Current Track**.';
    }
    case 'loop_queue': {
      player.setLoop('queue');
      refreshNowPlayingMessage(player);
      return '🔁 Loop mode set to **Entire Queue**.';
    }
    case 'loop_off':
    default: {
      player.setLoop('none');
      refreshNowPlayingMessage(player);
      return '➡️ Loop mode **disabled**.';
    }
  }
}
