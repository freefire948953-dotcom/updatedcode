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
  logsChannelId: process.env.LOGS_CHANNEL_ID || '',

  // ─── Express Keep-Alive ────────────────────────────────────────
  express: {
    enabled: true,
    port: process.env.PORT || 5000
  },

  // ─── Lavalink ──────────────────────────────────────────────────
  // Sirf Main Node (serenetia public) use ho raha hai.
  // Backup Node (Render self-hosted) hata diya gaya hai kyunki
  // Render free tier ki RAM limit (512MB) Lavalink crash kara rahi thi,
  // jiski wajah se WS handshake 404 aa raha tha aur bot uncaught exception
  // se crash ho raha tha.
  //
  // Agar future mein backup node fix karke wapas add karna ho,
  // toh niche wala block uncomment karo — lekin pehle Render service
  // ko paid/more-RAM plan pe upgrade karna zaroori hai, warna wahi error
  // dobara aayega.
  lavalink: {
    nodes: [
      {
        name: 'Main Node',
        host: '152.53.83.119',
        port: 3005,
        password: 'AeroX',
        secure: false,
        retryAmount: 10,
        retryDelay: 5000
      }

      /*
      {
        name: 'Backup Node',
        host: process.env.LAVALINK_HOST || 'skyxmusic-lavalink.onrender.com',
        port: Number(process.env.LAVALINK_PORT) || 443,
        password: process.env.LAVALINK_PASSWORD || 'skyxmusic123',
        secure: true,
        retryAmount: 10,
        retryDelay: 5000
      }
      */
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
