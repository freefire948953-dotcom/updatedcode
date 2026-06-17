// config.js — SKY x MUSIC BOT
require('dotenv').config();

module.exports = {
  // ─── Bot ───────────────────────────────────────────────────────
  token: process.env.DISCORD_TOKEN,
  prefix: '/',
  enablePrefix: true,
  supportServer: 'https://discord.gg/FqMWA4fucd',

  activity: {
    name: '/help | 🎵 Music',
    type: 'LISTENING'
  },

  // ─── Logs Channel ─────────────────────────────────────────────
  // Apne Discord server ka channel ID daalo
  // Jab koi server bot invite kare → us channel mein log aayega
  // Kaise pata kare: Discord → Settings → Advanced → Developer Mode ON
  // Phir channel pe right click → Copy Channel ID
  logsChannelId: process.env.LOGS_CHANNEL_ID || '',

  // ─── Express Keep-Alive ────────────────────────────────────────
  express: {
    enabled: true,
    port: process.env.PORT || 5000
  },

  // ─── Lavalink ──────────────────────────────────────────────────
  lavalink: {
    nodes: [
      {
        name: 'Main Node',
        host: process.env.LAVALINK_HOST || '89.106.84.172',
        port: Number(process.env.LAVALINK_PORT) || 3004,
        password: process.env.LAVALINK_PASSWORD || 'AeroX',
        secure: false,
        retryAmount: 10,
        retryDelay: 5000
      }
    ]
  },

  // ─── Spotify API Credentials ───────────────────────────────────
  spotify: {
    clientId:     process.env.SPOTIFY_CLIENT_ID     || '',
    clientSecret: process.env.SPOTIFY_CLIENT_SECRET || ''
  },

  // ─── Genius Lyrics API ─────────────────────────────────────────
  genius: {
    token: process.env.GENIUS_TOKEN || ''
  },

  // ─── Emojis ────────────────────────────────────────────────────
  emojis: {
    play: '▶️', pause: '⏸️', stop: '⏹️', skip: '⏭️',
    queue: '📋', music: '🎵', loop: '🔁', shuffle: '🔀',
    volume: '🔊', success: '✅', error: '❌', info: 'ℹ️',
    filter: '🎛️', history: '🕒', lyrics: '📝'
  },

  // ─── Command Aliases ───────────────────────────────────────────
  aliases: {
    play:       ['p'],
    pause:      ['pa'],
    resume:     ['r', 'res'],
    skip:       ['s', 'next'],
    stop:       ['st', 'leave', 'disconnect', 'dc'],
    volume:     ['v', 'vol'],
    queue:      ['q'],
    nowplaying: ['np', 'current'],
    shuffle:    ['sh', 'mix'],
    loop:       ['l', 'repeat'],
    remove:     ['rm', 'delete'],
    move:       ['mv'],
    clearqueue: ['cq', 'clear'],
    '247':      ['24/7', 'stay'],
    stats:      ['status', 'info'],
    ping:       ['latency'],
    invite:     ['inv'],
    support:    ['server'],
    help:       ['h', 'commands', 'cmd']
  }
};
