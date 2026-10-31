const mongoose = require('mongoose');

const historyEntrySchema = new mongoose.Schema({
  status: {
    type: String,
    enum: ['online', 'offline', 'maintenance', 'unknown'],
    required: true
  },
  timestamp: {
    type: Date,
    required: true,
    default: Date.now
  },
  responseTime: {
    type: Number,
    default: null
  },
  duration: {
    type: Number,
    default: null
  }
});

const History = mongoose.model('history', historyEntrySchema);

module.exports = History;