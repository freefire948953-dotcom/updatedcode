// ╔══════════════════════════════════════════════════════════════╗
// ║           SKY x MUSIC BOT — index.js                        ║
// ║  Features: Play, Queue, Loop, Shuffle, Volume, 24/7,        ║
// ║            Autoplay, Spotify, Lyrics, DJ Role,              ║
// ║            Song History, Vote Skip, Components V2 UI        ║
// ╚══════════════════════════════════════════════════════════════╝

const {
  Client, GatewayIntentBits, ActivityType,
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ContainerBuilder, SectionBuilder, TextDisplayBuilder,
  ThumbnailBuilder, SeparatorBuilder, SeparatorSpacingSize, MessageFlags
} = require('discord.js');
const { Riffy } = require('riffy');
const config = require('./config.js');
const express = require('express');
require('dotenv').config();

// ─── Global error handlers ─────────────────────────────────────────────────────
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

// ─── Spotify Integration ───────────────────────────────────────────────────────
const spotifyModule = require('./spotify');
const SpotifyClient = require('spotify-url-info');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
spotifyModule.init({ spotifyClient: SpotifyClient(fetch) });

// ─── Lyrics (genius-lyrics) ────────────────────────────────────────────────────
let Genius = null;
let geniusClient = null;
try {
  Genius = require('genius-lyrics');
  geniusClient = new Genius.Client();
} catch (_) {
  console.warn('⚠️  genius-lyrics not installed — /lyrics will be unavailable');
}

// ─── Express Keep-Alive ────────────────────────────────────────────────────────
function startExpressServer() {
  if (!config.express?.enabled) return;
  const app = express();
  app.get('/', (req, res) => res.json({
    status: 'online',
    bot: client.user?.tag ?? 'Starting...',
    servers: client.guilds.cache.size,
    uptime: process.uptime(),
    lavalink: isLavalinkConnected ? 'connected' : 'disconnected'
  }));
  app.get('/stats', (req, res) => res.json({
    guilds: client.guilds.cache.size,
    users: client.guilds.cache.reduce((a, g) => a + g.memberCount, 0),
    players: riffy.players?.size ?? 0,
    uptime: process.uptime(),
    memory: (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2),
    ping: client.ws?.ping ?? 0,
    lavalink: isLavalinkConnected
  }));
  app.listen(config.express.port, '0.0.0.0', () =>
    console.log(`🌐 Express running on port ${config.express.port}`)
  );
}
startExpressServer();

// ─── Discord Client ────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages
  ],
  allowedMentions: { parse: [] }
});

let isLavalinkConnected = false;

const riffy = new Riffy(client, config.lavalink.nodes, {
  send: (payload) => {
    try {
      if (!payload?.d?.guild_id) return;
      const guild = client.guilds.cache.get(payload.d.guild_id);
      if (guild) guild.shard.send(payload);
    } catch (err) {
      console.error('Riffy send error:', err);
    }
  },
  defaultSearchPlatform: 'ytmsearch',
  restVersion: 'v4'
});

// ─── State Maps ────────────────────────────────────────────────────────────────
const queue247        = new Set();          // guildIds with 24/7 on
const autoplayEnabled = new Set();          // guildIds with autoplay on
const djRoles         = new Map();          // guildId → roleId
const nowPlayingMsgs  = new Map();          // guildId → Message
const songHistory     = new Map();          // guildId → Track[]   (max 20)
const voteSkips       = new Map();          // guildId → Set<userId>

// ─── Helpers ───────────────────────────────────────────────────────────────────
function formatTime(ms) {
  if (!ms || isNaN(ms)) return '0:00';
  const s = Math.floor((ms / 1000) % 60);
  const m = Math.floor((ms / 60000) % 60);
  const h = Math.floor(ms / 3600000);
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

function resolveThumbnail(info) {
  if (info.artworkUrl) return info.artworkUrl;
  if (info.thumbnail)  return info.thumbnail;
  const uri = info.uri || '';
  let vid = null;
  if (uri.includes('youtube.com'))  vid = uri.split('v=')[1]?.split('&')[0];
  else if (uri.includes('youtu.be')) vid = uri.split('youtu.be/')[1]?.split('?')[0];
  return vid
    ? `https://img.youtube.com/vi/${vid}/maxresdefault.jpg`
    : 'https://i.imgur.com/QYJfXQv.png';
}

function pushHistory(guildId, track) {
  if (!songHistory.has(guildId)) songHistory.set(guildId, []);
  const hist = songHistory.get(guildId);
  // avoid duplicates at top
  if (hist[0]?.info?.uri === track.info?.uri) return;
  hist.unshift(track);
  if (hist.length > 20) hist.pop();
}

/**
 * Check if a member is allowed to use music controls.
 * Allowed if: no DJ role set for guild  OR  member has the DJ role  OR  member is admin.
 */
function hasDJPermission(member, guildId) {
  const roleId = djRoles.get(guildId);
  if (!roleId) return true;
  if (member.permissions.has('Administrator')) return true;
  return member.roles.cache.has(roleId);
}

// ─── Fallback resolver ─────────────────────────────────────────────────────────
async function resolveWithFallback(query, requesterId) {
  const isUrl = /^https?:\/\//i.test(query);
  if (isUrl) {
    try {
      const r = await riffy.resolve({ query, requester: requesterId });
      if (r?.tracks?.length) return r;
    } catch (e) { console.error('Direct URL resolve error:', e.message); }
  }
  for (const platform of ['ytmsearch', 'ytsearch', 'scsearch']) {
    try {
      const q = isUrl ? query : `${platform}:${query}`;
      const r = await riffy.resolve({ query: q, requester: requesterId });
      if (r?.tracks?.length) { console.log(`✅ Found on ${platform}`); return r; }
    } catch (e) { console.error(`❌ ${platform}:`, e.message); }
  }
  return null;
}

// ─── Spotify → Riffy adapter ───────────────────────────────────────────────────
function makeSpotifyAdapter(guildId, voiceChannelId, textChannelId, requesterId) {
  return {
    getQueue: (gId) => {
      const p = riffy.players.get(gId);
      return p ? p.queue : [];
    },
    enqueue: async (gId, items) => {
      let player = riffy.players.get(gId);
      if (!player) {
        player = riffy.createConnection({ guildId, voiceChannel: voiceChannelId, textChannel: textChannelId, deaf: true });
      }
      const trackArray = Array.isArray(items) ? items : [items];
      for (const item of trackArray) {
        try {
          const result = await riffy.resolve({ query: `ytmsearch:${item.search}`, requester: requesterId });
          if (result?.tracks?.length) {
            const track = result.tracks[0];
            track.info.requester = requesterId;
            player.queue.add(track);
          }
        } catch (e) { console.error(`Spotify track fail: ${item.title}`, e.message); }
      }
      if (!player.playing && !player.paused) player.play();
    },
    guilds: { get: () => ({ maxQueue: 500 }) }
  };
}

// ══════════════════════════════════════════════════════════════════
//  UI BUILDERS — Components V2
// ══════════════════════════════════════════════════════════════════

function createNowPlayingContainer(player, track, disabled = false) {
  const info = track.info ?? {};
  const thumb = resolveThumbnail(info);
  const isPaused = player.paused;
  const loopEmoji = player.loop === 'track' ? '🔂' : player.loop === 'queue' ? '🔁' : '➡️';
  const votes = voteSkips.get(player.guildId)?.size ?? 0;

  return new ContainerBuilder()
    .addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `## 🎵 Now Playing\n` +
            `**[${info.title ?? 'Unknown Title'}](${info.uri ?? 'https://youtube.com'})**\n` +
            `👤 **${info.author ?? 'Unknown'}**`
          )
        )
        .setThumbnailAccessory(
          new ThumbnailBuilder().setURL(thumb).setDescription(info.title ?? 'Thumbnail')
        )
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `⏱️ **Duration:** ${formatTime(info.length)} • ` +
        `${loopEmoji} **Loop:** ${player.loop ?? 'none'} • ` +
        `🔊 **Volume:** ${player.volume ?? 100}%\n` +
        `🙋 **Requested By:** <@${info.requester}>`
      )
    )
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(isPaused ? 'resume' : 'pause')
          .setEmoji(isPaused ? '▶️' : '⏸️')
          .setStyle(isPaused ? ButtonStyle.Success : ButtonStyle.Primary)
          .setDisabled(disabled),
        new ButtonBuilder()
          .setCustomId('skip')
          .setEmoji('⏭️')
          .setStyle(ButtonStyle.Primary)
          .setDisabled(disabled),
        new ButtonBuilder()
          .setCustomId('voteskip')
          .setLabel(`Vote Skip${votes > 0 ? ` (${votes})` : ''}`)
          .setEmoji('🗳️')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(disabled),
        new ButtonBuilder()
          .setCustomId('stop')
          .setEmoji('⏹️')
          .setStyle(ButtonStyle.Danger)
          .setDisabled(disabled),
        new ButtonBuilder()
          .setCustomId('shuffle')
          .setEmoji('🔀')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(disabled)
      )
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('loop')
          .setEmoji('🔁')
          .setStyle(
            player.loop && player.loop !== 'none' ? ButtonStyle.Success : ButtonStyle.Secondary
          )
          .setDisabled(disabled),
        new ButtonBuilder()
          .setCustomId('autoplay')
          .setLabel('Autoplay')
          .setEmoji(autoplayEnabled.has(player.guildId) ? '✅' : '❌')
          .setStyle(autoplayEnabled.has(player.guildId) ? ButtonStyle.Success : ButtonStyle.Secondary)
          .setDisabled(disabled),
        new ButtonBuilder()
          .setCustomId('lyrics')
          .setEmoji('📝')
          .setLabel('Lyrics')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(disabled),
        new ButtonBuilder()
          .setCustomId('queue')
          .setEmoji('📋')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(disabled),
        new ButtonBuilder()
          .setCustomId('history')
          .setEmoji('🕒')
          .setLabel('History')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(disabled)
      )
    );
}

function createSimpleContainer(title, description, emoji = 'ℹ️') {
  return new ContainerBuilder()
    .addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(`## ${emoji} ${title}\n${description}`)
        )
        .setThumbnailAccessory(
          new ThumbnailBuilder()
            .setURL(client.user.displayAvatarURL({ size: 1024 }))
            .setDescription(title)
        )
    )
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));
}

function createQueueContainer(player) {
  const queue = player.queue ?? [];
  const current = player.current;
  let desc = '';

  if (current?.info) {
    desc +=
      `**Now Playing:**\n` +
      `**[${current.info.title}](${current.info.uri})**\n` +
      `${current.info.author ?? 'Unknown'} • ${formatTime(current.info.length)} • <@${current.info.requester}>\n\n`;
  }

  if (queue.length > 0) {
    desc += `**Up Next:**\n`;
    queue.slice(0, 10).forEach((t, i) => {
      const inf = t.info ?? {};
      desc += `\`${i + 1}.\` **[${inf.title}](${inf.uri})**\n${inf.author ?? 'Unknown'} • ${formatTime(inf.length)} • <@${inf.requester}>\n`;
    });
    if (queue.length > 10) desc += `\n*...and ${queue.length - 10} more track(s)*`;
  } else if (!current) {
    desc = 'The queue is currently empty.';
  }

  desc +=
    `\n\n**Loop:** ${(!player.loop || player.loop === 'none') ? 'off' : player.loop}` +
    ` | **Autoplay:** ${autoplayEnabled.has(player.guildId) ? '✅ On' : '❌ Off'}` +
    ` | **Volume:** ${player.volume ?? 100}%` +
    ` | **Total:** ${queue.length + (current ? 1 : 0)} tracks`;

  return new ContainerBuilder()
    .addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(`## 📋 Queue\n${desc}`)
        )
        .setThumbnailAccessory(
          new ThumbnailBuilder().setURL(client.user.displayAvatarURL({ size: 1024 })).setDescription('Queue')
        )
    )
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));
}

function createHistoryContainer(guildId) {
  const hist = songHistory.get(guildId) ?? [];
  let desc = '';
  if (hist.length === 0) {
    desc = 'No songs played yet in this session.';
  } else {
    hist.slice(0, 15).forEach((t, i) => {
      const inf = t.info ?? {};
      desc += `\`${i + 1}.\` **[${inf.title}](${inf.uri})**\n${inf.author ?? 'Unknown'} • ${formatTime(inf.length)} • <@${inf.requester}>\n`;
    });
  }
  return new ContainerBuilder()
    .addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(`## 🕒 Song History\n${desc}`)
        )
        .setThumbnailAccessory(
          new ThumbnailBuilder().setURL(client.user.displayAvatarURL({ size: 1024 })).setDescription('History')
        )
    )
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));
}

function createStatsContainer() {
  const mem = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2);
  const totalUsers = client.guilds.cache.reduce((a, g) => a + g.memberCount, 0);
  return new ContainerBuilder()
    .addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `## ℹ️ Bot Statistics\n` +
            `**Servers:** ${client.guilds.cache.size}\n` +
            `**Users:** ${totalUsers}\n` +
            `**Active Players:** ${riffy.players?.size ?? 0}\n` +
            `**Uptime:** ${formatTime(client.uptime)}\n` +
            `**Ping:** ${client.ws.ping}ms\n` +
            `**Memory:** ${mem} MB\n` +
            `**Lavalink:** ${isLavalinkConnected ? '🟢 Connected' : '🔴 Disconnected'}`
          )
        )
        .setThumbnailAccessory(
          new ThumbnailBuilder().setURL(client.user.displayAvatarURL({ size: 1024 })).setDescription('Stats')
        )
    )
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));
}

function createHelpContainer() {
  const lavalinkStatus = isLavalinkConnected ? '🟢 Connected' : '🔴 Disconnected';
  return new ContainerBuilder()
    .addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `## ${client.user.username} — Help Menu\n` +
            `A powerful music bot with high quality audio\n` +
            `**Lavalink:** ${lavalinkStatus} | Made by **Susmita OP**\n\n` +
            `**🎵 Music Commands**\n` +
            `\`/play\` — Play a song or playlist\n` +
            `\`/pause\` — Pause current song\n` +
            `\`/resume\` — Resume playback\n` +
            `\`/skip\` — Skip current song (DJ only if set)\n` +
            `\`/voteskip\` — Vote to skip (50% required)\n` +
            `\`/stop\` — Stop player & clear queue\n` +
            `\`/nowplaying\` — Show current song\n` +
            `\`/queue\` — Show queue\n` +
            `\`/loop\` — Set loop mode (off/track/queue)\n` +
            `\`/shuffle\` — Shuffle the queue\n` +
            `\`/volume\` — Set volume (1–150)\n` +
            `\`/clearqueue\` — Clear the queue\n` +
            `\`/remove\` — Remove a song from queue\n` +
            `\`/move\` — Move a song in queue\n` +
            `\`/247\` — Toggle 24/7 mode\n` +
            `\`/autoplay\` — Toggle autoplay\n` +
            `\`/lyrics\` — Get lyrics for current or any song\n` +
            `\`/history\` — Show song history\n\n` +
            `**🛡️ DJ / Admin Commands**\n` +
            `\`/djrole\` — Set/remove DJ role\n\n` +
            `**ℹ️ Utility Commands**\n` +
            `\`/stats\` — Bot stats\n` +
            `\`/ping\` — Bot latency\n` +
            `\`/invite\` — Bot invite link\n` +
            `\`/support\` — Support server\n` +
            `\`/help\` — This menu\n\n` +
            `💡 **Tip:** Supports YouTube, Spotify playlists & albums!`
          )
        )
        .setThumbnailAccessory(
          new ThumbnailBuilder().setURL(client.user.displayAvatarURL({ size: 1024 })).setDescription('Help')
        )
    )
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setLabel('Invite Me')
          .setStyle(ButtonStyle.Link)
          .setURL(`https://discord.com/api/oauth2/authorize?client_id=${client.user.id}&permissions=3165184&scope=bot%20applications.commands`),
        new ButtonBuilder()
          .setLabel('Support')
          .setStyle(ButtonStyle.Link)
          .setURL(config.supportServer)
      )
    );
}

// ══════════════════════════════════════════════════════════════════
//  CORE PLAY HANDLER
// ══════════════════════════════════════════════════════════════════

async function handlePlay(guildId, voiceChannelId, textChannelId, query, requesterId, reply, editReply) {
  if (!isLavalinkConnected) {
    return reply(`❌ Lavalink is not connected. Music commands are unavailable.`);
  }

  // ── Spotify ─────────────────────────────────────────────────────
  if (spotifyModule.isSpotifyUrl(query)) {
    const spotifyReplyFn = async (data) => {
      const embedData = data?.embeds?.[0];
      const title = embedData?.data?.title ?? embedData?.title ?? 'Spotify';
      const description = embedData?.data?.description ?? embedData?.description ?? '';
      return editReply({
        components: [createSimpleContainer(title, description, '🎵')],
        flags: MessageFlags.IsPersistent | MessageFlags.IsComponentsV2
      });
    };
    const spotifyPlayer = makeSpotifyAdapter(guildId, voiceChannelId, textChannelId, requesterId);
    await spotifyModule.handleSpotify(query, guildId, textChannelId, requesterId, spotifyReplyFn, spotifyPlayer);
    return;
  }

  // ── Get or create player ─────────────────────────────────────────
  let player = riffy.players.get(guildId);
  if (!player) {
    player = riffy.createConnection({
      guildId,
      voiceChannel: voiceChannelId,
      textChannel: textChannelId,
      deaf: true
    });
  }

  const resolve = await resolveWithFallback(query, requesterId);
  if (!resolve?.tracks?.length) {
    return editReply(`❌ No results found for **${query}**. Try a different search or paste a direct URL.`);
  }

  if (resolve.loadType === 'playlist') {
    for (const track of resolve.tracks) {
      track.info.requester = requesterId;
      player.queue.add(track);
    }
    await editReply({
      components: [createSimpleContainer('Playlist Added', `Added **${resolve.playlistInfo.name}** — ${resolve.tracks.length} tracks`, '✅')],
      flags: MessageFlags.IsPersistent | MessageFlags.IsComponentsV2
    });
  } else {
    const track = resolve.tracks[0];
    track.info.requester = requesterId;
    player.queue.add(track);
    await editReply({
      components: [createSimpleContainer('Added to Queue', `[${track.info.title}](${track.info.uri})`, '✅')],
      flags: MessageFlags.IsPersistent | MessageFlags.IsComponentsV2
    });
  }

  if (!player.playing && !player.paused) player.play();
}

// ══════════════════════════════════════════════════════════════════
//  LYRICS HANDLER (shared between slash + button)
// ══════════════════════════════════════════════════════════════════

async function handleLyrics(guildId, query, replyFn) {
  if (!geniusClient) {
    return replyFn({ content: '❌ Lyrics feature unavailable. Ask host to run `npm install genius-lyrics`.', ephemeral: true });
  }

  let searchQuery = query;
  if (!searchQuery) {
    const player = riffy.players.get(guildId);
    if (!player?.current) {
      return replyFn({ content: '❌ No song is playing and no query provided.', ephemeral: true });
    }
    const info = player.current.info;
    // Strip bracketed junk like [Official Video], (Lyrics), etc.
    searchQuery = `${info.title} ${info.author}`
      .replace(/\[.*?\]|\(.*?\)/g, '')
      .trim();
  }

  try {
    const searches = await geniusClient.songs.search(searchQuery);
    if (!searches?.length) {
      return replyFn({ content: `❌ No lyrics found for **${searchQuery}**.`, ephemeral: true });
    }
    const song = searches[0];
    const lyrics = await song.lyrics();

    if (!lyrics) {
      return replyFn({ content: `❌ Lyrics unavailable for **${song.title}**.`, ephemeral: true });
    }

    // Chunk into ≤4000 chars to avoid Discord embed limits
    const chunks = [];
    let current = '';
    for (const line of lyrics.split('\n')) {
      if ((current + '\n' + line).length > 3800) {
        chunks.push(current);
        current = line;
      } else {
        current += (current ? '\n' : '') + line;
      }
    }
    if (current) chunks.push(current);

    const container = new ContainerBuilder()
      .addSectionComponents(
        new SectionBuilder()
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              `## 📝 ${song.title}\n**By:** ${song.artist?.name ?? 'Unknown'}\n\n${chunks[0]}`
            )
          )
          .setThumbnailAccessory(
            new ThumbnailBuilder()
              .setURL(song.image ?? client.user.displayAvatarURL({ size: 1024 }))
              .setDescription('Album Art')
          )
      )
      .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));

    await replyFn({
      components: [container],
      flags: MessageFlags.IsComponentsV2 | MessageFlags.IsPersistent,
      ephemeral: true
    });

    // If lyrics overflow, send remaining chunks as follow-ups (ephemeral can't follow up, skip)
  } catch (err) {
    console.error('Lyrics error:', err);
    return replyFn({ content: `❌ Failed to fetch lyrics: ${err.message}`, ephemeral: true });
  }
}

// ══════════════════════════════════════════════════════════════════
//  VOTE SKIP LOGIC
// ══════════════════════════════════════════════════════════════════

/**
 * Returns { skip: true } if threshold met, else { skip: false, current, required }
 */
function processVoteSkip(player, userId) {
  const guildId = player.guildId;
  if (!voteSkips.has(guildId)) voteSkips.set(guildId, new Set());
  const votes = voteSkips.get(guildId);
  votes.add(userId);

  // Count real members in voice (excluding bots)
  const voiceChannel = client.channels.cache.get(player.voiceChannel);
  const memberCount = voiceChannel
    ? [...voiceChannel.members.values()].filter(m => !m.user.bot).length
    : 2;

  const required = Math.ceil(memberCount * 0.5);
  if (votes.size >= required) {
    voteSkips.delete(guildId);
    return { skip: true };
  }
  return { skip: false, current: votes.size, required };
}

// ══════════════════════════════════════════════════════════════════
//  RIFFY EVENTS
// ══════════════════════════════════════════════════════════════════

riffy.on('nodeConnect', (node) => {
  console.log(`✅ Node "${node.name}" connected`);
  isLavalinkConnected = true;
});

riffy.on('nodeError', (node, error) => {
  console.error(`❌ Node "${node.name}" error:`, error);
  isLavalinkConnected = false;
});

riffy.on('nodeDisconnect', (node) => {
  console.log(`❌ Node "${node.name}" disconnected`);
  isLavalinkConnected = false;
});

riffy.on('trackStart', async (player, track) => {
  // Save to history
  pushHistory(player.guildId, track);
  // Reset vote skips for new song
  voteSkips.delete(player.guildId);

  const channel = client.channels.cache.get(player.textChannel);
  if (!channel) return;

  // Delete old NP message
  const oldMsg = nowPlayingMsgs.get(player.guildId);
  if (oldMsg) {
    try { await oldMsg.delete(); } catch (_) {}
    nowPlayingMsgs.delete(player.guildId);
  }

  try {
    const container = createNowPlayingContainer(player, track);
    const msg = await channel.send({
      components: [container],
      flags: MessageFlags.IsPersistent | MessageFlags.IsComponentsV2
    });
    nowPlayingMsgs.set(player.guildId, msg);
  } catch (err) {
    console.error('trackStart send error:', err);
  }
});

riffy.on('queueEnd', async (player) => {
  const channel = client.channels.cache.get(player.textChannel);
  const lastTrack = player.current;

  // Disable buttons on NP message
  const msg = nowPlayingMsgs.get(player.guildId);
  if (msg && lastTrack) {
    try {
      await msg.edit({
        components: [createNowPlayingContainer(player, lastTrack, true)],
        flags: MessageFlags.IsPersistent | MessageFlags.IsComponentsV2
      });
    } catch (_) {}
  }
  nowPlayingMsgs.delete(player.guildId);

  // ── Autoplay ─────────────────────────────────────────────────────
  if (autoplayEnabled.has(player.guildId) && lastTrack) {
    try {
      const title  = lastTrack.info.title ?? '';
      const author = lastTrack.info.author ?? '';
      const terms  = [
        `${title} similar hindi songs`,
        `${author} hindi sad songs`,
        `${title} bollywood playlist`,
        `${author} bollywood hits`,
        `${title} slowed reverb`,
        `${author} romantic hindi songs`
      ];
      const raw    = terms[Math.floor(Math.random() * terms.length)];
      const result = await riffy.resolve({ query: `ytmsearch:${raw}`, requester: lastTrack.info.requester });

      if (result?.tracks?.length) {
        const pool = result.tracks.filter(t => t.info.uri !== lastTrack.info.uri);
        const next = (pool.length ? pool : result.tracks)[Math.floor(Math.random() * (pool.length || result.tracks.length))];
        next.info.requester = lastTrack.info.requester;
        player.queue.add(next);
        player.play();
        if (channel) {
          await channel.send({
            components: [createSimpleContainer('Autoplay', `Added **[${next.info.title}](${next.info.uri})**`, '🔁')],
            flags: MessageFlags.IsPersistent | MessageFlags.IsComponentsV2
          });
        }
        return;
      }
    } catch (err) { console.error('Autoplay error:', err); }
  }

  // ── 24/7 ─────────────────────────────────────────────────────────
  if (queue247.has(player.guildId)) {
    if (channel) {
      await channel.send({
        components: [createSimpleContainer('24/7 Mode', 'Queue ended — staying connected', 'ℹ️')],
        flags: MessageFlags.IsPersistent | MessageFlags.IsComponentsV2
      });
    }
    return;
  }

  if (channel) {
    await channel.send({
      components: [createSimpleContainer('Queue Ended', 'All songs played — leaving voice channel', '✅')],
      flags: MessageFlags.IsPersistent | MessageFlags.IsComponentsV2
    });
  }
  player.destroy();
});

// ══════════════════════════════════════════════════════════════════
//  CLIENT EVENTS
// ══════════════════════════════════════════════════════════════════

client.on('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  try { riffy.init(client.user.id); }
  catch (e) { console.error('Riffy init error:', e); }

  const types = {
    PLAYING: ActivityType.Playing, LISTENING: ActivityType.Listening,
    WATCHING: ActivityType.Watching, STREAMING: ActivityType.Streaming,
    COMPETING: ActivityType.Competing
  };
  client.user.setActivity(config.activity.name, { type: types[config.activity.type] ?? ActivityType.Listening });

  // ── Register slash commands ─────────────────────────────────────
  const commands = [
    {
      name: 'play',
      description: 'Play a song or playlist (YouTube, Spotify)',
      options: [{ name: 'query', description: 'Song name, URL, or Spotify link', type: 3, required: true }]
    },
    { name: 'pause',      description: 'Pause the current song' },
    { name: 'resume',     description: 'Resume paused playback' },
    { name: 'skip',       description: 'Skip the current song (DJ only if set)' },
    { name: 'voteskip',   description: 'Vote to skip the current song (50% of VC required)' },
    { name: 'stop',       description: 'Stop player and clear queue' },
    {
      name: 'volume',
      description: 'Set volume (1–150)',
      options: [{ name: 'level', description: 'Volume level', type: 4, required: true, min_value: 1, max_value: 150 }]
    },
    { name: 'queue',      description: 'Show the current queue' },
    { name: 'nowplaying', description: 'Show the currently playing song' },
    { name: 'shuffle',    description: 'Shuffle the queue' },
    {
      name: 'loop',
      description: 'Set loop mode',
      options: [{
        name: 'mode', description: 'Loop mode', type: 3, required: true,
        choices: [{ name: 'Off', value: 'none' }, { name: 'Track', value: 'track' }, { name: 'Queue', value: 'queue' }]
      }]
    },
    {
      name: 'remove',
      description: 'Remove a song from the queue',
      options: [{ name: 'position', description: 'Queue position', type: 4, required: true, min_value: 1 }]
    },
    {
      name: 'move',
      description: 'Move a song in the queue',
      options: [
        { name: 'from', description: 'From position', type: 4, required: true, min_value: 1 },
        { name: 'to',   description: 'To position',   type: 4, required: true, min_value: 1 }
      ]
    },
    { name: 'clearqueue', description: 'Clear the entire queue' },
    { name: '247',        description: 'Toggle 24/7 mode (stay in VC)' },
    { name: 'autoplay',   description: 'Toggle autoplay (auto-queue similar songs)' },
    {
      name: 'lyrics',
      description: 'Get lyrics for the current song or a search query',
      options: [{ name: 'query', description: 'Song name (leave empty for current song)', type: 3, required: false }]
    },
    { name: 'history',    description: 'Show recently played songs' },
    {
      name: 'djrole',
      description: 'Set or remove the DJ role (Admin only)',
      options: [{ name: 'role', description: 'DJ role (leave empty to remove)', type: 8, required: false }]
    },
    { name: 'stats',   description: 'Show bot statistics' },
    { name: 'ping',    description: 'Show bot latency' },
    { name: 'invite',  description: 'Get bot invite link' },
    { name: 'support', description: 'Get support server link' },
    { name: 'help',    description: 'Show all commands' }
  ];

  await client.application.commands.set(commands);
  console.log(`✅ ${commands.length} slash commands registered globally`);
});

client.on('raw', (d) => {
  try { riffy.updateVoiceState(d); }
  catch (err) { console.error('raw event error:', err.message); }
});

// ══════════════════════════════════════════════════════════════════
//  INTERACTIONS — BUTTONS + SLASH COMMANDS
// ══════════════════════════════════════════════════════════════════

client.on('interactionCreate', async (interaction) => {

  // ════════════════════════════════════════════════════════════════
  //  BUTTON INTERACTIONS
  // ════════════════════════════════════════════════════════════════
  if (interaction.isButton()) {
    const player = riffy.players.get(interaction.guildId);

    if (!player) {
      return interaction.reply({ content: '❌ No active player found', ephemeral: true }).catch(() => {});
    }

    const member = interaction.member;
    if (!member.voice.channel) {
      return interaction.reply({ content: '❌ You need to be in a voice channel', ephemeral: true }).catch(() => {});
    }
    if (member.voice.channel.id !== player.voiceChannel) {
      return interaction.reply({ content: '❌ Join the same voice channel as the bot', ephemeral: true }).catch(() => {});
    }

    // DJ check for destructive buttons (skip, stop, shuffle, loop)
    const djRequired = ['skip', 'stop', 'shuffle', 'loop'];
    if (djRequired.includes(interaction.customId) && !hasDJPermission(member, interaction.guildId)) {
      return interaction.reply({ content: `❌ You need the DJ role to use this button.`, ephemeral: true }).catch(() => {});
    }

    try {
      switch (interaction.customId) {

        // ── Pause / Resume ────────────────────────────────────────
        case 'pause':
        case 'resume': {
          const shouldPause = interaction.customId === 'pause';
          await player.pause(shouldPause);
          const npMsg = nowPlayingMsgs.get(player.guildId);
          if (npMsg && player.current) {
            await npMsg.edit({
              components: [createNowPlayingContainer(player, player.current)],
              flags: MessageFlags.IsPersistent | MessageFlags.IsComponentsV2
            }).catch(() => {});
          }
          await interaction.reply({ content: shouldPause ? '⏸️ Paused' : '▶️ Resumed', ephemeral: true });
          break;
        }

        // ── Skip ─────────────────────────────────────────────────
        case 'skip': {
          if (player.current) {
            await interaction.message.edit({
              components: [createNowPlayingContainer(player, player.current, true)],
              flags: MessageFlags.IsPersistent | MessageFlags.IsComponentsV2
            }).catch(() => {});
          }
          player.stop();
          await interaction.reply({ content: '⏭️ Skipped', ephemeral: true });
          break;
        }

        // ── Vote Skip ─────────────────────────────────────────────
        case 'voteskip': {
          if (!player.current) {
            return interaction.reply({ content: '❌ Nothing is playing', ephemeral: true });
          }
          const result = processVoteSkip(player, member.user.id);
          if (result.skip) {
            if (player.current) {
              await interaction.message.edit({
                components: [createNowPlayingContainer(player, player.current, true)],
                flags: MessageFlags.IsPersistent | MessageFlags.IsComponentsV2
              }).catch(() => {});
            }
            player.stop();
            await interaction.reply({ content: '🗳️ Vote skip passed! Skipping...', ephemeral: false });
          } else {
            // Refresh NP message to show updated vote count
            const npMsg = nowPlayingMsgs.get(player.guildId);
            if (npMsg && player.current) {
              await npMsg.edit({
                components: [createNowPlayingContainer(player, player.current)],
                flags: MessageFlags.IsPersistent | MessageFlags.IsComponentsV2
              }).catch(() => {});
            }
            await interaction.reply({
              content: `🗳️ Vote recorded! **${result.current}/${result.required}** votes to skip.`,
              ephemeral: true
            });
          }
          break;
        }

        // ── Stop ─────────────────────────────────────────────────
        case 'stop': {
          if (player.current) {
            await interaction.message.edit({
              components: [createNowPlayingContainer(player, player.current, true)],
              flags: MessageFlags.IsPersistent | MessageFlags.IsComponentsV2
            }).catch(() => {});
          }
          nowPlayingMsgs.delete(player.guildId);
          player.destroy();
          await interaction.reply({ content: '⏹️ Stopped and cleared queue', ephemeral: true });
          break;
        }

        // ── Shuffle ───────────────────────────────────────────────
        case 'shuffle': {
          if (!player.queue?.length) {
            return interaction.reply({ content: '❌ Queue is empty', ephemeral: true });
          }
          player.queue.shuffle();
          await interaction.reply({ content: '🔀 Queue shuffled!', ephemeral: true });
          break;
        }

        // ── Loop ──────────────────────────────────────────────────
        case 'loop': {
          const modes = ['none', 'track', 'queue'];
          const next  = modes[(modes.indexOf(player.loop ?? 'none') + 1) % modes.length];
          player.setLoop(next);
          const npMsg = nowPlayingMsgs.get(player.guildId);
          if (npMsg && player.current) {
            await npMsg.edit({
              components: [createNowPlayingContainer(player, player.current)],
              flags: MessageFlags.IsPersistent | MessageFlags.IsComponentsV2
            }).catch(() => {});
          }
          await interaction.reply({ content: `🔁 Loop set to: **${next}**`, ephemeral: true });
          break;
        }

        // ── Autoplay ──────────────────────────────────────────────
        case 'autoplay': {
          if (autoplayEnabled.has(player.guildId)) autoplayEnabled.delete(player.guildId);
          else autoplayEnabled.add(player.guildId);
          const on = autoplayEnabled.has(player.guildId);
          const npMsg = nowPlayingMsgs.get(player.guildId);
          if (npMsg && player.current) {
            await npMsg.edit({
              components: [createNowPlayingContainer(player, player.current)],
              flags: MessageFlags.IsPersistent | MessageFlags.IsComponentsV2
            }).catch(() => {});
          }
          await interaction.reply({ content: on ? '✅ Autoplay Enabled' : '❌ Autoplay Disabled', ephemeral: true });
          break;
        }

        // ── Lyrics ────────────────────────────────────────────────
        case 'lyrics': {
          await interaction.deferReply({ ephemeral: true });
          await handleLyrics(
            interaction.guildId,
            null,
            (data) => interaction.editReply(data)
          );
          break;
        }

        // ── Queue ────────────────────────────────────────────────
        case 'queue': {
          await interaction.reply({
            components: [createQueueContainer(player)],
            flags: MessageFlags.IsComponentsV2 | MessageFlags.IsPersistent,
            ephemeral: true
          });
          break;
        }

        // ── History ───────────────────────────────────────────────
        case 'history': {
          await interaction.reply({
            components: [createHistoryContainer(interaction.guildId)],
            flags: MessageFlags.IsComponentsV2 | MessageFlags.IsPersistent,
            ephemeral: true
          });
          break;
        }
      }
    } catch (err) {
      console.error('Button error:', err);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: '❌ Something went wrong', ephemeral: true }).catch(() => {});
      }
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  const { commandName, options, member, guild, channel } = interaction;

  // ── Helper: get player with VC check ─────────────────────────────
  const getPlayerAndCheck = (requireVC = true) => {
    const player = riffy.players.get(guild.id);
    if (!player) {
      interaction.reply({ content: '❌ No active player found', ephemeral: true });
      return null;
    }
    if (requireVC) {
      if (!member.voice.channel) {
        interaction.reply({ content: '❌ You need to be in a voice channel', ephemeral: true });
        return null;
      }
      if (member.voice.channel.id !== player.voiceChannel) {
        interaction.reply({ content: '❌ Join the same voice channel as the bot', ephemeral: true });
        return null;
      }
    }
    return player;
  };

  // ── DJ check for slash commands ────────────────────────────────
  const djCommands = ['skip', 'stop', 'shuffle', 'loop', 'volume', 'remove', 'move', 'clearqueue'];
  if (djCommands.includes(commandName) && !hasDJPermission(member, guild.id)) {
    return interaction.reply({ content: `❌ You need the **DJ role** to use \`/${commandName}\`.`, ephemeral: true });
  }

  try {
    // ════════════════════════════════════════════════════════════
    //  SLASH COMMAND HANDLERS
    // ════════════════════════════════════════════════════════════

    if (commandName === 'play') {
      if (!member.voice.channel) {
        return interaction.reply({ content: '❌ You need to be in a voice channel', ephemeral: true });
      }
      await interaction.deferReply();
      await handlePlay(
        guild.id,
        member.voice.channel.id,
        channel.id,
        options.getString('query'),
        member.user.id,
        (msg) => interaction.reply(typeof msg === 'string' ? { content: msg, ephemeral: true } : msg),
        (data) => interaction.editReply(data)
      );
    }

    else if (commandName === 'pause') {
      const player = getPlayerAndCheck();
      if (!player) return;
      player.pause(true);
      await interaction.reply({ components: [createSimpleContainer('Paused', 'Playback paused', '⏸️')], flags: MessageFlags.IsComponentsV2 });
    }

    else if (commandName === 'resume') {
      const player = getPlayerAndCheck();
      if (!player) return;
      player.pause(false);
      await interaction.reply({ components: [createSimpleContainer('Resumed', 'Playback resumed', '▶️')], flags: MessageFlags.IsComponentsV2 });
    }

    else if (commandName === 'skip') {
      const player = getPlayerAndCheck();
      if (!player) return;
      player.stop();
      await interaction.reply({ components: [createSimpleContainer('Skipped', 'Skipped to next track', '⏭️')], flags: MessageFlags.IsComponentsV2 });
    }

    else if (commandName === 'voteskip') {
      const player = getPlayerAndCheck();
      if (!player) return;
      if (!player.current) {
        return interaction.reply({ content: '❌ Nothing is playing', ephemeral: true });
      }
      const result = processVoteSkip(player, member.user.id);
      if (result.skip) {
        player.stop();
        await interaction.reply({ components: [createSimpleContainer('Vote Skip Passed', 'Enough votes! Skipping...', '🗳️')], flags: MessageFlags.IsComponentsV2 });
      } else {
        await interaction.reply({
          components: [createSimpleContainer('Vote Recorded', `**${result.current}/${result.required}** votes to skip.`, '🗳️')],
          flags: MessageFlags.IsComponentsV2
        });
      }
    }

    else if (commandName === 'stop') {
      const player = getPlayerAndCheck();
      if (!player) return;
      nowPlayingMsgs.delete(guild.id);
      player.destroy();
      await interaction.reply({ components: [createSimpleContainer('Stopped', 'Stopped and cleared queue', '⏹️')], flags: MessageFlags.IsComponentsV2 });
    }

    else if (commandName === 'volume') {
      const player = getPlayerAndCheck();
      if (!player) return;
      const volume = options.getInteger('level');
      player.setVolume(volume);
      await interaction.reply({ components: [createSimpleContainer('Volume', `Set to **${volume}%**`, '🔊')], flags: MessageFlags.IsComponentsV2 });
    }

    else if (commandName === 'queue') {
      const player = riffy.players.get(guild.id);
      if (!player) return interaction.reply({ content: '❌ No active player', ephemeral: true });
      if (!player.queue.length && !player.current) {
        return interaction.reply({ content: '❌ Queue is empty', ephemeral: true });
      }
      await interaction.reply({ components: [createQueueContainer(player)], flags: MessageFlags.IsComponentsV2 | MessageFlags.IsPersistent });
    }

    else if (commandName === 'nowplaying') {
      const player = riffy.players.get(guild.id);
      if (!player?.current) {
        return interaction.reply({ content: '❌ Nothing is playing', ephemeral: true });
      }
      await interaction.reply({
        components: [createNowPlayingContainer(player, player.current)],
        flags: MessageFlags.IsComponentsV2 | MessageFlags.IsPersistent
      });
    }

    else if (commandName === 'shuffle') {
      const player = getPlayerAndCheck();
      if (!player) return;
      if (!player.queue.length) return interaction.reply({ content: '❌ Queue is empty', ephemeral: true });
      player.queue.shuffle();
      await interaction.reply({ components: [createSimpleContainer('Shuffled', 'Queue shuffled!', '🔀')], flags: MessageFlags.IsComponentsV2 });
    }

    else if (commandName === 'loop') {
      const player = getPlayerAndCheck();
      if (!player) return;
      const mode = options.getString('mode');
      player.setLoop(mode);
      await interaction.reply({ components: [createSimpleContainer('Loop', `Loop set to: **${mode}**`, '🔁')], flags: MessageFlags.IsComponentsV2 });
    }

    else if (commandName === 'remove') {
      const player = getPlayerAndCheck();
      if (!player) return;
      const pos = options.getInteger('position') - 1;
      if (pos < 0 || pos >= player.queue.length) {
        return interaction.reply({ content: '❌ Invalid position', ephemeral: true });
      }
      const removed = player.queue.remove(pos);
      await interaction.reply({ components: [createSimpleContainer('Removed', `Removed: **${removed.info.title}**`, '✅')], flags: MessageFlags.IsComponentsV2 });
    }

    else if (commandName === 'move') {
      const player = getPlayerAndCheck();
      if (!player) return;
      const from = options.getInteger('from') - 1;
      const to   = options.getInteger('to')   - 1;
      if (from < 0 || from >= player.queue.length || to < 0 || to >= player.queue.length) {
        return interaction.reply({ content: '❌ Invalid positions', ephemeral: true });
      }
      const arr = Array.from(player.queue);
      const [track] = arr.splice(from, 1);
      arr.splice(to, 0, track);
      player.queue.clear();
      for (const t of arr) player.queue.add(t);
      await interaction.reply({ components: [createSimpleContainer('Moved', `Moved: **${track.info.title}**`, '✅')], flags: MessageFlags.IsComponentsV2 });
    }

    else if (commandName === 'clearqueue') {
      const player = getPlayerAndCheck();
      if (!player) return;
      player.queue.clear();
      await interaction.reply({ components: [createSimpleContainer('Queue Cleared', 'All upcoming tracks removed', '✅')], flags: MessageFlags.IsComponentsV2 });
    }

    else if (commandName === '247') {
      if (!member.voice.channel) {
        return interaction.reply({ content: '❌ You need to be in a voice channel', ephemeral: true });
      }
      if (queue247.has(guild.id)) {
        queue247.delete(guild.id);
        await interaction.reply({ components: [createSimpleContainer('24/7 Disabled', '24/7 mode disabled', '✅')], flags: MessageFlags.IsComponentsV2 });
      } else {
        queue247.add(guild.id);
        if (!riffy.players.get(guild.id)) {
          riffy.createConnection({ guildId: guild.id, voiceChannel: member.voice.channel.id, textChannel: channel.id, deaf: true });
        }
        await interaction.reply({ components: [createSimpleContainer('24/7 Enabled', 'Bot will stay in VC', '✅')], flags: MessageFlags.IsComponentsV2 });
      }
    }

    else if (commandName === 'autoplay') {
      const player = riffy.players.get(guild.id);
      if (!player) return interaction.reply({ content: '❌ No active player', ephemeral: true });
      if (autoplayEnabled.has(guild.id)) {
        autoplayEnabled.delete(guild.id);
        await interaction.reply({ components: [createSimpleContainer('Autoplay Disabled', 'Auto-queue disabled', '❌')], flags: MessageFlags.IsComponentsV2 });
      } else {
        autoplayEnabled.add(guild.id);
        await interaction.reply({ components: [createSimpleContainer('Autoplay Enabled', 'Auto-queue similar songs enabled', '✅')], flags: MessageFlags.IsComponentsV2 });
      }
    }

    else if (commandName === 'lyrics') {
      await interaction.deferReply({ ephemeral: true });
      const query = options.getString('query') ?? null;
      await handleLyrics(guild.id, query, (data) => interaction.editReply(data));
    }

    else if (commandName === 'history') {
      await interaction.reply({
        components: [createHistoryContainer(guild.id)],
        flags: MessageFlags.IsComponentsV2 | MessageFlags.IsPersistent,
        ephemeral: true
      });
    }

    else if (commandName === 'djrole') {
      if (!member.permissions.has('Administrator')) {
        return interaction.reply({ content: '❌ Only Administrators can set the DJ role.', ephemeral: true });
      }
      const role = options.getRole('role');
      if (role) {
        djRoles.set(guild.id, role.id);
        await interaction.reply({
          components: [createSimpleContainer('DJ Role Set', `<@&${role.id}> can now control music`, '🛡️')],
          flags: MessageFlags.IsComponentsV2
        });
      } else {
        djRoles.delete(guild.id);
        await interaction.reply({
          components: [createSimpleContainer('DJ Role Removed', 'Anyone can now control music', '🛡️')],
          flags: MessageFlags.IsComponentsV2
        });
      }
    }

    else if (commandName === 'stats') {
      await interaction.reply({ components: [createStatsContainer()], flags: MessageFlags.IsComponentsV2 });
    }

    else if (commandName === 'ping') {
      await interaction.reply({
        components: [createSimpleContainer('Pong!', `WebSocket Latency: **${client.ws.ping}ms**`, 'ℹ️')],
        flags: MessageFlags.IsComponentsV2
      });
    }

    else if (commandName === 'invite') {
      const url = `https://discord.com/api/oauth2/authorize?client_id=${client.user.id}&permissions=3165184&scope=bot%20applications.commands`;
      await interaction.reply({
        components: [
          new ContainerBuilder()
            .addSectionComponents(
              new SectionBuilder()
                .addTextDisplayComponents(
                  new TextDisplayBuilder().setContent(`## ✅ Invite Bot\n[Click here to invite me!](${url})`)
                )
                .setThumbnailAccessory(
                  new ThumbnailBuilder().setURL(client.user.displayAvatarURL({ size: 1024 })).setDescription('Invite')
                )
            )
            .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
            .addActionRowComponents(
              new ActionRowBuilder().addComponents(
                new ButtonBuilder().setLabel('Invite Me').setStyle(ButtonStyle.Link).setURL(url)
              )
            )
        ],
        flags: MessageFlags.IsComponentsV2
      });
    }

    else if (commandName === 'support') {
      await interaction.reply({
        components: [
          new ContainerBuilder()
            .addSectionComponents(
              new SectionBuilder()
                .addTextDisplayComponents(
                  new TextDisplayBuilder().setContent(`## ℹ️ Support Server\n[Join our support server](${config.supportServer})`)
                )
                .setThumbnailAccessory(
                  new ThumbnailBuilder().setURL(client.user.displayAvatarURL({ size: 1024 })).setDescription('Support')
                )
            )
            .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
            .addActionRowComponents(
              new ActionRowBuilder().addComponents(
                new ButtonBuilder().setLabel('Support Server').setStyle(ButtonStyle.Link).setURL(config.supportServer)
              )
            )
        ],
        flags: MessageFlags.IsComponentsV2
      });
    }

    else if (commandName === 'help') {
      await interaction.reply({ components: [createHelpContainer()], flags: MessageFlags.IsComponentsV2 });
    }

  } catch (err) {
    console.error(`Slash error [/${commandName}]:`, err);
    const errPayload = { content: '❌ An error occurred', ephemeral: true };
    if (interaction.deferred)       await interaction.editReply(errPayload).catch(() => {});
    else if (!interaction.replied)  await interaction.reply(errPayload).catch(() => {});
  }
});

// ─── Login ─────────────────────────────────────────────────────────────────────
client.login(config.token);
