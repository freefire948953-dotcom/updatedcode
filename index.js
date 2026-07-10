// ╔══════════════════════════════════════════════════════════════════════╗
// ║              SKY x MUSIC BOT — index.js  v3.1                      ║
// ║  Platforms : YouTube · Spotify · SoundCloud · Apple Music          ║
// ║  Audio     : Hi-Fi Opus · 15+ Filters · 8D · Bass · Nightcore      ║
// ║  Features  : Queue · Loop · Shuffle · 24/7 · Autoplay              ║
// ║              DJ Role · Vote Skip · Lyrics · History · Previous      ║
// ║  UI        : Components V2 — Clean & Modern                         ║
// ╚══════════════════════════════════════════════════════════════════════╝

'use strict';

const {
  Client, GatewayIntentBits, ActivityType,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ContainerBuilder, SectionBuilder, TextDisplayBuilder,
  ThumbnailBuilder, SeparatorBuilder, SeparatorSpacingSize, MessageFlags,
  MediaGalleryBuilder, MediaGalleryItemBuilder
} = require('discord.js');
const { Riffy } = require('riffy');
const config  = require('./config.js');
const express = require('express');
require('dotenv').config();

// ─── Global error safety ──────────────────────────────────────────────────────
process.on('unhandledRejection', (r) => console.error('[UnhandledRejection]', r));
process.on('uncaughtException',  (e) => console.error('[UncaughtException]',  e));

// ─── Spotify ──────────────────────────────────────────────────────────────────
const spotifyModule = require('./spotify');
const SpotifyClient = require('spotify-url-info');
const fetch = (...a) => import('node-fetch').then(({ default: f }) => f(...a));
spotifyModule.init({ spotifyClient: SpotifyClient(fetch) });

// ─── Lyrics ───────────────────────────────────────────────────────────────────
// ─── Lyrics (lyrics.ovh) ──────────────────────────────────────────────────────
async function fetchLyricsOvh(artist, title) {
  const url = `https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`;
  const res = await fetch(url);
  const contentType = res.headers.get('content-type') || '';
  const rawText = await res.text();

  if (!contentType.includes('application/json')) {
    console.error('[LyricsOvh] Non-JSON response:', rawText.slice(0, 200));
    return null;
  }

  let data;
  try { data = JSON.parse(rawText); }
  catch (e) { console.error('[LyricsOvh] Parse failed:', e.message); return null; }

  return data?.lyrics || null;
}

// ─── Discord Client ───────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
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
    } catch (e) { console.error('[Riffy Send]', e.message); }
  },
  defaultSearchPlatform: 'ytmsearch',
  restVersion: 'v4'
});

// ─── Express Keep-Alive ───────────────────────────────────────────────────────
function startExpressServer() {
  if (!config.express?.enabled) return;
  const app = express();
  app.get('/', (_req, res) => res.json({
    status: 'online', bot: client.user?.tag ?? 'Starting...',
    servers: client.guilds.cache.size, uptime: process.uptime(),
    lavalink: isLavalinkConnected ? 'connected' : 'disconnected'
  }));
  app.get('/stats', (_req, res) => res.json({
    guilds: client.guilds.cache.size,
    users: client.guilds.cache.reduce((a, g) => a + g.memberCount, 0),
    players: riffy.players?.size ?? 0, uptime: process.uptime(),
    memory: (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2),
    ping: client.ws?.ping ?? 0, lavalink: isLavalinkConnected
  }));
  app.listen(config.express.port, '0.0.0.0', () =>
    console.log(`🌐 Express on port ${config.express.port}`)
  );
}
startExpressServer();

// ─── State ────────────────────────────────────────────────────────────────────
const queue247        = new Set();
const autoplayEnabled = new Set();
const djRoles         = new Map();
const nowPlayingMsgs  = new Map();
const songHistory     = new Map();
const voteSkips       = new Map();
const activeFilters   = new Map();
const autoReconnect   = new Map();

// ─── Audio Filters ────────────────────────────────────────────────────────────
const FILTERS = {
  bassboost: {
    equalizer: [
      { band: 0, gain: 0.6 }, { band: 1, gain: 0.7 },
      { band: 2, gain: 0.5 }, { band: 3, gain: 0.25 },
      { band: 4, gain: 0.0 }, { band: 5, gain: -0.25 },
      { band: 6, gain: -0.45 }, { band: 7, gain: -0.55 },
      { band: 8, gain: -0.6 }, { band: 9, gain: -0.65 },
      { band: 10, gain: -0.6 }, { band: 11, gain: -0.55 },
      { band: 12, gain: 0.0 }, { band: 13, gain: 0.45 }, { band: 14, gain: 0.55 }
    ]
  },
  nightcore: { timescale: { speed: 1.3, pitch: 1.3, rate: 1.0 } },
  vaporwave: {
    timescale: { speed: 0.8, pitch: 0.8, rate: 1.0 },
    equalizer: [{ band: 0, gain: 0.3 }, { band: 1, gain: 0.3 }]
  },
  '8d':          { rotation: { rotationHz: 0.2 } },
  slowedreverb:  { timescale: { speed: 0.8, pitch: 0.9, rate: 1.0 } },
  treble:        { equalizer: [{ band: 12, gain: 0.6 }, { band: 13, gain: 0.65 }, { band: 14, gain: 0.7 }] },
  pop:           { equalizer: [{ band: 2, gain: 0.05 }, { band: 3, gain: 0.1 }, { band: 4, gain: 0.1 }, { band: 5, gain: 0.1 }, { band: 6, gain: 0.05 }] },
  soft:          { lowPass: { smoothing: 20.0 } },
  loud:          { equalizer: Array.from({ length: 15 }, (_, i) => ({ band: i, gain: 0.5 })) },
  earrape:       { equalizer: Array.from({ length: 15 }, (_, i) => ({ band: i, gain: 1.0 })), timescale: { speed: 1.0, pitch: 1.2, rate: 1.0 } },
  karaoke:       { karaoke: { level: 1.0, monoLevel: 1.0, filterBand: 220.0, filterWidth: 100.0 } },
  distortion:    { distortion: { sinOffset: 0, sinScale: 1, cosOffset: 0, cosScale: 1, tanOffset: 0, tanScale: 1, offset: 0, scale: 1.0 } },
  china:         { timescale: { speed: 0.75, pitch: 1.25, rate: 1.25 } },
  chipmunk:      { timescale: { speed: 1.05, pitch: 1.35, rate: 1.25 } },
  vibrato:       { vibrato: { frequency: 4.0, depth: 0.75 } },
  tremolo:       { tremolo: { frequency: 2.0, depth: 0.5 } }
};

const FILTER_NAMES = Object.keys(FILTERS);

async function applyFilter(player, filterName) {
  const filter = FILTERS[filterName];
  if (!filter) return false;
  try {
    if (filter.equalizer   && typeof player.setEqualizer  === 'function') player.setEqualizer(filter.equalizer);
    if (filter.timescale   && typeof player.setTimescale  === 'function') player.setTimescale(filter.timescale);
    if (filter.rotation    && typeof player.setRotation   === 'function') player.setRotation(filter.rotation);
    if (filter.vibrato     && typeof player.setVibrato    === 'function') player.setVibrato(filter.vibrato);
    if (filter.tremolo     && typeof player.setTremolo    === 'function') player.setTremolo(filter.tremolo);
    if (filter.karaoke     && typeof player.setKaraoke    === 'function') player.setKaraoke(filter.karaoke);
    if (filter.lowPass     && typeof player.setLowPass    === 'function') player.setLowPass(filter.lowPass);
    if (filter.distortion  && typeof player.setDistortion === 'function') player.setDistortion(filter.distortion);
    if (typeof player.setFilters === 'function') { player.setFilters(filter); return true; }
    if (player.node?.rest?.updatePlayer) {
      await player.node.rest.updatePlayer({ guildId: player.guildId, data: { filters: filter } });
      return true;
    }
    return false;
  } catch (e) { console.error(`[Filter:${filterName}]`, e.message); return false; }
}

async function clearFilters(player) {
  try {
    if (typeof player.clearFilters === 'function') player.clearFilters();
    else if (typeof player.setFilters === 'function') player.setFilters({});
    else if (player.node?.rest?.updatePlayer) await player.node.rest.updatePlayer({ guildId: player.guildId, data: { filters: {} } });
    activeFilters.delete(player.guildId);
  } catch (e) { console.error('[ClearFilters]', e.message); }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
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
  if (uri.includes('youtube.com'))   vid = uri.split('v=')[1]?.split('&')[0];
  else if (uri.includes('youtu.be')) vid = uri.split('youtu.be/')[1]?.split('?')[0];
  return vid ? `https://img.youtube.com/vi/${vid}/maxresdefault.jpg` : 'https://i.imgur.com/QYJfXQv.png';
}

function detectSource(info) {
  const uri = (info?.uri || '').toLowerCase();
  if (uri.includes('spotify.com'))     return { name: 'Spotify',     emoji: '🟢' };
  if (uri.includes('soundcloud.com'))  return { name: 'SoundCloud',  emoji: '🟠' };
  if (uri.includes('music.apple.com')) return { name: 'Apple Music', emoji: '🍎' };
  if (uri.includes('youtube.com') || uri.includes('youtu.be')) return { name: 'YouTube', emoji: '🔴' };
  if (uri.includes('deezer.com'))      return { name: 'Deezer',      emoji: '💜' };
  if (uri.includes('twitch.tv'))       return { name: 'Twitch',      emoji: '🟣' };
  return { name: 'Unknown', emoji: '🎵' };
}

function pushHistory(guildId, track) {
  if (!songHistory.has(guildId)) songHistory.set(guildId, []);
  const hist = songHistory.get(guildId);
  if (hist[0]?.info?.uri === track.info?.uri) return;
  hist.unshift(track);
  if (hist.length > 20) hist.pop();
}

function hasDJPermission(member, guildId) {
  const roleId = djRoles.get(guildId);
  if (!roleId) return true;
  if (member.permissions.has('Administrator')) return true;
  return member.roles.cache.has(roleId);
}

// ─── Voice ready guard ────────────────────────────────────────────────────────
function waitForPlayerReady(guildId, timeoutMs = 6000) {
  return new Promise((resolve) => {
    let vsUpdate = false, serverUpdate = false;
    const done = () => {
      if (vsUpdate && serverUpdate) { client.removeListener('raw', onRaw); resolve(true); }
    };
    const onRaw = (d) => {
      if (!d) return;
      if (d.t === 'VOICE_STATE_UPDATE'  && d.d?.guild_id === guildId) { vsUpdate     = true; done(); }
      if (d.t === 'VOICE_SERVER_UPDATE' && d.d?.guild_id === guildId) { serverUpdate = true; done(); }
    };
    client.on('raw', onRaw);
    setTimeout(() => { client.removeListener('raw', onRaw); resolve(false); }, timeoutMs);
  });
}

// ─── Multi-platform resolver ──────────────────────────────────────────────────
async function resolveWithFallback(query, requesterId) {
  const isUrl = /^https?:\/\//i.test(query);
  if (isUrl && query.includes('music.apple.com')) {
    try {
      const r = await riffy.resolve({ query, requester: requesterId });
      if (r?.tracks?.length) { console.log('✅ Found on Apple Music'); return r; }
    } catch (e) { console.error('[AppleMusic]', e.message); }
  }
  if (isUrl) {
    try {
      const r = await riffy.resolve({ query, requester: requesterId });
      if (r?.tracks?.length) return r;
    } catch (e) { console.error('[URL Resolve]', e.message); }
  }
  for (const platform of ['ytmsearch', 'ytsearch', 'scsearch']) {
    try {
      const q = isUrl ? query : `${platform}:${query}`;
      const r = await riffy.resolve({ query: q, requester: requesterId });
      if (r?.tracks?.length) { console.log(`✅ Found on ${platform}`); return r; }
    } catch (e) { console.error(`[${platform}]`, e.message); }
  }
  return null;
}

// ─── Spotify adapter ──────────────────────────────────────────────────────────
function makeSpotifyAdapter(guildId, voiceChannelId, textChannelId, requesterId) {
  return {
    getQueue: (gId) => riffy.players.get(gId)?.queue ?? [],
    enqueue: async (gId, items) => {
      let player = riffy.players.get(gId);
      if (!player) {
        player = riffy.createConnection({ guildId, voiceChannel: voiceChannelId, textChannel: textChannelId, deaf: true });
        await waitForPlayerReady(guildId);
      }
      for (const item of (Array.isArray(items) ? items : [items])) {
        try {
          const result = await riffy.resolve({ query: `ytmsearch:${item.search}`, requester: requesterId });
          if (result?.tracks?.length) {
            const track = result.tracks[0];
            track.info.requester = requesterId;
            player.queue.add(track);
          }
        } catch (e) { console.error('[Spotify Track]', e.message); }
      }
      if (!player.playing && !player.paused && player.queue.size > 0) player.play();
    },
    guilds: { get: () => ({ maxQueue: 500 }) }
  };
}

// ══════════════════════════════════════════════════════════════════════════════
//  BACKGROUND IMAGE + PROGRESS BAR HELPER
// ══════════════════════════════════════════════════════════════════════════════

const NOWPLAYING_BG = "https://github.com/freefire948953-dotcom/updatedcode/blob/main/Music%20background%20template%20_%F0%9F%94%A5.jpg?raw=true";

function buildProgressBar(current, total, length = 18) {
  const ratio = total > 0 ? Math.min(current / total, 1) : 0;
  const pos = Math.round(ratio * length);
  let bar = '';
  for (let i = 0; i < length; i++) {
    bar += i === pos ? '🔘' : '▬';
  }
  return bar;
}

// ══════════════════════════════════════════════════════════════════════════════
//  UI BUILDERS — Components V2
// ══════════════════════════════════════════════════════════════════════════════

function createNowPlayingContainer(player, track, disabled = false) {
  const info      = track.info ?? {};
  const isPaused  = player.paused;
  const loopEmoji = player.loop === 'track' ? '🔂' : player.loop === 'queue' ? '🔁' : '▶️';
  const src       = detectSource(info);
  const elapsed   = player.position ?? 0;
  const total     = info.length ?? 0;
  const thumb     = resolveThumbnail(info);
  const votes     = voteSkips.get(player.guildId)?.size ?? 0;
  const fSet      = activeFilters.get(player.guildId) ?? new Set();
  const filterStr = fSet.size > 0 ? [...fSet].map(f => `\`${f}\``).join(' ') : '`none`';
  const isLooping   = player.loop && player.loop !== 'none';
  const isAutoplay  = autoplayEnabled.has(player.guildId);
  const isVoted     = votes > 0;

  return new ContainerBuilder()
    // ── Dark "glass" accent — near-black so the card reads as transparent black
    .setAccentColor(0x0a0a0f)
    .addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `## 🐧🎶 Now Playing\n` +
            `### [${info.title ?? 'Unknown Title'}](${info.uri ?? 'https://youtube.com'})\n` +
            `👤 ${info.author ?? 'Unknown'}  •  ${src.emoji} **${src.name}**`
          )
        )
        .setThumbnailAccessory(
          new ThumbnailBuilder().setURL(thumb).setDescription(info.title ?? 'Cover')
        )
    )
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `\`${formatTime(elapsed)}\` ${buildProgressBar(elapsed, total)} \`${formatTime(total)}\``
      )
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `${loopEmoji} Loop: \`${player.loop ?? 'none'}\`  •  ` +
        `🔊 Vol: \`${player.volume ?? 100}%\`  •  ` +
        `🎛️ Filters: ${filterStr}\n` +
        `🙋 Requested by <@${info.requester}>`
      )
    )
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    // Row 1 — core transport, 5 across in one clean line
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('previous').setEmoji('⏮️').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
        new ButtonBuilder()
          .setCustomId(isPaused ? 'resume' : 'pause')
          .setEmoji(isPaused ? '▶️' : '⏸️')
          .setStyle(isPaused ? ButtonStyle.Success : ButtonStyle.Primary)
          .setDisabled(disabled),
        new ButtonBuilder().setCustomId('skip').setEmoji('⏭️').setStyle(ButtonStyle.Primary).setDisabled(disabled),
        new ButtonBuilder()
          .setCustomId('voteskip')
          .setLabel(isVoted ? `Vote (${votes})` : 'Vote Skip')
          .setEmoji('🗳️')
          .setStyle(isVoted ? ButtonStyle.Success : ButtonStyle.Secondary)
          .setDisabled(disabled),
        new ButtonBuilder().setCustomId('stop').setEmoji('⏹️').setLabel('Stop').setStyle(ButtonStyle.Danger).setDisabled(disabled)
      )
    )
    // Row 2 — toggle/utility row, also 5 across, colors flip when active
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('loop').setEmoji(loopEmoji).setLabel('Loop')
          .setStyle(isLooping ? ButtonStyle.Success : ButtonStyle.Secondary)
          .setDisabled(disabled),
        new ButtonBuilder().setCustomId('shuffle').setEmoji('🔀').setLabel('Shuffle').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
        new ButtonBuilder()
          .setCustomId('autoplay').setLabel('Autoplay')
          .setEmoji(isAutoplay ? '✅' : '❌')
          .setStyle(isAutoplay ? ButtonStyle.Success : ButtonStyle.Secondary)
          .setDisabled(disabled),
        new ButtonBuilder().setCustomId('filters').setEmoji('🎛️').setLabel('Filters').setStyle(fSet.size > 0 ? ButtonStyle.Success : ButtonStyle.Secondary).setDisabled(disabled),
        new ButtonBuilder().setCustomId('queue').setEmoji('📋').setLabel('Queue').setStyle(ButtonStyle.Secondary).setDisabled(disabled)
      )
    )
    // Row 3 — Lyrics
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('lyrics').setEmoji('📝').setLabel('Lyrics').setStyle(ButtonStyle.Secondary).setDisabled(disabled)
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
  const queue   = player.queue ?? [];
  const current = player.current;
  let desc = '';
  if (current?.info) {
    const src = detectSource(current.info);
    desc += `**🎵 Now Playing:**\n**[${current.info.title}](${current.info.uri})**\n${current.info.author ?? 'Unknown'} • ${formatTime(current.info.length)} • ${src.emoji} ${src.name} • <@${current.info.requester}>\n\n`;
  }
  if (queue.length > 0) {
    desc += `**📋 Up Next:**\n`;
    queue.slice(0, 10).forEach((t, i) => {
      const inf = t.info ?? {};
      const src = detectSource(inf);
      desc += `\`${i + 1}.\` **[${inf.title}](${inf.uri})**\n${inf.author ?? 'Unknown'} • ${formatTime(inf.length)} • ${src.emoji} • <@${inf.requester}>\n`;
    });
    if (queue.length > 10) desc += `\n*...and ${queue.length - 10} more track(s)*`;
  } else if (!current) {
    desc = 'Queue is empty. Use `/play` to add songs!';
  }
  const fSet = activeFilters.get(player.guildId) ?? new Set();
  desc += `\n\n🔁 Loop: \`${(!player.loop || player.loop === 'none') ? 'off' : player.loop}\`` +
    ` │ 🤖 Autoplay: \`${autoplayEnabled.has(player.guildId) ? 'on' : 'off'}\`` +
    ` │ 🔊 Vol: \`${player.volume ?? 100}%\`` +
    ` │ 🎵 Total: \`${queue.length + (current ? 1 : 0)}\`` +
    (fSet.size > 0 ? ` │ 🎛️ \`${[...fSet].join(', ')}\`` : '');
  return new ContainerBuilder()
    .addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## 📋 Queue\n${desc}`))
        .setThumbnailAccessory(new ThumbnailBuilder().setURL(client.user.displayAvatarURL({ size: 1024 })).setDescription('Queue'))
    )
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));
}

function createFiltersContainer(guildId) {
  const fSet = activeFilters.get(guildId) ?? new Set();
  const activeStr = fSet.size > 0 ? [...fSet].map(f => `\`${f}\``).join(' ') : '`none`';
  const list =
    `🎸 \`bassboost\`    — Heavy bass enhancement\n` +
    `🌙 \`nightcore\`    — Sped up + higher pitch\n` +
    `🌊 \`vaporwave\`    — Slowed + lower pitch\n` +
    `🎧 \`8d\`           — Spatial 8D audio\n` +
    `😴 \`slowedreverb\` — Slowed with reverb\n` +
    `🔆 \`treble\`       — Treble boost\n` +
    `🎤 \`pop\`          — Pop equalizer\n` +
    `🌀 \`soft\`         — Low-pass smooth\n` +
    `📢 \`loud\`         — All bands boosted\n` +
    `🦻 \`earrape\`      — Max boost (very loud!)\n` +
    `🎤 \`karaoke\`      — Vocal remover\n` +
    `📻 \`distortion\`   — Distortion effect\n` +
    `🐉 \`china\`        — China effect\n` +
    `🐿️ \`chipmunk\`     — Chipmunk pitch\n` +
    `🎵 \`vibrato\`      — Vibrato effect\n` +
    `〰️ \`tremolo\`      — Tremolo effect\n\n` +
    `**Active:** ${activeStr}\n\n` +
    `Use \`/filter <name>\` to toggle • \`/clearfilters\` to reset`;
  return new ContainerBuilder()
    .addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## 🎛️ Audio Filters\n${list}`))
        .setThumbnailAccessory(new ThumbnailBuilder().setURL(client.user.displayAvatarURL({ size: 1024 })).setDescription('Filters'))
    )
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));
}

function createHistoryContainer(guildId) {
  const hist = songHistory.get(guildId) ?? [];
  const desc = hist.length === 0
    ? 'No songs played yet this session.'
    : hist.slice(0, 15).map((t, i) => {
        const inf = t.info ?? {};
        const src = detectSource(inf);
        return `\`${i + 1}.\` **[${inf.title}](${inf.uri})**\n${inf.author ?? 'Unknown'} • ${formatTime(inf.length)} • ${src.emoji} <@${inf.requester}>`;
      }).join('\n');
  return new ContainerBuilder()
    .addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## 🕒 Song History\n${desc}`))
        .setThumbnailAccessory(new ThumbnailBuilder().setURL(client.user.displayAvatarURL({ size: 1024 })).setDescription('History'))
    )
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));
}

function createStatsContainer() {
  const mem = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2);
  return new ContainerBuilder()
    .addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `## 📊 Bot Statistics\n` +
            `🏠 **Servers:** \`${client.guilds.cache.size}\`\n` +
            `👥 **Users:** \`${client.guilds.cache.reduce((a, g) => a + g.memberCount, 0)}\`\n` +
            `🎵 **Active Players:** \`${riffy.players?.size ?? 0}\`\n` +
            `⏱️ **Uptime:** \`${formatTime(client.uptime)}\`\n` +
            `📶 **Ping:** \`${client.ws.ping}ms\`\n` +
            `🧠 **Memory:** \`${mem} MB\`\n` +
            `🔊 **Audio Quality:** \`Hi-Fi Opus (Max)\`\n` +
            `🔗 **Lavalink:** ${isLavalinkConnected ? '🟢 Connected' : '🔴 Disconnected'}`
          )
        )
        .setThumbnailAccessory(new ThumbnailBuilder().setURL(client.user.displayAvatarURL({ size: 1024 })).setDescription('Stats'))
    )
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));
}

function createHelpContainer() {
  return new ContainerBuilder()
    .addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `## 🎵 ${client.user.username} — Help\n` +
            `Hi-Fi music from **YouTube • Spotify • SoundCloud • Apple Music**\n` +
            `Lavalink: ${isLavalinkConnected ? '🟢 Online' : '🔴 Offline'} | Made by **SKY x LIVE**\n\n` +
            `**🎵 Playback**\n` +
            `\`/play\` \`/pause\` \`/resume\` \`/skip\` \`/stop\`\n` +
            `\`/nowplaying\` \`/voteskip\` \`/247\` \`/autoplay\`\n\n` +
            `**📋 Queue**\n` +
            `\`/queue\` \`/shuffle\` \`/loop\` \`/clearqueue\`\n` +
            `\`/remove\` \`/move\` \`/volume\` \`/history\`\n\n` +
            `**🎛️ Audio Filters (15+)**\n` +
            `\`/filter\` — \`bassboost\` \`nightcore\` \`vaporwave\`\n` +
            `\`8d\` \`slowedreverb\` \`karaoke\` \`chipmunk\` \`vibrato\` \`tremolo\` …\n` +
            `\`/clearfilters\` — Remove all effects\n\n` +
            `**🛡️ DJ / Admin**\n` +
            `\`/djrole\` \`/lyrics\`\n\n` +
            `**ℹ️ Utility**\n` +
            `\`/stats\` \`/ping\` \`/invite\` \`/support\` \`/help\`\n\n` +
            `💡 Paste any Spotify/Apple Music/SoundCloud link directly!`
          )
        )
        .setThumbnailAccessory(new ThumbnailBuilder().setURL(client.user.displayAvatarURL({ size: 1024 })).setDescription('Help'))
    )
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel('Invite Me').setStyle(ButtonStyle.Link)
          .setURL(`https://discord.com/api/oauth2/authorize?client_id=${client.user.id}&permissions=3165184&scope=bot%20applications.commands`),
        new ButtonBuilder().setLabel('Support').setStyle(ButtonStyle.Link).setURL(config.supportServer)
      )
    );
}

// ══════════════════════════════════════════════════════════════════════════════
//  PREVIOUS SONG HANDLER
// ══════════════════════════════════════════════════════════════════════════════

async function handlePrevious(player, requesterId, replyFn, messageFn = null) {
  const hist = songHistory.get(player.guildId) ?? [];
  // hist[0] = current song, hist[1] = previous song
  const prev = hist[1];
  if (!prev) return replyFn('❌ No previous song found in history!');
  try {
    const result = await resolveWithFallback(prev.info.uri || prev.info.title, requesterId);
    if (result?.tracks?.length) {
      const t = result.tracks[0];
      t.info.requester = prev.info.requester ?? requesterId;
      player.queue.unshift(t);
      if (messageFn) await messageFn();
      player.stop();
      return replyFn(`⏮️ Playing previous: **[${prev.info.title}](${prev.info.uri})**`);
    }
    return replyFn('❌ Could not load previous track');
  } catch (e) {
    console.error('[Previous]', e.message);
    return replyFn('❌ Error loading previous track');
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  CORE PLAY HANDLER
// ══════════════════════════════════════════════════════════════════════════════

async function handlePlay(guildId, voiceChannelId, textChannelId, query, requesterId, reply, editReply) {
  if (!isLavalinkConnected) return reply('❌ Lavalink is not connected. Please try again in a moment.');

  if (spotifyModule.isSpotifyUrl(query)) {
    const spotifyReplyFn = async (data) => {
      const embedData = data?.embeds?.[0];
      const title = embedData?.data?.title ?? embedData?.title ?? 'Spotify';
      const desc  = embedData?.data?.description ?? embedData?.description ?? '';
      return editReply({ components: [createSimpleContainer(title, desc, '🟢')], flags: MessageFlags.IsComponentsV2 });
    };
    await spotifyModule.handleSpotify(query, guildId, textChannelId, requesterId, spotifyReplyFn, makeSpotifyAdapter(guildId, voiceChannelId, textChannelId, requesterId));
    return;
  }

  let player = riffy.players.get(guildId);
  const isNew = !player;
  if (isNew) {
    player = riffy.createConnection({ guildId, voiceChannel: voiceChannelId, textChannel: textChannelId, deaf: true });
    const ready = await waitForPlayerReady(guildId, 6000);
    if (!ready) console.warn(`[handlePlay] Voice timeout for ${guildId}`);
  }

  const resolve = await resolveWithFallback(query, requesterId);
  if (!resolve?.tracks?.length) {
    if (isNew) { try { player.destroy(); } catch (_) {} }
    return editReply('❌ No results found. Try a different search or paste a direct URL.');
  }

  if (resolve.loadType === 'playlist') {
    for (const t of resolve.tracks) { t.info.requester = requesterId; player.queue.add(t); }
    await editReply({
      components: [createSimpleContainer('Playlist Added', `📀 **${resolve.playlistInfo?.name ?? 'Playlist'}**\n🎵 ${resolve.tracks.length} tracks added to queue`, '✅')],
      flags: MessageFlags.IsComponentsV2
    });
  } else {
    const track = resolve.tracks[0];
    track.info.requester = requesterId;
    player.queue.add(track);
    const src = detectSource(track.info);
    await editReply({
      components: [createSimpleContainer('Added to Queue', `${src.emoji} **[${track.info.title}](${track.info.uri})**\n👤 ${track.info.author ?? 'Unknown'} • ⏱️ ${formatTime(track.info.length)}`, '✅')],
      flags: MessageFlags.IsComponentsV2
    });
  }
  if (!player.playing && !player.paused) player.play();
}

// ══════════════════════════════════════════════════════════════════════════════
//  LYRICS
// ══════════════════════════════════════════════════════════════════════════════

async function handleLyrics(guildId, query, replyFn) {
  if (!geniusClient) return replyFn({ content: '❌ Lyrics unavailable. Install: `npm install genius-lyrics`', ephemeral: true });
  let searchQuery = query;
  if (!searchQuery) {
    const player = riffy.players.get(guildId);
    if (!player?.current) return replyFn({ content: '❌ Nothing is playing.', ephemeral: true });
    const inf = player.current.info;
    searchQuery = `${inf.title} ${inf.author}`.replace(/\[.*?\]|\(.*?\)/g, '').trim();
  }
  try {
    const results = await geniusClient.songs.search(searchQuery);
    if (!results?.length) return replyFn({ content: `❌ No lyrics found for **${searchQuery}**`, ephemeral: true });
    const song   = results[0];
    const lyrics = await song.lyrics();
    if (!lyrics) return replyFn({ content: `❌ Lyrics unavailable for **${song.title}**`, ephemeral: true });
    const chunks = [];
    let cur = '';
    for (const line of lyrics.split('\n')) {
      if ((cur + '\n' + line).length > 3800) { chunks.push(cur); cur = line; }
      else cur += (cur ? '\n' : '') + line;
    }
    if (cur) chunks.push(cur);
    await replyFn({
      components: [
        new ContainerBuilder()
          .addSectionComponents(
            new SectionBuilder()
              .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## 📝 ${song.title}\n**By:** ${song.artist?.name ?? 'Unknown'}\n\n${chunks[0]}`))
              .setThumbnailAccessory(new ThumbnailBuilder().setURL(song.image ?? client.user.displayAvatarURL({ size: 1024 })).setDescription('Album Art'))
          )
          .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
      ],
      flags: MessageFlags.IsComponentsV2, ephemeral: true
    });
  } catch (e) {
    console.error('[Lyrics]', e.message);
    replyFn({ content: `❌ Lyrics error: ${e.message}`, ephemeral: true });
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  VOTE SKIP
// ══════════════════════════════════════════════════════════════════════════════

function processVoteSkip(player, userId) {
  const guildId = player.guildId;
  if (!voteSkips.has(guildId)) voteSkips.set(guildId, new Set());
  const votes = voteSkips.get(guildId);
  votes.add(userId);
  const vc = client.channels.cache.get(player.voiceChannel);
  const memberCount = vc ? [...vc.members.values()].filter(m => !m.user.bot).length : 2;
  const required = Math.ceil(memberCount * 0.5);
  if (votes.size >= required) { voteSkips.delete(guildId); return { skip: true }; }
  return { skip: false, current: votes.size, required };
}

// ══════════════════════════════════════════════════════════════════════════════
//  RIFFY EVENTS
// ══════════════════════════════════════════════════════════════════════════════

riffy.on('nodeConnect', async (node) => {
  console.log(`✅ Node "${node.name}" connected`);
  isLavalinkConnected = true;
  if (autoReconnect.size === 0) return;
  console.log(`🔄 Auto-reconnecting ${autoReconnect.size} voice channel(s)...`);
  for (const [guildId, data] of autoReconnect.entries()) {
    try {
      await new Promise(r => setTimeout(r, 1000));
      const guild = client.guilds.cache.get(guildId);
      if (!guild) continue;
      const vc = guild.channels.cache.get(data.voiceChannelId);
      if (!vc) continue;
      if (riffy.players.get(guildId)) continue;
      riffy.createConnection({ guildId, voiceChannel: data.voiceChannelId, textChannel: data.textChannelId, deaf: true });
      const textCh = guild.channels.cache.get(data.textChannelId);
      if (textCh) await textCh.send({ components: [createSimpleContainer('Auto-Reconnected! 🔄', `Back online! Rejoined <#${data.voiceChannelId}> automatically.`, '✅')], flags: MessageFlags.IsComponentsV2 }).catch(() => {});
      console.log(`✅ Auto-rejoined VC in guild ${guildId}`);
    } catch (e) { console.error(`[AutoReconnect] Guild ${guildId}:`, e.message); }
  }
});

riffy.on('nodeError',      (node, error) => { console.error(`❌ Node "${node.name}" error:`, error?.message ?? error); isLavalinkConnected = riffy.nodes?.some?.(n => n.connected) ?? false; });
riffy.on('nodeDisconnect', (node)        => { console.warn(`⚠️  Node "${node.name}" disconnected`); isLavalinkConnected = riffy.nodes?.some?.(n => n.connected) ?? false; });

riffy.on('trackStart', async (player, track) => {
  pushHistory(player.guildId, track);
  voteSkips.delete(player.guildId);
  autoReconnect.set(player.guildId, { voiceChannelId: player.voiceChannel, textChannelId: player.textChannel });
  // Boost default volume once per session for fuller audio clarity (only if user hasn't set a custom volume yet)
  if (!autoReconnect.get(player.guildId)?._volumeBoosted && (!player.volume || player.volume === 100)) {
    try { player.setVolume(130); } catch (_) {}
    const rc = autoReconnect.get(player.guildId);
    if (rc) rc._volumeBoosted = true;
  }
  const channel = client.channels.cache.get(player.textChannel);
  if (!channel) return;
  const old = nowPlayingMsgs.get(player.guildId);
  if (old) { try { await old.delete(); } catch (_) {} nowPlayingMsgs.delete(player.guildId); }
  try {
    const msg = await channel.send({ components: [createNowPlayingContainer(player, track)], flags: MessageFlags.IsComponentsV2 });
    nowPlayingMsgs.set(player.guildId, msg);
  } catch (e) { console.error('[trackStart]', e.message); }
});

riffy.on('trackError', (player, track, error) => { console.error(`[trackError] ${track?.info?.title}:`, error?.message ?? error); try { player.stop(); } catch (_) {} });

riffy.on('queueEnd', async (player) => {
  const channel   = client.channels.cache.get(player.textChannel);
  const lastTrack = player.current;
  const msg = nowPlayingMsgs.get(player.guildId);
  if (msg && lastTrack) { try { await msg.edit({ components: [createNowPlayingContainer(player, lastTrack, true)], flags: MessageFlags.IsComponentsV2 }); } catch (_) {} }
  nowPlayingMsgs.delete(player.guildId);

  if (autoplayEnabled.has(player.guildId) && lastTrack) {
    try {
      const terms = [`${lastTrack.info.title} similar songs`, `${lastTrack.info.author} top songs`, `${lastTrack.info.title} bollywood`, `${lastTrack.info.author} hindi hits`, `${lastTrack.info.title} slowed reverb`, `${lastTrack.info.author} romantic songs`];
      const raw    = terms[Math.floor(Math.random() * terms.length)];
      const result = await riffy.resolve({ query: `ytmsearch:${raw}`, requester: lastTrack.info.requester });
      if (result?.tracks?.length) {
        const pool = result.tracks.filter(t => t.info.uri !== lastTrack.info.uri);
        const next = (pool.length ? pool : result.tracks)[Math.floor(Math.random() * (pool.length || result.tracks.length))];
        next.info.requester = lastTrack.info.requester;
        player.queue.add(next);
        player.play();
        if (channel) await channel.send({ components: [createSimpleContainer('Autoplay', `🤖 Added **[${next.info.title}](${next.info.uri})**`, '🔁')], flags: MessageFlags.IsComponentsV2 });
        return;
      }
    } catch (e) { console.error('[Autoplay]', e.message); }
  }

  if (queue247.has(player.guildId)) {
    if (channel) await channel.send({ components: [createSimpleContainer('24/7 Mode', 'Queue ended — staying in VC', 'ℹ️')], flags: MessageFlags.IsComponentsV2 });
    return;
  }

  if (channel) await channel.send({ components: [createSimpleContainer('Queue Ended', 'All songs played! Use `/play` to add more.', '✅')], flags: MessageFlags.IsComponentsV2 });
  try { player.destroy(); } catch (_) {}
  activeFilters.delete(player.guildId);
  autoReconnect.delete(player.guildId);
});

// ══════════════════════════════════════════════════════════════════════════════
//  CLIENT EVENTS
// ══════════════════════════════════════════════════════════════════════════════

client.on('clientReady', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  try { riffy.init(client.user.id); } catch (e) { console.error('[Riffy Init]', e); }
  const types = { PLAYING: ActivityType.Playing, LISTENING: ActivityType.Listening, WATCHING: ActivityType.Watching, STREAMING: ActivityType.Streaming, COMPETING: ActivityType.Competing };
  client.user.setActivity(config.activity.name, { type: types[config.activity.type] ?? ActivityType.Listening });

  const commands = [
    { name: 'play', description: 'Play a song (YouTube, Spotify, SoundCloud, Apple Music)', options: [{ name: 'query', description: 'Song name or URL', type: 3, required: true }] },
    { name: 'pause',      description: 'Pause the current song' },
    { name: 'resume',     description: 'Resume paused playback' },
    { name: 'skip',       description: 'Skip the current song' },
    { name: 'previous',   description: 'Play the previous song' },
    { name: 'voteskip',   description: 'Vote to skip (50% of VC required)' },
    { name: 'stop',       description: 'Stop player and clear queue' },
    { name: 'volume',     description: 'Set volume (1–150)', options: [{ name: 'level', description: 'Volume level', type: 4, required: true, min_value: 1, max_value: 150 }] },
    { name: 'queue',      description: 'Show the current queue' },
    { name: 'nowplaying', description: 'Show the currently playing song' },
    { name: 'shuffle',    description: 'Shuffle the queue' },
    { name: 'loop',       description: 'Set loop mode', options: [{ name: 'mode', description: 'Loop mode', type: 3, required: true, choices: [{ name: 'Off', value: 'none' }, { name: 'Track', value: 'track' }, { name: 'Queue', value: 'queue' }] }] },
    { name: 'remove',     description: 'Remove a song from queue', options: [{ name: 'position', description: 'Queue position', type: 4, required: true, min_value: 1 }] },
    { name: 'move',       description: 'Move a song in queue', options: [{ name: 'from', description: 'From position', type: 4, required: true, min_value: 1 }, { name: 'to', description: 'To position', type: 4, required: true, min_value: 1 }] },
    { name: 'clearqueue', description: 'Clear the entire queue' },
    { name: '247',        description: 'Toggle 24/7 mode' },
    { name: 'autoplay',   description: 'Toggle autoplay' },
    { name: 'filter',     description: 'Apply an audio filter', options: [{ name: 'name', description: 'Filter name', type: 3, required: true, choices: FILTER_NAMES.map(f => ({ name: f, value: f })) }] },
    { name: 'clearfilters', description: 'Remove all audio filters' },
    { name: 'lyrics',     description: 'Get lyrics', options: [{ name: 'query', description: 'Song name (empty = current)', type: 3, required: false }] },
    { name: 'history',    description: 'Show recently played songs' },
    { name: 'djrole',     description: 'Set/remove DJ role (Admin only)', options: [{ name: 'role', description: 'DJ role (empty to remove)', type: 8, required: false }] },
    { name: 'stats',      description: 'Show bot statistics' },
    { name: 'ping',       description: 'Show bot latency' },
    { name: 'invite',     description: 'Get bot invite link' },
    { name: 'support',    description: 'Get support server link' },
    { name: 'help',       description: 'Show all commands' }
  ];

  await client.application.commands.set(commands);
  console.log(`✅ ${commands.length} slash commands registered`);
});

client.on('raw', (d) => {
  try {
    if (!d || !['VOICE_STATE_UPDATE', 'VOICE_SERVER_UPDATE'].includes(d.t)) return;
    riffy.updateVoiceState(d);
  } catch (e) { console.error('[raw]', e.message); }
});

async function sendGuildLog(guild, joined) {
  try {
    const logsChannelId = config.logsChannelId;
    if (!logsChannelId) return;
    const logsChannel = client.channels.cache.get(logsChannelId);
    if (!logsChannel) return;
    const owner = await guild.fetchOwner().catch(() => null);
    const createdAt = `<t:${Math.floor(guild.createdTimestamp / 1000)}:R>`;
    const container = new ContainerBuilder()
      .addSectionComponents(
        new SectionBuilder()
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              `## ${joined ? '✅ Bot Added to Server' : '❌ Bot Removed from Server'}\n` +
              `**Server:** ${guild.name}\n**Server ID:** \`${guild.id}\`\n` +
              `**Members:** ${guild.memberCount}\n` +
              `**Owner:** ${owner ? `${owner.user.tag} (\`${owner.id}\`)` : 'Unknown'}\n` +
              `**Created:** ${createdAt}\n**Total Servers:** ${client.guilds.cache.size}`
            )
          )
          .setThumbnailAccessory(new ThumbnailBuilder().setURL(guild.iconURL({ size: 1024 }) ?? client.user.displayAvatarURL({ size: 1024 })).setDescription(guild.name))
      )
      .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));
    await logsChannel.send({ components: [container], flags: MessageFlags.IsComponentsV2 });
  } catch (e) { console.error('[GuildLog]', e.message); }
}

client.on('guildCreate', async (guild) => { console.log(`✅ Joined server: ${guild.name} (${guild.id})`); await sendGuildLog(guild, true); });
client.on('guildDelete', async (guild) => {
  console.log(`❌ Left server: ${guild.name} (${guild.id})`);
  queue247.delete(guild.id); autoplayEnabled.delete(guild.id); djRoles.delete(guild.id);
  nowPlayingMsgs.delete(guild.id); songHistory.delete(guild.id); voteSkips.delete(guild.id);
  activeFilters.delete(guild.id); autoReconnect.delete(guild.id);
  const p = riffy.players.get(guild.id);
  if (p) { try { p.destroy(); } catch (_) {} }
  await sendGuildLog(guild, false);
});

// ══════════════════════════════════════════════════════════════════════════════
//  INTERACTIONS
// ══════════════════════════════════════════════════════════════════════════════

client.on('interactionCreate', async (interaction) => {

  // ── BUTTONS ────────────────────────────────────────────────────────────────
  if (interaction.isButton()) {
    const player = riffy.players.get(interaction.guildId);
    if (!player) return interaction.reply({ content: '❌ No active player', ephemeral: true }).catch(() => {});
    const member = interaction.member;
    if (!member.voice?.channel) return interaction.reply({ content: '❌ Join a voice channel first', ephemeral: true }).catch(() => {});
    if (member.voice.channel.id !== player.voiceChannel) return interaction.reply({ content: '❌ Join the bot\'s voice channel', ephemeral: true }).catch(() => {});
    const djProtected = ['skip', 'stop', 'shuffle', 'loop', 'previous'];
    if (djProtected.includes(interaction.customId) && !hasDJPermission(member, interaction.guildId))
      return interaction.reply({ content: '❌ DJ role required', ephemeral: true }).catch(() => {});

    try {
      switch (interaction.customId) {

        case 'previous': {
          if (!player.current) return interaction.reply({ content: '❌ Nothing playing', ephemeral: true });
          await handlePrevious(
            player,
            interaction.user.id,
            async (msg) => interaction.reply({ content: msg, ephemeral: true }),
            async () => {
              if (player.current) await interaction.message.edit({ components: [createNowPlayingContainer(player, player.current, true)], flags: MessageFlags.IsComponentsV2 }).catch(() => {});
            }
          );
          break;
        }

        case 'pause': case 'resume': {
          const pause = interaction.customId === 'pause';
          await player.pause(pause);
          const nm = nowPlayingMsgs.get(player.guildId);
          if (nm && player.current) await nm.edit({ components: [createNowPlayingContainer(player, player.current)], flags: MessageFlags.IsComponentsV2 }).catch(() => {});
          await interaction.reply({ content: pause ? '⏸️ Paused' : '▶️ Resumed', ephemeral: true });
          break;
        }

        case 'skip': {
          if (player.current) await interaction.message.edit({ components: [createNowPlayingContainer(player, player.current, true)], flags: MessageFlags.IsComponentsV2 }).catch(() => {});
          player.stop();
          await interaction.reply({ content: '⏭️ Skipped', ephemeral: true });
          break;
        }

        case 'voteskip': {
          if (!player.current) return interaction.reply({ content: '❌ Nothing playing', ephemeral: true });
          const res = processVoteSkip(player, member.user.id);
          if (res.skip) {
            if (player.current) await interaction.message.edit({ components: [createNowPlayingContainer(player, player.current, true)], flags: MessageFlags.IsComponentsV2 }).catch(() => {});
            player.stop();
            await interaction.reply({ content: '🗳️ Vote passed! Skipping...', ephemeral: false });
          } else {
            const nm = nowPlayingMsgs.get(player.guildId);
            if (nm && player.current) await nm.edit({ components: [createNowPlayingContainer(player, player.current)], flags: MessageFlags.IsComponentsV2 }).catch(() => {});
            await interaction.reply({ content: `🗳️ **${res.current}/${res.required}** votes to skip`, ephemeral: true });
          }
          break;
        }

        case 'stop': {
          if (player.current) await interaction.message.edit({ components: [createNowPlayingContainer(player, player.current, true)], flags: MessageFlags.IsComponentsV2 }).catch(() => {});
          nowPlayingMsgs.delete(player.guildId);
          activeFilters.delete(player.guildId);
          try { player.destroy(); } catch (_) {}
          await interaction.reply({ content: '⏹️ Stopped and cleared queue', ephemeral: true });
          break;
        }

        case 'shuffle': {
          if (!player.queue?.length) return interaction.reply({ content: '❌ Queue is empty', ephemeral: true });
          player.queue.shuffle();
          await interaction.reply({ content: '🔀 Queue shuffled!', ephemeral: true });
          break;
        }

        case 'loop': {
          const modes = ['none', 'track', 'queue'];
          const next  = modes[(modes.indexOf(player.loop ?? 'none') + 1) % modes.length];
          player.setLoop(next);
          const nm = nowPlayingMsgs.get(player.guildId);
          if (nm && player.current) await nm.edit({ components: [createNowPlayingContainer(player, player.current)], flags: MessageFlags.IsComponentsV2 }).catch(() => {});
          await interaction.reply({ content: `🔁 Loop: **${next}**`, ephemeral: true });
          break;
        }

        case 'autoplay': {
          autoplayEnabled.has(player.guildId) ? autoplayEnabled.delete(player.guildId) : autoplayEnabled.add(player.guildId);
          const on = autoplayEnabled.has(player.guildId);
          const nm = nowPlayingMsgs.get(player.guildId);
          if (nm && player.current) await nm.edit({ components: [createNowPlayingContainer(player, player.current)], flags: MessageFlags.IsComponentsV2 }).catch(() => {});
          await interaction.reply({ content: on ? '✅ Autoplay ON' : '❌ Autoplay OFF', ephemeral: true });
          break;
        }

        case 'filters': {
          await interaction.reply({ components: [createFiltersContainer(interaction.guildId)], flags: MessageFlags.IsComponentsV2, ephemeral: true });
          break;
        }

        case 'queue': {
          await interaction.reply({ components: [createQueueContainer(player)], flags: MessageFlags.IsComponentsV2, ephemeral: true });
          break;
        }

        case 'lyrics': {
          await interaction.deferReply({ ephemeral: true });
          await handleLyrics(interaction.guildId, null, d => interaction.editReply(d));
          break;
        }
      }
    } catch (e) {
      console.error('[Button]', e.message);
      if (!interaction.replied && !interaction.deferred)
        await interaction.reply({ content: '❌ Something went wrong', ephemeral: true }).catch(() => {});
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  const { commandName, options, member, guild, channel } = interaction;

  const getPlayer = (requireVC = true) => {
    const p = riffy.players.get(guild.id);
    if (!p) { interaction.reply({ content: '❌ No active player', ephemeral: true }); return null; }
    if (requireVC) {
      if (!member.voice?.channel) { interaction.reply({ content: '❌ Join a voice channel first', ephemeral: true }); return null; }
      if (member.voice.channel.id !== p.voiceChannel) { interaction.reply({ content: '❌ Join the bot\'s voice channel', ephemeral: true }); return null; }
    }
    return p;
  };

  const djCmds = ['skip', 'previous', 'stop', 'shuffle', 'loop', 'volume', 'remove', 'move', 'clearqueue', 'filter', 'clearfilters'];
  if (djCmds.includes(commandName) && !hasDJPermission(member, guild.id))
    return interaction.reply({ content: `❌ DJ role required for \`/${commandName}\``, ephemeral: true });

  try {

    if (commandName === 'play') {
      if (!member.voice?.channel) return interaction.reply({ content: '❌ Join a voice channel first', ephemeral: true });
      await interaction.deferReply();
      await handlePlay(guild.id, member.voice.channel.id, channel.id, options.getString('query'), member.user.id,
        msg => interaction.reply(typeof msg === 'string' ? { content: msg, ephemeral: true } : msg),
        data => interaction.editReply(data)
      );
    }

    else if (commandName === 'previous') {
      const p = getPlayer(); if (!p) return;
      if (!p.current) return interaction.reply({ content: '❌ Nothing playing', ephemeral: true });
      await handlePrevious(
        p,
        member.user.id,
        async (msg) => interaction.reply({ components: [createSimpleContainer('Previous', msg, '⏮️')], flags: MessageFlags.IsComponentsV2 })
      );
    }

    else if (commandName === 'pause') {
      const p = getPlayer(); if (!p) return;
      await p.pause(true);
      await interaction.reply({ components: [createSimpleContainer('Paused', 'Playback paused', '⏸️')], flags: MessageFlags.IsComponentsV2 });
    }

    else if (commandName === 'resume') {
      const p = getPlayer(); if (!p) return;
      await p.pause(false);
      await interaction.reply({ components: [createSimpleContainer('Resumed', 'Playback resumed', '▶️')], flags: MessageFlags.IsComponentsV2 });
    }

    else if (commandName === 'skip') {
      const p = getPlayer(); if (!p) return;
      p.stop();
      await interaction.reply({ components: [createSimpleContainer('Skipped', 'Skipped to next track', '⏭️')], flags: MessageFlags.IsComponentsV2 });
    }

    else if (commandName === 'voteskip') {
      const p = getPlayer(); if (!p) return;
      if (!p.current) return interaction.reply({ content: '❌ Nothing playing', ephemeral: true });
      const res = processVoteSkip(p, member.user.id);
      if (res.skip) { p.stop(); await interaction.reply({ components: [createSimpleContainer('Vote Passed!', 'Skipping now...', '🗳️')], flags: MessageFlags.IsComponentsV2 }); }
      else await interaction.reply({ components: [createSimpleContainer('Vote Recorded', `**${res.current}/${res.required}** votes needed`, '🗳️')], flags: MessageFlags.IsComponentsV2 });
    }

    else if (commandName === 'stop') {
      const p = getPlayer(); if (!p) return;
      nowPlayingMsgs.delete(guild.id); activeFilters.delete(guild.id);
      try { p.destroy(); } catch (_) {}
      await interaction.reply({ components: [createSimpleContainer('Stopped', 'Player stopped and queue cleared', '⏹️')], flags: MessageFlags.IsComponentsV2 });
    }

    else if (commandName === 'volume') {
      const p = getPlayer(); if (!p) return;
      const vol = options.getInteger('level');
      p.setVolume(vol);
      await interaction.reply({ components: [createSimpleContainer('Volume', `Set to **${vol}%**`, '🔊')], flags: MessageFlags.IsComponentsV2 });
    }

    else if (commandName === 'queue') {
      const p = riffy.players.get(guild.id);
      if (!p) return interaction.reply({ content: '❌ No active player', ephemeral: true });
      if (!p.queue.length && !p.current) return interaction.reply({ content: '❌ Queue is empty', ephemeral: true });
      await interaction.reply({ components: [createQueueContainer(p)], flags: MessageFlags.IsComponentsV2 });
    }

    else if (commandName === 'nowplaying') {
      const p = riffy.players.get(guild.id);
      if (!p?.current) return interaction.reply({ content: '❌ Nothing playing', ephemeral: true });
      await interaction.reply({ components: [createNowPlayingContainer(p, p.current)], flags: MessageFlags.IsComponentsV2 });
    }

    else if (commandName === 'shuffle') {
      const p = getPlayer(); if (!p) return;
      if (!p.queue.length) return interaction.reply({ content: '❌ Queue is empty', ephemeral: true });
      p.queue.shuffle();
      await interaction.reply({ components: [createSimpleContainer('Shuffled', 'Queue order randomised!', '🔀')], flags: MessageFlags.IsComponentsV2 });
    }

    else if (commandName === 'loop') {
      const p = getPlayer(); if (!p) return;
      const mode = options.getString('mode');
      p.setLoop(mode);
      await interaction.reply({ components: [createSimpleContainer('Loop', `Mode set to **${mode}**`, '🔁')], flags: MessageFlags.IsComponentsV2 });
    }

    else if (commandName === 'remove') {
      const p = getPlayer(); if (!p) return;
      const pos = options.getInteger('position') - 1;
      if (pos < 0 || pos >= p.queue.length) return interaction.reply({ content: '❌ Invalid position', ephemeral: true });
      const removed = p.queue.remove(pos);
      await interaction.reply({ components: [createSimpleContainer('Removed', `Removed **${removed.info.title}**`, '✅')], flags: MessageFlags.IsComponentsV2 });
    }

    else if (commandName === 'move') {
      const p = getPlayer(); if (!p) return;
      const from = options.getInteger('from') - 1;
      const to   = options.getInteger('to')   - 1;
      if (from < 0 || from >= p.queue.length || to < 0 || to >= p.queue.length) return interaction.reply({ content: '❌ Invalid positions', ephemeral: true });
      const arr = Array.from(p.queue);
      const [t] = arr.splice(from, 1);
      arr.splice(to, 0, t);
      p.queue.clear();
      arr.forEach(tr => p.queue.add(tr));
      await interaction.reply({ components: [createSimpleContainer('Moved', `Moved **${t.info.title}** to position ${to + 1}`, '✅')], flags: MessageFlags.IsComponentsV2 });
    }

    else if (commandName === 'clearqueue') {
      const p = getPlayer(); if (!p) return;
      p.queue.clear();
      await interaction.reply({ components: [createSimpleContainer('Queue Cleared', 'All upcoming tracks removed', '✅')], flags: MessageFlags.IsComponentsV2 });
    }

    else if (commandName === '247') {
      if (!member.voice?.channel) return interaction.reply({ content: '❌ Join a voice channel first', ephemeral: true });
      if (queue247.has(guild.id)) {
        queue247.delete(guild.id);
        await interaction.reply({ components: [createSimpleContainer('24/7 Disabled', 'Bot will leave when queue ends', '✅')], flags: MessageFlags.IsComponentsV2 });
      } else {
        queue247.add(guild.id);
        if (!riffy.players.get(guild.id)) riffy.createConnection({ guildId: guild.id, voiceChannel: member.voice.channel.id, textChannel: channel.id, deaf: true });
        await interaction.reply({ components: [createSimpleContainer('24/7 Enabled', 'Bot will stay in VC forever', '✅')], flags: MessageFlags.IsComponentsV2 });
      }
    }

    else if (commandName === 'autoplay') {
      const p = riffy.players.get(guild.id);
      if (!p) return interaction.reply({ content: '❌ No active player', ephemeral: true });
      autoplayEnabled.has(guild.id) ? autoplayEnabled.delete(guild.id) : autoplayEnabled.add(guild.id);
      const on = autoplayEnabled.has(guild.id);
      await interaction.reply({ components: [createSimpleContainer(on ? 'Autoplay ON' : 'Autoplay OFF', on ? 'Similar songs will auto-play' : 'Autoplay disabled', on ? '✅' : '❌')], flags: MessageFlags.IsComponentsV2 });
    }

    else if (commandName === 'filter') {
      const p = getPlayer(); if (!p) return;
      const name = options.getString('name');
      if (!FILTERS[name]) return interaction.reply({ content: `❌ Unknown filter: \`${name}\``, ephemeral: true });
      if (!activeFilters.has(guild.id)) activeFilters.set(guild.id, new Set());
      const fSet = activeFilters.get(guild.id);
      if (fSet.has(name)) {
        fSet.delete(name);
        await clearFilters(p);
        for (const fn of fSet) await applyFilter(p, fn);
        await interaction.reply({ components: [createSimpleContainer('Filter Removed', `\`${name}\` disabled`, '🎛️')], flags: MessageFlags.IsComponentsV2 });
      } else {
        fSet.add(name);
        const ok = await applyFilter(p, name);
        if (!ok) { fSet.delete(name); return interaction.reply({ content: '❌ Failed to apply filter.', ephemeral: true }); }
        await interaction.reply({ components: [createSimpleContainer('Filter Applied', `\`${name}\` enabled! 🎵\nActive: ${[...fSet].map(f => `\`${f}\``).join(' ')}`, '🎛️')], flags: MessageFlags.IsComponentsV2 });
      }
      if (p.current) { const nm = nowPlayingMsgs.get(guild.id); if (nm) await nm.edit({ components: [createNowPlayingContainer(p, p.current)], flags: MessageFlags.IsComponentsV2 }).catch(() => {}); }
    }

    else if (commandName === 'clearfilters') {
      const p = getPlayer(); if (!p) return;
      await clearFilters(p);
      await interaction.reply({ components: [createSimpleContainer('Filters Cleared', 'All audio effects removed', '🎛️')], flags: MessageFlags.IsComponentsV2 });
      if (p.current) { const nm = nowPlayingMsgs.get(guild.id); if (nm) await nm.edit({ components: [createNowPlayingContainer(p, p.current)], flags: MessageFlags.IsComponentsV2 }).catch(() => {}); }
    }

    else if (commandName === 'lyrics') {
      await interaction.deferReply({ ephemeral: true });
      await handleLyrics(guild.id, options.getString('query') ?? null, d => interaction.editReply(d));
    }

    else if (commandName === 'history') {
      await interaction.reply({ components: [createHistoryContainer(guild.id)], flags: MessageFlags.IsComponentsV2, ephemeral: true });
    }

    else if (commandName === 'djrole') {
      if (!member.permissions.has('Administrator')) return interaction.reply({ content: '❌ Admin only', ephemeral: true });
      const role = options.getRole('role');
      if (role) { djRoles.set(guild.id, role.id); await interaction.reply({ components: [createSimpleContainer('DJ Role Set', `<@&${role.id}> can now control music`, '🛡️')], flags: MessageFlags.IsComponentsV2 }); }
      else { djRoles.delete(guild.id); await interaction.reply({ components: [createSimpleContainer('DJ Role Removed', 'Everyone can control music now', '🛡️')], flags: MessageFlags.IsComponentsV2 }); }
    }

    else if (commandName === 'stats') { await interaction.reply({ components: [createStatsContainer()], flags: MessageFlags.IsComponentsV2 }); }
    else if (commandName === 'ping')  { await interaction.reply({ components: [createSimpleContainer('Pong! 🏓', `WebSocket: **${client.ws.ping}ms**`, '📶')], flags: MessageFlags.IsComponentsV2 }); }

    else if (commandName === 'invite') {
      const url = `https://discord.com/api/oauth2/authorize?client_id=${client.user.id}&permissions=3165184&scope=bot%20applications.commands`;
      await interaction.reply({ components: [new ContainerBuilder().addSectionComponents(new SectionBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent(`## ✅ Invite ${client.user.username}\n[Click here to add me!](${url})`)).setThumbnailAccessory(new ThumbnailBuilder().setURL(client.user.displayAvatarURL({ size: 1024 })).setDescription('Invite'))).addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)).addActionRowComponents(new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel('Invite Me').setStyle(ButtonStyle.Link).setURL(url)))], flags: MessageFlags.IsComponentsV2 });
    }

    else if (commandName === 'support') {
      await interaction.reply({ components: [new ContainerBuilder().addSectionComponents(new SectionBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent(`## ℹ️ Support Server\n[Join our support server](${config.supportServer})`)).setThumbnailAccessory(new ThumbnailBuilder().setURL(client.user.displayAvatarURL({ size: 1024 })).setDescription('Support'))).addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)).addActionRowComponents(new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel('Support Server').setStyle(ButtonStyle.Link).setURL(config.supportServer)))], flags: MessageFlags.IsComponentsV2 });
    }

    else if (commandName === 'help') { await interaction.reply({ components: [createHelpContainer()], flags: MessageFlags.IsComponentsV2 }); }

  } catch (e) {
    console.error(`[Slash /${commandName}]`, e.message ?? e);
    const errPayload = { content: '❌ An error occurred. Please try again.', ephemeral: true };
    if (interaction.deferred)      await interaction.editReply(errPayload).catch(() => {});
    else if (!interaction.replied) await interaction.reply(errPayload).catch(() => {});
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  MENTION COMMANDS  @BOT <command>
// ══════════════════════════════════════════════════════════════════════════════

client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;
  const mentionRx = new RegExp(`^<@!?${client.user.id}>\\s*`);
  if (!mentionRx.test(message.content.trim())) return;
  const args    = message.content.trim().replace(mentionRx, '').trim().split(/\s+/);
  const command = args[0]?.toLowerCase();
  const rest    = args.slice(1).join(' ').trim();
  const reply = (title, desc, emoji = '✅') =>
    message.reply({ components: [createSimpleContainer(title, desc, emoji)], flags: MessageFlags.IsComponentsV2 }).catch(() => {});

  try {
    if (command === 'join') {
      if (!message.member.voice?.channel) return reply('Error', 'Join a voice channel first!', '❌');
      const existing = riffy.players.get(message.guild.id);
      if (existing) return reply('Already Connected', `Already in <#${existing.voiceChannel}>`, 'ℹ️');
      riffy.createConnection({ guildId: message.guild.id, voiceChannel: message.member.voice.channel.id, textChannel: message.channel.id, deaf: true });
      return reply('Joined', `Connected to **${message.member.voice.channel.name}** 🎤`);
    }

    if (['leave','disconnect','dc'].includes(command)) {
      const p = riffy.players.get(message.guild.id);
      if (!p) return reply('Error', 'Not in a voice channel.', '❌');
      nowPlayingMsgs.delete(message.guild.id); queue247.delete(message.guild.id); activeFilters.delete(message.guild.id);
      try { p.destroy(); } catch (_) {}
      return reply('Left', 'Disconnected 👋');
    }

    if (['previous','prev','back'].includes(command)) {
      const p = riffy.players.get(message.guild.id);
      if (!p) return reply('Error', 'Nothing playing.', '❌');
      if (!message.member.voice?.channel || message.member.voice.channel.id !== p.voiceChannel) return reply('Error', 'Join the bot\'s voice channel!', '❌');
      if (!hasDJPermission(message.member, message.guild.id)) return reply('Error', 'DJ role required!', '❌');
      await handlePrevious(p, message.author.id, async (msg) => reply('Previous', msg, '⏮️'));
      return;
    }

    if (command === 'skip' || command === 's') {
      const p = riffy.players.get(message.guild.id);
      if (!p) return reply('Error', 'Nothing playing.', '❌');
      if (!message.member.voice?.channel || message.member.voice.channel.id !== p.voiceChannel) return reply('Error', 'Join the bot\'s voice channel!', '❌');
      if (!hasDJPermission(message.member, message.guild.id)) return reply('Error', 'DJ role required!', '❌');
      if (!p.current) return reply('Error', 'Nothing playing.', '❌');
      p.stop();
      return reply('Skipped', 'Skipped ⏭️');
    }

    if (command === 'pause' || command === 'pa') {
      const p = riffy.players.get(message.guild.id);
      if (!p?.current) return reply('Error', 'Nothing playing.', '❌');
      await p.pause(true);
      return reply('Paused', 'Paused ⏸️');
    }

    if (command === 'resume' || command === 'r') {
      const p = riffy.players.get(message.guild.id);
      if (!p) return reply('Error', 'Nothing playing.', '❌');
      await p.pause(false);
      return reply('Resumed', 'Resumed ▶️');
    }

    if (command === 'stop' || command === 'st') {
      const p = riffy.players.get(message.guild.id);
      if (!p) return reply('Error', 'Nothing playing.', '❌');
      if (!hasDJPermission(message.member, message.guild.id)) return reply('Error', 'DJ role required!', '❌');
      nowPlayingMsgs.delete(message.guild.id); activeFilters.delete(message.guild.id);
      try { p.destroy(); } catch (_) {}
      return reply('Stopped', 'Stopped ⏹️');
    }

    if (command === 'np' || command === 'nowplaying') {
      const p = riffy.players.get(message.guild.id);
      if (!p?.current) return reply('Error', 'Nothing playing.', '❌');
      return message.reply({ components: [createNowPlayingContainer(p, p.current)], flags: MessageFlags.IsComponentsV2 }).catch(() => {});
    }

    if (command === 'queue' || command === 'q') {
      const p = riffy.players.get(message.guild.id);
      if (!p) return reply('Error', 'Nothing playing.', '❌');
      return message.reply({ components: [createQueueContainer(p)], flags: MessageFlags.IsComponentsV2 }).catch(() => {});
    }

    if (command === 'play' || command === 'p' || !command) {
      const query = rest || (command !== 'play' && command !== 'p' ? args.join(' ') : '');
      if (!query) return reply('Usage', `\`@${client.user.username} play <song name or URL>\``, 'ℹ️');
      if (!message.member.voice?.channel) return reply('Error', 'Join a voice channel first!', '❌');
      const sent = await message.reply({ components: [createSimpleContainer('Searching', `🔍 **${query}**...`, 'ℹ️')], flags: MessageFlags.IsComponentsV2 }).catch(() => null);
      const editR = async (data) => {
        if (!sent) return;
        if (typeof data === 'string') return sent.edit({ content: data, components: [] }).catch(() => {});
        return sent.edit({ content: '', ...data }).catch(() => {});
      };
      await handlePlay(message.guild.id, message.member.voice.channel.id, message.channel.id, query, message.author.id,
        async msg => { if (!sent) return; if (typeof msg === 'string') return sent.edit({ content: msg, components: [] }).catch(() => {}); return sent.edit({ content: '', ...msg }).catch(() => {}); },
        editR
      );
      return;
    }

    if (command === 'help' || command === 'h') {
      return message.reply({
        components: [createSimpleContainer('Mention Commands',
          `**@${client.user.username} join** — Join VC\n` +
          `**@${client.user.username} leave** — Leave VC\n` +
          `**@${client.user.username} play <song>** — Play\n` +
          `**@${client.user.username} previous** — Previous track\n` +
          `**@${client.user.username} skip** — Skip\n` +
          `**@${client.user.username} pause** — Pause\n` +
          `**@${client.user.username} resume** — Resume\n` +
          `**@${client.user.username} stop** — Stop\n` +
          `**@${client.user.username} np** — Now Playing\n` +
          `**@${client.user.username} queue** — Queue\n\n` +
          `💡 Use \`/help\` for all slash commands!`, 'ℹ️')],
        flags: MessageFlags.IsComponentsV2
      }).catch(() => {});
    }

  } catch (e) {
    console.error('[Mention]', e.message ?? e);
    message.reply(`❌ Error: ${e.message}`).catch(() => {});
  }
});

// ─── Login ────────────────────────────────────────────────────────────────────
client.login(config.token);
