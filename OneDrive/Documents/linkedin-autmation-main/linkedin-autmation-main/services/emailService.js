const nodemailer = require('nodemailer');
const Template = require('../models/Template');

class EmailService {
  constructor() {
    this.transporter = null;
  }

  async initializeTransporter() {
    try {
      this.transporter = nodemailer.createTransport({
        host: process.env.EMAIL_HOST,
        port: parseInt(process.env.EMAIL_PORT) || 587,
        secure: false, // true for 465, false for other ports
        auth: {
          user: process.env.EMAIL_USER,
          pass: process.env.EMAIL_PASS
        }
      });

      // Verify connection
      await this.transporter.verify();
      console.log('Email service initialized');
      return true;
    } catch (error) {
      console.error('Email service initialization error:', error);
      throw error;
    }
  }

  async sendEmail(to, subject, message, options = {}) {
    try {
      if (!this.transporter) {
        await this.initializeTransporter();
      }

      const mailOptions = {
        from: options.from || process.env.EMAIL_USER,
        to: to,
        subject: subject,
        html: message,
        ...options
      };

      const result = await this.transporter.sendMail(mailOptions);
      console.log('Email sent successfully:', result.messageId);
      return result;
    } catch (error) {
      console.error('Send email error:', error);
      throw error;
    }
  }

  async sendTemplateEmail(to, templateId, variables = {}, language = 'en') {
    try {
      // Get template
      const template = await Template.findById(templateId);
      if (!template) {
        throw new Error('Template not found');
      }

      if (!template.channels.email) {
        throw new Error('Template not configured for email');
      }

      // Get message and subject from template
      const message = template.getMessage(language, variables);
      const subject = template.getSubject(language, variables);

      if (!message) {
        throw new Error('No message content found in template');
      }

      // Send email
      return await this.sendEmail(to, subject || 'New Message', message);
    } catch (error) {
      console.error('Send template email error:', error);
      throw error;
    }
  }

  async sendBulkEmails(recipients, templateId, variables = {}, language = 'en') {
    try {
      const results = [];
      const errors = [];

      for (const recipient of recipients) {
        try {
          const result = await this.sendTemplateEmail(
            recipient.email,
            templateId,
            { ...variables, ...recipient.variables },
            language
          );
          results.push({
            email: recipient.email,
            success: true,
            messageId: result.messageId
          });
        } catch (error) {
          errors.push({
            email: recipient.email,
            success: false,
            error: error.message
          });
        }

        // Add delay between emails to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      return {
        results,
        errors,
        total: recipients.length,
        successful: results.length,
        failed: errors.length
      };
    } catch (error) {
      console.error('Send bulk emails error:', error);
      throw error;
    }
  }

  async testConnection() {
    try {
      if (!this.transporter) {
        await this.initializeTransporter();
      }

      const testEmail = {
        from: process.env.EMAIL_USER,
        to: process.env.EMAIL_USER, // Send to self for testing
        subject: 'LinkedIn Automator - Connection Test',
        html: '<p>This is a test email to verify the email service is working correctly.</p>'
      };

      const result = await this.transporter.sendMail(testEmail);
      return {
        success: true,
        messageId: result.messageId,
        message: 'Email service connection successful'
      };
    } catch (error) {
      console.error('Email connection test error:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async getEmailStatus(messageId) {
    try {
      // This would require additional setup with email providers
      // For now, return a basic status
      return {
        messageId,
        status: 'sent',
        timestamp: new Date()
      };
    } catch (error) {
      console.error('Get email status error:', error);
      throw error;
    }
  }
}

module.exports = EmailService; 