# 🎵 Discord Spotify Music Bot

A production-grade, highly scalable Discord Music Bot built with **TypeScript**, **discord.js v14**, and a **Lavalink v4** audio server with native **Spotify** integration.

---

## ✨ Features

- **Full Spotify Support**: Plays Spotify track, album, and playlist URLs directly.
- **YouTube & Search Support**: Search for any song by name or YouTube URL.
- **Ultra-Scalable Architecture**: Audio transcoding and voice streaming are offloaded to **Lavalink**, keeping the bot lightweight, responsive, and lag-free across multiple servers.
- **Modern Discord Slash Commands**: Fully integrated with Discord's interaction system (`/play`, `/skip`, `/pause`, `/resume`, `/stop`, `/queue`, `/nowplaying`).
- **Rich Embeds**: Visual feedback with track titles, artists, duration, and queue counts.

---

## 📋 Prerequisites

All of these run locally and are 100% free:
- **Node.js 18+** (Installed)
- **Java 17+** (Installed for Lavalink)
- **Discord Bot Token & Client ID** (Free from Discord Developer Portal)
- **Spotify Client ID & Secret** (Free from Spotify Developer Dashboard)

---

## 🚀 Setup Guide

### Step 1: Get Discord Bot Credentials (2 minutes)

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications).
2. Click **New Application**, give it a name (e.g. `Spotify Music Bot`), and click **Create**.
3. In the left sidebar, click **Bot**:
   - Click **Reset Token** (or **View Token**) and copy your token. This is your `DISCORD_TOKEN`.
   - Scroll down to **Privileged Gateway Intents** and enable **Server Members Intent** and **Message Content Intent**.
4. In the left sidebar, click **General Information**:
   - Copy the **Application ID**. This is your `DISCORD_CLIENT_ID`.
5. In the left sidebar, click **OAuth2 > URL Generator**:
   - Under **Scopes**, select `bot` and `applications.commands`.
   - Under **Bot Permissions**, select:
     - `Connect`
     - `Speak`
     - `Send Messages`
     - `Embed Links`
     - `Use Slash Commands`
   - Copy the generated URL at the bottom, paste it into your browser, and invite the bot to your server.

---

### Step 2: Get Spotify API Credentials (1 minute)

1. Go to the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) and log in with any Spotify account (free or premium).
2. Click **Create an App**:
   - App Name: `Discord Bot`
   - App Description: `Music Bot`
   - Redirect URI: `http://localhost:3000` (or any dummy URL, required by Spotify)
   - Which API/SDKs are you planning to use: Check **Web API**.
   - Accept the terms and click **Save**.
3. Click **Settings**:
   - Copy the **Client ID** (`SPOTIFY_CLIENT_ID`).
   - Click **View client secret** and copy it (`SPOTIFY_CLIENT_SECRET`).

---

### Step 3: Configure `.env`

Open the `.env` file in this directory and paste your keys:

```env
DISCORD_TOKEN=your_bot_token_here
DISCORD_CLIENT_ID=your_application_id_here

SPOTIFY_CLIENT_ID=your_spotify_client_id_here
SPOTIFY_CLIENT_SECRET=your_spotify_client_secret_here

LAVALINK_HOST=127.0.0.1
LAVALINK_PORT=2333
LAVALINK_PASSWORD=youshallnotpass
```

---

### Step 4: Run the Bot

#### Option A: One-Click Launcher (Windows)
Double-click `run-all.bat`. It will:
1. Start the Lavalink audio server in a separate window.
2. Wait a few seconds for Lavalink to be ready.
3. Start the Discord bot.

#### Option B: From the Terminal
In two separate terminals:
- **Terminal 1 (Lavalink)**:
  ```bash
  npm run lavalink
  ```
- **Terminal 2 (Bot)**:
  ```bash
  npm start
  ```

---

## 🎧 Slash Commands

| Command | Description | Example |
| :--- | :--- | :--- |
| `/play <query>` | Play a song or playlist from Spotify, YouTube, or search | `/play https://open.spotify.com/track/...` or `/play Bohemian Rhapsody` |
| `/skip` | Skip the current playing song | `/skip` |
| `/pause` | Pause music playback | `/pause` |
| `/resume` | Resume paused playback | `/resume` |
| `/stop` | Stop playback, clear queue, and leave voice channel | `/stop` |
| `/queue` | Display the current server queue | `/queue` |
| `/nowplaying` | Show detailed info on the currently playing track | `/nowplaying` |

---

## 📁 Project Structure

```
discord-spotify-bot/
├── src/
│   ├── client.ts        # Discord.js + Kazagumo + Shoukaku initialization
│   ├── commands.ts      # Slash command builders and handlers
│   ├── config.ts        # Environment variable loader
│   └── index.ts         # Main bot entrypoint & command registration
├── lavalink/
│   ├── Lavalink.jar     # High-performance audio streaming server
│   └── application.yml  # Lavalink & LavaSrc (Spotify/YouTube) config
├── run-all.bat          # One-click Windows starter for both services
├── run-bot.bat          # Windows starter for the bot
├── run-lavalink.bat     # Windows starter for Lavalink
├── package.json
├── tsconfig.json
└── .env                 # Your secret credentials
```
