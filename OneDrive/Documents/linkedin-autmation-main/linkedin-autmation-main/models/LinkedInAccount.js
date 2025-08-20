const mongoose = require('mongoose');

const linkedInAccountSchema = new mongoose.Schema({
  label: {
    type: String,
    required: true,
    trim: true
  },
  loginEmail: {
    type: String,
    trim: true
  },
  sessionCookies: {
    type: String,
    trim: true
  },
  isActive: {
    type: Boolean,
    default: true
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  lastUsedAt: Date,
  notes: String
}, {
  timestamps: true
});

module.exports = mongoose.model('LinkedInAccount', linkedInAccountSchema);


