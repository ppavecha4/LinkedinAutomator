const puppeteer = require('puppeteer');

class LinkedInService {
  constructor() {
    this.browser = null;
    this.page = null;
    this.isLoggedIn = false;
  }

  async initialize() {
    try {
      this.browser = await puppeteer.launch({
        headless: false, // Set to true in production
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--disable-gpu'
        ]
      });

      this.page = await this.browser.newPage();
      
      // Set user agent to avoid detection
      await this.page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
      
      // Set viewport
      await this.page.setViewport({ width: 1366, height: 768 });
      
      console.log('LinkedIn service initialized');
      return true;
    } catch (error) {
      console.error('LinkedIn service initialization error:', error);
      throw error;
    }
  }

  async loginWithCookies(cookieString) {
    try {
      if (!this.page) {
        throw new Error('LinkedIn service not initialized');
      }

      // Navigate to base domain first to set cookies
      await this.page.goto('https://www.linkedin.com', { waitUntil: 'domcontentloaded' });

      const cookies = (cookieString || '')
        .split(';')
        .map(s => s.trim())
        .filter(Boolean)
        .map(kv => {
          const idx = kv.indexOf('=');
          const name = kv.substring(0, idx).trim();
          const value = kv.substring(idx + 1).trim().replace(/^"|"$/g, '');
          return {
            name,
            value,
            domain: '.linkedin.com',
            path: '/',
            httpOnly: false,
            secure: true
          };
        });

      if (cookies.length > 0) {
        await this.page.setCookie(...cookies);
      }

      await this.page.goto('https://www.linkedin.com/feed/', { waitUntil: 'networkidle2' });
      const currentUrl = this.page.url();
      if (currentUrl.includes('feed')) {
        this.isLoggedIn = true;
        console.log('LinkedIn cookie login successful');
        return true;
      } else {
        throw new Error('Cookie login failed');
      }
    } catch (error) {
      console.error('LinkedIn cookie login error:', error);
      throw error;
    }
  }

  async login(email, password) {
    try {
      if (!this.page) {
        throw new Error('LinkedIn service not initialized');
      }

      // Navigate to LinkedIn login page
      await this.page.goto('https://www.linkedin.com/login', { waitUntil: 'networkidle2' });
      
      // Wait for login form
      await this.page.waitForSelector('#username');
      
      // Fill in credentials
      await this.page.type('#username', email);
      await this.page.type('#password', password);
      
      // Click login button
      await this.page.click('button[type="submit"]');
      
      // Wait for navigation
      await this.page.waitForNavigation({ waitUntil: 'networkidle2' });
      
      // Check if login was successful
      const currentUrl = this.page.url();
      if (currentUrl.includes('feed') || currentUrl.includes('mynetwork')) {
        this.isLoggedIn = true;
        console.log('LinkedIn login successful');
        return true;
      } else {
        throw new Error('Login failed - redirected to login page');
      }
    } catch (error) {
      console.error('LinkedIn login error:', error);
      throw error;
    }
  }

  async searchPeople(criteria) {
    try {
      if (!this.isLoggedIn) {
        throw new Error('Not logged in to LinkedIn');
      }

      const { keywords, location, industry, jobTitle } = criteria;
      
      // Build search URL
      let searchUrl = 'https://www.linkedin.com/search/results/people/?';
      const params = [];
      
      if (keywords && keywords.length > 0) {
        params.push(`keywords=${encodeURIComponent(keywords.join(' '))}`);
      }
      if (location) {
        params.push(`location=${encodeURIComponent(location)}`);
      }
      if (industry) {
        params.push(`industry=${encodeURIComponent(industry)}`);
      }
      if (jobTitle && jobTitle.length > 0) {
        params.push(`title=${encodeURIComponent(jobTitle.join(' '))}`);
      }
      
      searchUrl += params.join('&');
      
      // Navigate to search results
      await this.page.goto(searchUrl, { waitUntil: 'networkidle2' });
      
      // Wait for search results
      await this.page.waitForSelector('.search-result__info', { timeout: 10000 });
      
      // Extract people data
      const people = await this.page.evaluate(() => {
        const results = [];
        const cards = document.querySelectorAll('.search-result__info');
        
        cards.forEach(card => {
          const nameElement = card.querySelector('.search-result__result-link');
          const titleElement = card.querySelector('.search-result__truncate');
          const companyElement = card.querySelector('.search-result__company');
          const locationElement = card.querySelector('.search-result__location');
          
          if (nameElement) {
            results.push({
              name: nameElement.textContent.trim(),
              profileUrl: nameElement.href,
              title: titleElement ? titleElement.textContent.trim() : '',
              company: companyElement ? companyElement.textContent.trim() : '',
              location: locationElement ? locationElement.textContent.trim() : '',
              linkedinId: nameElement.href.split('/in/')[1]?.split('/')[0] || ''
            });
          }
        });
        
        return results;
      });
      
      return people;
    } catch (error) {
      console.error('LinkedIn search error:', error);
      throw error;
    }
  }

  async searchPosts(criteria) {
    try {
      if (!this.isLoggedIn) {
        throw new Error('Not logged in to LinkedIn');
      }

      const { keywords, location, industry, jobTitle } = criteria || {};

      let searchUrl = 'https://www.linkedin.com/search/results/content/?';
      const params = [];
      if (keywords && keywords.length > 0) {
        params.push(`keywords=${encodeURIComponent(Array.isArray(keywords) ? keywords.join(' ') : String(keywords))}`);
      }
      // location/industry/title filters for content are limited; keep keywords-focused
      searchUrl += params.join('&');

      await this.page.goto(searchUrl, { waitUntil: 'networkidle2' });
      // Wait for some post containers to load
      await this.page.waitForSelector('div.reusable-search__result-container, div.search-result__wrapper', { timeout: 10000 });

      const posts = await this.page.evaluate(() => {
        const results = [];
        const containers = document.querySelectorAll('div.reusable-search__result-container, div.search-result__wrapper');
        containers.forEach(c => {
          const authorLink = c.querySelector('a[href*="/in/"]');
          const postLink = c.querySelector('a[href*="/feed/update/"]');
          const content = c.innerText?.slice(0, 180) || '';
          if (authorLink) {
            const profileUrl = authorLink.href;
            const name = authorLink.textContent?.trim() || '';
            const linkedinId = (profileUrl.split('/in/')[1] || '').split('/')[0];
            results.push({
              authorName: name,
              authorProfileUrl: profileUrl,
              authorLinkedinId: linkedinId,
              postUrl: postLink ? postLink.href : '',
              snippet: content
            });
          }
        });
        return results;
      });

      return posts;
    } catch (error) {
      console.error('LinkedIn search posts error:', error);
      return [];
    }
  }

  async sendConnectionRequest(profileUrl, message = '') {
    try {
      if (!this.isLoggedIn) {
        throw new Error('Not logged in to LinkedIn');
      }

      // Navigate to profile
      await this.page.goto(profileUrl, { waitUntil: 'networkidle2' });
      
      // Wait for connect button
      await this.page.waitForSelector('button[aria-label*="Connect"]', { timeout: 10000 });
      
      // Click connect button
      await this.page.click('button[aria-label*="Connect"]');
      
      // Wait for modal
      await this.page.waitForSelector('.artdeco-modal__content', { timeout: 5000 });
      
      // Add note if message provided
      if (message) {
        const noteInput = await this.page.$('textarea[name="message"]');
        if (noteInput) {
          await noteInput.type(message);
        }
      }
      
      // Send request
      await this.page.click('button[aria-label="Send now"]');
      
      // Wait for confirmation
      await this.page.waitForTimeout(2000);
      
      console.log(`Connection request sent to ${profileUrl}`);
      return true;
    } catch (error) {
      console.error('Send connection request error:', error);
      throw error;
    }
  }

  async sendMessage(profileUrl, message) {
    try {
      if (!this.isLoggedIn) {
        throw new Error('Not logged in to LinkedIn');
      }

      // Navigate to profile
      await this.page.goto(profileUrl, { waitUntil: 'networkidle2' });
      
      // Look for message button
      const messageButton = await this.page.$('button[aria-label*="Message"]');
      if (!messageButton) {
        throw new Error('Message button not found - may not be connected');
      }
      
      // Click message button
      await messageButton.click();
      
      // Wait for message modal
      await this.page.waitForSelector('.msg-form__contenteditable', { timeout: 5000 });
      
      // Type message
      await this.page.type('.msg-form__contenteditable', message);
      
      // Send message
      await this.page.click('button[type="submit"]');
      
      // Wait for confirmation
      await this.page.waitForTimeout(2000);
      
      console.log(`Message sent to ${profileUrl}`);
      return true;
    } catch (error) {
      console.error('Send message error:', error);
      throw error;
    }
  }

  async checkConnectionStatus(profileUrl) {
    try {
      if (!this.isLoggedIn) {
        throw new Error('Not logged in to LinkedIn');
      }

      // Navigate to profile
      await this.page.goto(profileUrl, { waitUntil: 'networkidle2' });
      
      // Check for different button states
      const connectButton = await this.page.$('button[aria-label*="Connect"]');
      const messageButton = await this.page.$('button[aria-label*="Message"]');
      const pendingButton = await this.page.$('button[aria-label*="Pending"]');
      
      if (messageButton) {
        return 'connected';
      } else if (pendingButton) {
        return 'pending';
      } else if (connectButton) {
        return 'not_connected';
      } else {
        return 'unknown';
      }
    } catch (error) {
      console.error('Check connection status error:', error);
      throw error;
    }
  }

  async fetchContactInfo(profileUrl) {
    try {
      if (!this.isLoggedIn) {
        throw new Error('Not logged in to LinkedIn');
      }

      await this.page.goto(profileUrl, { waitUntil: 'networkidle2' });

      // Try to open contact info modal
      const contactSelectors = [
        'a[href*="overlay/contact-info"]',
        'a[data-control-name*="contact_see_more"]',
        'a[aria-label*="Contact info"]',
        'a[aria-label*="Contact Info"]'
      ];
      let opened = false;
      for (const sel of contactSelectors) {
        const el = await this.page.$(sel);
        if (el) {
          await el.click();
          opened = true;
          break;
        }
      }
      if (opened) {
        await this.page.waitForTimeout(1000);
      }

      // Extract email/phone from contact info modal or page
      const info = await this.page.evaluate(() => {
        const result = { email: '', phone: '' };
        const textNodes = Array.from(document.querySelectorAll('section, div, a, span'))
          .slice(0, 2000)
          .map(n => n.innerText || '')
          .join('\n');
        const emailMatch = textNodes.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig);
        const phoneMatch = textNodes.match(/\+?\d[\d\s().-]{7,}/g);
        if (emailMatch && emailMatch.length) result.email = emailMatch[0];
        if (phoneMatch && phoneMatch.length) result.phone = phoneMatch[0];
        return result;
      });

      return info;
    } catch (error) {
      console.error('LinkedIn fetch contact info error:', error);
      return { email: '', phone: '' };
    }
  }

  async logout() {
    try {
      if (this.page) {
        await this.page.goto('https://www.linkedin.com/logout/');
        await this.page.waitForTimeout(2000);
      }
      this.isLoggedIn = false;
      console.log('LinkedIn logout successful');
    } catch (error) {
      console.error('LinkedIn logout error:', error);
    }
  }

  async close() {
    try {
      if (this.browser) {
        await this.browser.close();
        this.browser = null;
        this.page = null;
        this.isLoggedIn = false;
        console.log('LinkedIn service closed');
      }
    } catch (error) {
      console.error('LinkedIn service close error:', error);
    }
  }
}

module.exports = LinkedInService; 