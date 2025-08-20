const Automation = require('../models/Automation');
const Activity = require('../models/Activity');
const Template = require('../models/Template');
const LinkedInAccount = require('../models/LinkedInAccount');
const EmailService = require('./emailService');
const SMSService = require('./smsService');
const WhatsAppService = require('./whatsappService');
const LinkedInService = require('./linkedinService');
const Notification = require('../models/Notification');

const DEFAULT_POLL_MS = parseInt(process.env.AUTOMATION_POLL_MS || '180000'); // 3 minutes
const MAX_NEW_CONNECTIONS_PER_RUN = 10;

class AutomationEngine {
  constructor() {
    this.intervalHandle = null;
    this.accountIdToLinkedin = new Map();
    this.emailService = new EmailService();
    this.smsService = new SMSService();
    this.whatsappService = new WhatsAppService();
    this.running = false;
    this.lastRunAt = null;
  }

  async ensureLinkedInLoggedInForAccount(account) {
    let svc = this.accountIdToLinkedin.get(String(account._id));
    if (!svc) {
      svc = new LinkedInService();
      await svc.initialize();
      this.accountIdToLinkedin.set(String(account._id), svc);
    }

    if (account.sessionCookies) {
      await svc.loginWithCookies(account.sessionCookies);
      return svc;
    }

    // Fallback to env credentials
    if (process.env.LINKEDIN_EMAIL && process.env.LINKEDIN_PASSWORD) {
      await svc.login(process.env.LINKEDIN_EMAIL, process.env.LINKEDIN_PASSWORD);
      return svc;
    }

    throw new Error('No LinkedIn session cookies or env credentials available');
  }

  async sendFollowUpsForAccepted(activity, automation) {
    // Find a template suitable for each channel
    const templates = await Template.find({ _id: { $in: automation.templates } });
    const pickTemplateFor = (channel) => templates.find(t => t.channels && t.channels[channel]);

    const variables = {
      firstName: (activity.target?.name || '').split(' ')[0] || '',
      fullName: activity.target?.name || ''
    };

    // LinkedIn message
    try {
      if (automation.channels?.linkedin) {
        const t = pickTemplateFor('linkedin') || templates[0];
        if (t) {
          const message = t.getMessage('en', variables);
          const account = await LinkedInAccount.findById(automation.account);
          const li = await this.ensureLinkedInLoggedInForAccount(account);
          await li.sendMessage(activity.target.profileUrl, message);
          await activity.updateStatus('sent', { channel: 'linkedin' });
        }
      }
    } catch (e) {
      // log and continue other channels
    }

    // Email
    try {
      if (automation.channels?.email && activity.target?.email) {
        const t = pickTemplateFor('email') || templates[0];
        if (t) {
          await this.emailService.sendTemplateEmail(activity.target.email, t._id, variables, 'en');
        }
      }
    } catch (e) {}

    // WhatsApp (via Twilio WhatsApp or whatsapp-web.js)
    try {
      if (automation.channels?.whatsapp && activity.target?.phone) {
        const t = pickTemplateFor('whatsapp') || templates[0];
        if (t) {
          const msg = t.getMessage('en', variables);
          await this.whatsappService.sendMessage(activity.target.phone, msg);
        }
      }
    } catch (e) {}

    // SMS fallback (Twilio SMS) if configured and phone present and sms channel enabled
    try {
      if (automation.channels?.sms && activity.target?.phone) {
        const t = pickTemplateFor('sms') || templates[0];
        if (t) {
          const msg = t.getMessage('en', variables);
          await this.smsService.sendSMS(activity.target.phone, msg);
        }
      }
    } catch (e) {}
  }

  async processAutomationsOnce() {
    this.lastRunAt = new Date();
    // Get active automations
    const automations = await Automation.find({ status: 'active' }).populate('account').lean(false);

    for (const automation of automations) {
      try {
        // Respect daily limits: count connection requests sent in last 24h
        const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const sentToday = await Activity.countDocuments({
          automation: automation._id,
          type: 'connection_request',
          channel: 'linkedin',
          status: { $in: ['sent', 'pending'] },
          createdAt: { $gte: since }
        });
        const remaining = Math.max(0, (automation.limits?.daily || 50) - sentToday);

        // Send new connection requests based on search criteria
        if (remaining > 0 && automation.account) {
          try {
            const li = await this.ensureLinkedInLoggedInForAccount(automation.account);
            const criteria = automation.searchCriteria || {};
            const peopleResults = await li.searchPeople(criteria);
            const postResults = await li.searchPosts(criteria);
            const peopleFromPosts = (postResults || []).map(p => ({
              name: p.authorName,
              profileUrl: p.authorProfileUrl,
              title: '',
              company: '',
              location: '',
              linkedinId: p.authorLinkedinId
            }));
            const people = [...peopleResults, ...peopleFromPosts];

            let sentCount = 0;
            for (const person of people) {
              if (sentCount >= Math.min(remaining, MAX_NEW_CONNECTIONS_PER_RUN)) break;

              const exists = await Activity.findOne({
                automation: automation._id,
                'target.linkedinId': person.linkedinId
              }).lean();
              if (exists) continue;

              try {
                await li.sendConnectionRequest(person.profileUrl, '');
                await Activity.create({
                  automation: automation._id,
                  user: automation.createdBy,
                  type: 'connection_request',
                  status: 'sent',
                  target: {
                    name: person.name,
                    profileUrl: person.profileUrl,
                    company: person.company,
                    jobTitle: person.title,
                    linkedinId: person.linkedinId
                  },
                  channel: 'linkedin'
                });
                sentCount += 1;
              } catch (e) {
                // continue
              }
            }
          } catch (e) {
            // Could not login or search
          }
        }

        // Check accepted connections and send follow-ups
        const pending = await Activity.find({
          automation: automation._id,
          type: 'connection_request',
          status: 'sent'
        });
        if (pending.length && automation.account) {
          const li = await this.ensureLinkedInLoggedInForAccount(automation.account);
          for (const act of pending) {
            try {
              const status = await li.checkConnectionStatus(act.target.profileUrl);
              if (status === 'connected') {
                act.status = 'accepted';
                await act.save();
                // Fetch contact info first
                try {
                  const info = await li.fetchContactInfo(act.target.profileUrl);
                  if (info?.email) act.target.email = info.email;
                  if (info?.phone) act.target.phone = info.phone;
                  await act.save();
                } catch (_) {}

                await this.sendFollowUpsForAccepted(act, automation);

                // Notify owner
                try {
                  await Notification.create({
                    user: automation.createdBy,
                    type: 'connection_accepted',
                    title: 'Connection accepted',
                    message: `${act.target?.name || 'A lead'} accepted your connection request`,
                    data: { automationId: automation._id, activityId: act._id, target: act.target }
                  });
                } catch (_) {}
              }
            } catch (e) {
              // skip
            }
          }
        }
      } catch (err) {
        // continue next automation
      }
    }
  }

  start() {
    if (this.intervalHandle) return;
    // Initialize WhatsApp (if session available)
    this.whatsappService.initialize().catch(() => {});
    this.intervalHandle = setInterval(() => {
      this.processAutomationsOnce().catch(() => {});
    }, DEFAULT_POLL_MS);
    // Also run immediately on start
    this.processAutomationsOnce().catch(() => {});
    console.log('Automation engine started');
    this.running = true;
  }

  stop() {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
      console.log('Automation engine stopped');
    }
    this.running = false;
  }

  status() {
    return {
      running: this.running,
      lastRunAt: this.lastRunAt,
      pollMs: DEFAULT_POLL_MS
    };
  }
}

module.exports = new AutomationEngine();


