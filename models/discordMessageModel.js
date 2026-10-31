const mongoose = require('mongoose');

const discordMessageSchema = new mongoose.Schema({
  messageId: {
    type: String,
    required: true
  },
  channelId: {
    type: String,
    required: true
  },
  lastSaved: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

const DiscordMessage = mongoose.model('discordMessage', discordMessageSchema);

module.exports = DiscordMessage;