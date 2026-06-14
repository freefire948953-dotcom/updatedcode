// spotify.js — SKY x MUSIC BOT
'use strict';

let _spotifyClient = null;

function init({ spotifyClient }) {
  _spotifyClient = spotifyClient || null;
}

function setClient(client) { _spotifyClient = client; }
function getClient() { return _spotifyClient; }

function isSpotifyUrl(str) {
  return /open\.spotify\.com\/(track|playlist|album)\/.+/i.test(str) ||
         /spotify:(track|playlist|album):/i.test(str);
}

function isYouTubeUrl(str) {
  return /^(?:https?:\/\/)?(?:www\.)?(?:music\.)?(?:youtube\.com|youtu\.be)\/.+/i.test(String(str));
}

function isSoundCloudUrl(str) {
  return /soundcloud\.com\/.+/i.test(str);
}

function getSpotifyUrlType(str) {
  const input = String(str || '');
  const webMatch = input.match(/open\.spotify\.com\/(track|playlist|album)\//i);
  if (webMatch) return webMatch[1].toLowerCase();
  const uriMatch = input.match(/spotify:(track|playlist|album):/i);
  if (uriMatch) return uriMatch[1].toLowerCase();
  return null;
}

function normalizeSpotifyTrack(raw) {
  const t = raw && (raw.track || raw);
  if (!t) return null;

  const name = String(t.name || t.title || '').trim();
  if (!name) {
    console.warn('[spotify] Skipping track with no name:', JSON.stringify(t).slice(0, 200));
    return null;
  }

  const artists = [];
  if (Array.isArray(t.artists)) {
    for (const a of t.artists) {
      if (!a) continue;
      const v = typeof a === 'string' ? a : (a.name || a.title || '');
      if (v) artists.push(String(v).trim());
    }
  } else if (t.artist) {
    const v = typeof t.artist === 'string' ? t.artist : (t.artist.name || t.artist.title || '');
    if (v) artists.push(String(v).trim());
  }

  const artistText   = artists.filter(Boolean).join(', ');
  const primaryArtist = artists.find(Boolean) || '';
  const title  = artistText ? `${name} - ${artistText}` : name;
  const search = primaryArtist ? `"${name}" "${primaryArtist}"` : `"${name}"`;

  return { title, search, spotifyTitle: name, spotifyArtist: primaryArtist || artistText || '' };
}

async function spotifyGetData(url) {
  if (!_spotifyClient) return null;
  if (typeof _spotifyClient.getData === 'function') return _spotifyClient.getData(url);
  if (typeof _spotifyClient === 'function') return _spotifyClient(url);
  return null;
}

async function spotifyGetTracks(url, data) {
  if (_spotifyClient && typeof _spotifyClient.getTracks === 'function') {
    const tracks = await _spotifyClient.getTracks(url).catch(err => {
      console.error('[spotify] getTracks() failed:', err?.message ?? err);
      return [];
    });
    if (Array.isArray(tracks) && tracks.length > 0) return tracks;
  }
  if (Array.isArray(data?.tracks)   && data.tracks.length   > 0) return data.tracks;
  if (Array.isArray(data?.trackList) && data.trackList.length > 0) return data.trackList;
  if (Array.isArray(data?.items)    && data.items.length    > 0) {
    return data.items.map(it => it && (it.track || it)).filter(Boolean);
  }
  return [];
}

// replyFn accepts a plain string message — index.js converts it to Components V2
async function handleSpotify(query, guildId, textChannelId, requestedBy, replyFn, player) {
  if (!isSpotifyUrl(query)) return { handled: false };

  if (!_spotifyClient) {
    await replyFn('⚠️ Spotify client is still initializing. Please try again in a few seconds.');
    return { handled: true };
  }

  try {
    const type = getSpotifyUrlType(query);

    let data = null;
    try {
      data = await spotifyGetData(query);
    } catch (err) {
      console.error('[spotify] spotifyGetData failed:', err?.message ?? err);
    }

    if (!data && type === 'track') {
      await replyFn('❌ Could not fetch data from Spotify. Make sure the link is valid and try again.');
      return { handled: true };
    }

    // ── Playlist / Album ──────────────────────────────────────────
    if (type === 'playlist' || type === 'album') {
      const tracks = await spotifyGetTracks(query, data);
      const MAX_QUEUE = 500;
      const limit = Math.min(MAX_QUEUE, tracks.length);
      const items = [];
      let skipped = 0;

      for (let i = 0; i < limit; i++) {
        const t = normalizeSpotifyTrack(tracks[i]);
        if (!t) { skipped++; continue; }
        items.push({
          title: t.title, search: t.search,
          spotifyTitle: t.spotifyTitle, spotifyArtist: t.spotifyArtist,
          sourceHint: 'spotify', strictSearch: true,
          requestedBy, textChannelId,
        });
      }

      if (skipped > 0) console.warn(`[spotify] Skipped ${skipped} track(s) with missing data`);

      if (items.length === 0) {
        await replyFn('⚠️ This Spotify playlist/album has no processable tracks.');
        return { handled: true };
      }

      await player.enqueue(guildId, items);
      const label = type === 'album' ? 'album' : 'playlist';
      await replyFn(`✅ Added **${items.length}** tracks from Spotify ${label} to the queue.`);
      return { handled: true };
    }

    // ── Single Track ──────────────────────────────────────────────
    const normalized = normalizeSpotifyTrack(data?.track || data);
    if (normalized) {
      await player.enqueue(guildId, {
        title: normalized.title, search: normalized.search,
        spotifyTitle: normalized.spotifyTitle, spotifyArtist: normalized.spotifyArtist,
        sourceHint: 'spotify', strictSearch: true,
        requestedBy, textChannelId,
      });
      await replyFn(`✅ Added **${normalized.title}** (Spotify → YouTube Music) to the queue.`);
      return { handled: true };
    }

    await replyFn('⚠️ Could not process this Spotify link. Make sure it is a valid track/playlist/album URL.');
    return { handled: true };

  } catch (err) {
    console.error('[spotify] Parse error:', err?.message ?? err);
    await replyFn('❌ Failed to process the Spotify link.');
    return { handled: true };
  }
}

module.exports = {
  init, setClient, getClient,
  isSpotifyUrl, isYouTubeUrl, isSoundCloudUrl,
  getSpotifyUrlType, normalizeSpotifyTrack,
  handleSpotify,
};
