// embeds.js — SKY x MUSIC BOT (legacy helper, kept for compatibility)
'use strict';
const { EmbedBuilder } = require('discord.js');

function makeEmbed(title, description, color = 0x1DB954) {
  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(color);
}

module.exports = { makeEmbed };
