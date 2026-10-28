import { REST, Routes, Events, MessageFlags } from 'discord.js';
import { client } from './client.js';
import { config } from './config.js';
import { getMasterRank, initBookmarks } from './bookmarks.js';
import {
  slashCommands,
  handleAutocomplete,
  handleInteraction,
  handleButtonInteraction,
  handleMessage,
  getHelpEmbeds,
} from './commands.js';

const rest = new REST({ version: '10' }).setToken(config.discord.token);

async function syncSlashCommands() {
  const commandData = slashCommands.map((cmd) => cmd.toJSON());

  try {
    // 1. Clear global commands to eliminate duplicate/redundant slash commands in Discord
    console.log('[Discord] Clearing duplicate global slash commands...');
    await rest.put(Routes.applicationCommands(config.discord.clientId), {
      body: [],
    });
  } catch (err) {
    console.error('[Discord] Error clearing global commands:', err);
  }

  // 2. Register clean guild-level slash commands for instant visibility
  for (const [guildId, guild] of client.guilds.cache) {
    try {
      await rest.put(Routes.applicationGuildCommands(config.discord.clientId, guildId), {
        body: commandData,
      });
      console.log(
        `✅ [Discord] Synced ${commandData.length} clean slash commands for: "${guild.name}"!`
      );
    } catch (error) {
      console.error(`❌ [Discord] Failed to register guild commands for "${guild.name}":`, error);
    }
  }
}

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`=============================================`);
  console.log(`✅ Logged in as ${readyClient.user.tag}!`);
  console.log(`🤖 Present in ${readyClient.guilds.cache.size} server(s):`);
  readyClient.guilds.cache.forEach((g) => console.log(`   - ${g.name} (ID: ${g.id})`));
  console.log(`=============================================`);

  await syncSlashCommands();
});

client.on(Events.GuildCreate, async (guild) => {
  console.log(`[Discord] Joined a new server: ${guild.name} (${guild.id})`);
  try {
    await rest.put(Routes.applicationGuildCommands(config.discord.clientId, guild.id), {
      body: slashCommands.map((cmd) => cmd.toJSON()),
    });
    console.log(`✅ [Discord] Synced slash commands for new server: ${guild.name}`);
  } catch (err) {
    console.error(`❌ [Discord] Failed to register slash commands for new server:`, err);
  }
});

// Interaction handler (Autocomplete + Slash Commands + Interactive Player Buttons)
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isAutocomplete()) {
      await handleAutocomplete(interaction);
      return;
    }

    if (interaction.isChatInputCommand()) {
      console.log(
        `[Slash Command] /${interaction.commandName} from ${interaction.user.tag}`
      );
      await handleInteraction(interaction);
    } else if (interaction.isButton() && interaction.customId.startsWith('music_')) {
      console.log(
        `[Button Click] ${interaction.customId} from ${interaction.user.tag}`
      );
      await handleButtonInteraction(interaction);
    }
  } catch (error) {
    console.error(`[Interaction Error]:`, error);
    if (interaction.isRepliable()) {
      if (interaction.deferred || interaction.replied) {
        await interaction
          .editReply('❌ An error occurred while executing this action.')
          .catch(() => {});
      } else {
        await interaction
          .reply({
            content: '❌ An error occurred while executing this action.',
            flags: MessageFlags.Ephemeral,
          })
          .catch(() => {});
      }
    }
  }
});

// Prefix command message handler ($play, $skip, etc. + DM guide)
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  // If someone DMs the bot directly, reply with the Command Guide for their rank!
  if (!message.guild) {
    const rank = getMasterRank(message.author.id);
    await message.reply({ embeds: getHelpEmbeds(rank) }).catch(() => {});
    return;
  }

  if (message.content.startsWith('$')) {
    console.log(`[Message Command] "${message.content}" from ${message.author.tag}`);
    try {
      await handleMessage(message);
    } catch (err) {
      console.error(`[Message Command Error]:`, err);
      message.reply('❌ An error occurred while executing that command.').catch(() => {});
    }
  }
});

process.on('unhandledRejection', (err) => {
  console.error('[Process] Unhandled Rejection:', err);
});

process.on('uncaughtException', (err) => {
  console.error('[Process] Uncaught Exception:', err);
});

async function main() {
  console.log('🚀 Starting All-Rounder Discord Music Bot...');
  await initBookmarks();

  while (true) {
    try {
      await client.login(config.discord.token);
      break;
    } catch (err: any) {
      console.error(
        `[Boot] Network/Discord not ready yet (${err?.message || err}). Retrying in 5s...`
      );
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

main().catch((err) => {
  console.error('Fatal initialization error:', err);
});
