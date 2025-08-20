const mongoose = require('mongoose');

const automationSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  description: {
    type: String,
    trim: true
  },
  type: {
    type: String,
    enum: ['connection_request', 'message_send', 'follow_up', 'campaign'],
    required: true
  },
  status: {
    type: String,
    enum: ['draft', 'active', 'paused', 'completed', 'failed'],
    default: 'draft'
  },
  searchCriteria: {
    keywords: [String],
    location: String,
    industry: String,
    companySize: {
      type: String,
      enum: ['1-10', '11-50', '51-200', '201-500', '501-1000', '1000+']
    },
    jobTitle: [String],
    connectionDegree: {
      type: String,
      enum: ['1st', '2nd', '3rd+']
    }
  },
  schedule: {
    frequency: {
      type: String,
      enum: ['daily', 'weekly', 'monthly'],
      default: 'daily'
    },
    time: {
      type: String,
      default: '09:00'
    },
    daysOfWeek: [{
      type: Number,
      min: 0,
      max: 6
    }],
    isActive: {
      type: Boolean,
      default: true
    }
  },
  limits: {
    daily: {
      type: Number,
      default: 50
    },
    total: {
      type: Number,
      default: 1000
    },
    current: {
      type: Number,
      default: 0
    }
  },
  templates: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Template'
  }],
  channels: {
    linkedin: {
      type: Boolean,
      default: true
    },
    email: {
      type: Boolean,
      default: false
    },
    whatsapp: {
      type: Boolean,
      default: false
    },
    sms: {
      type: Boolean,
      default: false
    }
  },
  account: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'LinkedInAccount'
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  stats: {
    totalRequests: {
      type: Number,
      default: 0
    },
    totalMessages: {
      type: Number,
      default: 0
    },
    acceptedRequests: {
      type: Number,
      default: 0
    },
    responses: {
      type: Number,
      default: 0
    }
  }
}, {
  timestamps: true
});

// Check if automation can run
automationSchema.methods.canRun = function() {
  if (this.status !== 'active') return false;
  if (this.stats.totalRequests >= this.limits.total) return false;
  if (this.stats.totalRequests >= this.limits.daily) return false;
  return true;
};

module.exports = mongoose.model('Automation', automationSchema); 