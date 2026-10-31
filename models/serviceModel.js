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
}, { _id: false });

const serviceSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  category: {
    type: String,
    default: 'Uncategorized'
  },
  url: {
    type: String,
    required: true
  },
  type: {
    type: String,
    enum: ['website', 'ip', 'minecraft', 'tcp', 'udp'],
    required: true
  },
  port: {
    type: Number,
    default: null
  },
  currentStatus: {
    type: String,
    enum: ['online', 'offline', 'maintenance', 'unknown'],
    default: 'unknown'
  },
  webhookURL: {
    type: String,
    default: null
  },
  maintenance: {
    type: Boolean,
    default: false
  },
  tooltip: {
    type: String,
    default: null
  },
  lastResponseTime: {
    type: Number,
    default: 0
  },
  history: [historyEntrySchema]
}, {
  timestamps: true
});

const Service = mongoose.model('service', serviceSchema);

module.exports = Service;