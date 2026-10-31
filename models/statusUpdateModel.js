const mongoose = require('mongoose');

const statusUpdateSchema = new mongoose.Schema({
  lastUpdated: {
    type: Date,
    required: true,
    default: Date.now
  },
  overallStatus: {
    type: String,
    enum: ['online', 'offline', 'partial', 'maintenance'],
    default: 'unknown'
  },
  onlineServices: {
    type: Number,
    default: 0
  },
  totalServices: {
    type: Number,
    default: 0
  }
}, {
  timestamps: true
});

const status = mongoose.model('statusUpdate', statusUpdateSchema);

module.exports = status;