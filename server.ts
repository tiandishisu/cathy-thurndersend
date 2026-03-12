import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import axios from "axios";
import nodemailer from "nodemailer";
import { toZonedTime } from "date-fns-tz";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Increase payload limit for large contact lists
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ limit: '50mb', extended: true }));

  // Request logging middleware
  app.use((req, res, next) => {
    console.log(`${req.method} ${req.url}`);
    next();
  });

  // --- Microsoft OAuth Config ---
  const CLIENT_ID = process.env.MICROSOFT_CLIENT_ID;
  const CLIENT_SECRET = process.env.MICROSOFT_CLIENT_SECRET;
  const REDIRECT_URI = process.env.MICROSOFT_REDIRECT_URI || `${process.env.APP_URL}/auth/callback`;
  const SCOPES = "offline_access https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/User.Read";

  // API Routes
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  // 1. Get Auth URL
  app.get("/api/auth/microsoft/url", (req, res) => {
    const authUrl = `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=${CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_mode=query&scope=${encodeURIComponent(SCOPES)}&state=12345`;
    res.json({ url: authUrl });
  });

  // 2. OAuth Callback
  app.get("/auth/callback", async (req, res) => {
    // ... existing OAuth logic ...
  });

  // 3. SMTP Verification & Manual Account Add
  app.post("/api/accounts/verify-smtp", async (req, res) => {
    const { email, password, smtpHost, smtpPort } = req.body;
    const host = smtpHost || "smtp.partner.outlook.cn";
    const port = parseInt(smtpPort) || 587;
    
    console.log(`[SMTP Verify] Attempting connection for ${email} to ${host}:${port}`);

    const transporter = nodemailer.createTransport({
      host: host,
      port: port,
      secure: port === 465,
      auth: {
        user: email,
        pass: password,
      },
      connectionTimeout: 30000,
      greetingTimeout: 30000,
      socketTimeout: 45000,
      tls: {
        rejectUnauthorized: false,
        minVersion: 'TLSv1.2'
      },
      requireTLS: port === 587,
      debug: true,
      logger: true
    });

    try {
      // Use a promise with timeout to ensure we don't hang forever
      const verifyPromise = transporter.verify();
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error("Verification timed out after 30s. This often happens on cloud providers like Render when outbound SMTP ports are restricted.")), 31000)
      );

      await Promise.race([verifyPromise, timeoutPromise]);
      
      console.log(`[SMTP Verify] Success for ${email}`);
      res.json({ success: true, message: "SMTP connection verified" });
    } catch (error: any) {
      console.error(`[SMTP Verify] Failed for ${email}:`, error);
      
      let friendlyMessage = error.message || "Unknown SMTP error";
      
      if (error.code === 'ETIMEDOUT') {
        friendlyMessage = `Connection timed out to ${host}:${port}. Render's free tier sometimes restricts outbound traffic to common SMTP ports. Try port 465 or use OAuth instead.`;
      } else if (error.code === 'ECONNREFUSED') {
        friendlyMessage = `Connection refused by ${host}:${port}. Please verify the server address and port.`;
      } else if (friendlyMessage.includes('535 5.7.139')) {
        friendlyMessage = "Authentication failed (535 5.7.139). Please ensure 'Authenticated SMTP' is enabled in your Microsoft 365 Admin Center, or use an 'App Password' if MFA is enabled.";
      }

      res.status(500).json({ 
        success: false, 
        error: friendlyMessage,
        code: error.code
      });
    }
  });

  // 4. Campaign Manager (In-memory for MVP)
  const activeCampaigns: Record<string, any> = {};
  const scheduledCampaigns: any[] = [];
  const dailyStats: Record<string, number> = {
    [new Date().toISOString().split('T')[0]]: 0
  };

  // Tracking Pixel Endpoint
  app.get("/api/t/o/:campId/:contactId.png", (req, res) => {
    const { campId } = req.params;
    if (activeCampaigns[campId]) {
      activeCampaigns[campId].opens = (activeCampaigns[campId].opens || 0) + 1;
      activeCampaigns[campId].logs.push(`Email opened by contact ${req.params.contactId}`);
    }
    // Return 1x1 transparent pixel
    const pixel = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': pixel.length,
      'Cache-Control': 'no-cache, no-store, must-revalidate'
    });
    res.end(pixel);
  });

  // Click Tracking Endpoint
  app.get("/api/t/c/:campId/:contactId", (req, res) => {
    const { campId } = req.params;
    const targetUrl = req.query.url as string;
    if (activeCampaigns[campId]) {
      activeCampaigns[campId].clicks = (activeCampaigns[campId].clicks || 0) + 1;
      activeCampaigns[campId].logs.push(`Link clicked by contact ${req.params.contactId}: ${targetUrl}`);
    }
    if (targetUrl) res.redirect(targetUrl);
    else res.status(404).send("URL missing");
  });

  const runCampaign = async (campaignId: string, template: any, contacts: any[], accountConfig: any, settings: any) => {
    const today = new Date().toISOString().split('T')[0];
    try {
      const transporter = nodemailer.createTransport({
        host: accountConfig.smtpHost,
        port: accountConfig.smtpPort,
        secure: accountConfig.smtpPort === 465,
        auth: {
          user: accountConfig.email,
          pass: accountConfig.password,
        },
        tls: { 
          rejectUnauthorized: false,
          minVersion: 'TLSv1.2'
        },
        requireTLS: accountConfig.smtpPort === 587
      });

      const maxPerMin = settings.maxPerMin || 25;
      const baseDelay = (60 / maxPerMin) * 1000;

      // Initial random delay (1-5s) to avoid predictable start times
      await new Promise(resolve => setTimeout(resolve, (Math.random() * 4000) + 1000));

      for (let i = 0; i < contacts.length; i++) {
        if (activeCampaigns[campaignId].status === 'stopped') break;
        const contact = contacts[i];
        const contactId = `user_${i}`;

        // Calculate delay with more randomness to simulate human behavior
        let currentDelay = baseDelay;
        
        // Warm-up: start 50% slower for the first 10 emails to avoid sudden spikes
        if (i < 10) {
          currentDelay = baseDelay * 1.5;
        }

        if (settings.useJitter) {
          // Add significant jitter (up to 40% of base delay)
          const variation = (Math.random() * 0.8) - 0.4; // -40% to +40%
          currentDelay = baseDelay * (1 + variation);
          
          // Every 10-20 emails, take a longer "human" break (simulating a person getting coffee/checking phone)
          if (i > 0 && i % (Math.floor(Math.random() * 10) + 10) === 0) {
            const breakTime = (Math.random() * 45 + 15) * 1000; // 15-60 seconds break
            activeCampaigns[campaignId].logs.push(`Simulating human behavior: Taking a ${Math.round(breakTime/1000)}s break...`);
            await new Promise(resolve => setTimeout(resolve, breakTime));
          }

          // Every batchSize emails, take a much longer "batch" break
          const batchSize = settings.batchSize || 50;
          const batchCooling = (settings.batchCooling || 5) * 60 * 1000; // convert minutes to ms
          
          if (i > 0 && i % batchSize === 0) {
            activeCampaigns[campaignId].logs.push(`Batch complete: Cooling down for ${settings.batchCooling || 5} minutes...`);
            await new Promise(resolve => setTimeout(resolve, batchCooling));
          }
        }

        // Ensure a minimum delay of 1 second if jitter is off, or 500ms if on
        const finalDelay = Math.max(settings.useJitter ? 500 : 1000, currentDelay);
        await new Promise(resolve => setTimeout(resolve, finalDelay));

        try {
          let content = template.content;
          let subject = template.subject;

          // Replace variables safely
          Object.keys(contact).forEach(key => {
            const value = contact[key] || "";
            // Escape key for regex
            const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const placeholder = new RegExp(`{{${escapedKey}}}`, 'g');
            content = content.replace(placeholder, value);
            subject = subject.replace(placeholder, value);
          });

          // Inject Tracking Pixel
          if (template.isHtml && process.env.APP_URL) {
            const baseUrl = process.env.APP_URL.replace(/\/$/, "");
            
            // Open Tracking
            if (settings.enableOpenTracking) {
              const trackingPixel = `<img src="${baseUrl}/api/t/o/${campaignId}/${contactId}.png" width="1" height="1" style="display:none" />`;
              content += trackingPixel;
            }

            // Click Tracking
            if (settings.enableClickTracking) {
              content = content.replace(/href="([^"]+)"/g, (match, url) => {
                if (url.startsWith('http') && !url.includes('/api/t/c/')) {
                  return `href="${baseUrl}/api/t/c/${campaignId}/${contactId}?url=${encodeURIComponent(url)}"`;
                }
                return match;
              });
            }
          }

          const mailOptions: any = {
            from: accountConfig.email,
            to: contact.email,
            subject: subject,
            html: template.isHtml ? content : undefined,
            text: !template.isHtml ? content : undefined,
            headers: {
              'X-Campaign-ID': campaignId
            }
          };

          // Add List-Unsubscribe (Standard header, always good for deliverability)
          mailOptions.headers['List-Unsubscribe'] = `<mailto:${accountConfig.email}?subject=unsubscribe>`;

          await transporter.sendMail(mailOptions);

          activeCampaigns[campaignId].sent++;
          dailyStats[today] = (dailyStats[today] || 0) + 1;
        } catch (err: any) {
          activeCampaigns[campaignId].failed++;
          activeCampaigns[campaignId].logs.push(`Error sending to ${contact.email}: ${err.message}`);
        }
      }
      
      activeCampaigns[campaignId].status = 'completed';
      activeCampaigns[campaignId].endTime = new Date();
      activeCampaigns[campaignId].logs.push("Campaign completed");
    } catch (bgError: any) {
      console.error("Background sending error:", bgError);
      if (activeCampaigns[campaignId]) {
        activeCampaigns[campaignId].status = 'failed';
        activeCampaigns[campaignId].logs.push(`Critical background error: ${bgError.message}`);
      }
    }
  };

  // Scheduler Background Job
  setInterval(() => {
    const now = new Date();
    for (let i = scheduledCampaigns.length - 1; i >= 0; i--) {
      const campaign = scheduledCampaigns[i];
      const { scheduledTime, timezone } = campaign.settings;
      
      if (!scheduledTime) continue;

      // Convert current time to the target timezone
      const zonedNow = toZonedTime(now, timezone);
      const scheduledDate = new Date(scheduledTime);

      if (zonedNow >= scheduledDate) {
        console.log(`Starting scheduled campaign: ${campaign.id}`);
        activeCampaigns[campaign.id].status = 'running';
        activeCampaigns[campaign.id].logs.push(`Scheduled time reached (${scheduledTime} ${timezone}). Starting now...`);
        
        // Start the campaign
        runCampaign(campaign.id, campaign.template, campaign.contacts, campaign.accountConfig, campaign.settings);
        
        // Remove from scheduled
        scheduledCampaigns.splice(i, 1);
      }
    }
  }, 30000); // Check every 30 seconds

  app.post("/api/send-bulk", async (req, res) => {
    try {
      const { template, contacts, accountConfig, settings = {} } = req.body;
      console.log(`Bulk send request received: ${contacts?.length} contacts`);

      if (!accountConfig || (!accountConfig.smtpHost && !accountConfig.accessToken)) {
        return res.status(400).json({ error: "Invalid account configuration. Please reconnect your account." });
      }
      
      // Check daily limit (10,000)
      const today = new Date().toISOString().split('T')[0];
      if ((dailyStats[today] || 0) + (contacts?.length || 0) > 10000) {
        return res.status(400).json({ error: "Daily limit (10,000) would be exceeded. Please reduce batch size or wait until tomorrow." });
      }

      const campaignId = `camp_${Date.now()}`;
      const isScheduled = !!settings.scheduledTime;

      activeCampaigns[campaignId] = {
        id: campaignId,
        status: isScheduled ? 'scheduled' : 'running',
        total: contacts.length,
        sent: 0,
        failed: 0,
        opens: 0,
        clicks: 0,
        startTime: new Date(),
        logs: [isScheduled ? `Campaign scheduled for ${settings.scheduledTime} (${settings.timezone})` : `Campaign started with ${contacts.length} contacts`]
      };

      if (isScheduled) {
        scheduledCampaigns.push({
          id: campaignId,
          template,
          contacts,
          accountConfig,
          settings
        });
      } else {
        // Background process
        runCampaign(campaignId, template, contacts, accountConfig, settings);
      }

      res.json({ success: true, campaignId });
    } catch (error: any) {
      console.error("Send-bulk error:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.get("/api/campaigns/:id", (req, res) => {
    const campaign = activeCampaigns[req.params.id];
    if (!campaign) return res.status(404).json({ error: "Campaign not found" });
    res.json(campaign);
  });

  // Global Error Handler
  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error("Global Error:", err);
    res.status(err.status || 500).json({
      success: false,
      error: err.message || "Internal Server Error"
    });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, "dist")));
    app.get("*", (req, res) => {
      res.sendFile(path.join(__dirname, "dist", "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
