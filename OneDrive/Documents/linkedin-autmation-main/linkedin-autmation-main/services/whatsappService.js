const { Client, LocalAuth } = require('whatsapp-web.js');

class WhatsAppService {
  constructor() {
    this.client = null;
    this.ready = false;
  }

  async initialize() {
    try {
      if (this.client) return;
      this.client = new Client({
        authStrategy: new LocalAuth({ clientId: 'linkedin-automator', dataPath: process.env.WHATSAPP_SESSION_PATH || './whatsapp-session' })
      });

      this.client.on('ready', () => {
        this.ready = true;
        console.log('WhatsApp service ready');
      });

      this.client.on('auth_failure', (m) => {
        this.ready = false;
        console.error('WhatsApp auth failure:', m);
      });

      this.client.on('disconnected', () => {
        this.ready = false;
        console.warn('WhatsApp disconnected');
      });

      await this.client.initialize();
    } catch (error) {
      console.error('WhatsApp service initialization error:', error);
    }
  }

  async sendMessage(to, message) {
    if (!this.client || !this.ready) {
      throw new Error('WhatsApp service not ready');
    }
    // Ensure phone number format for WhatsApp Web (International format + country code)
    const jid = to.includes('@c.us') ? to : `${to.replace(/[^\d]/g, '')}@c.us`;
    return this.client.sendMessage(jid, message);
  }
}

module.exports = WhatsAppService;


