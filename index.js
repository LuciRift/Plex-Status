const express = require('express');
const axios = require('axios');
const fs = require('fs');
const yaml = require('js-yaml');
const path = require('path');
const mongoose = require('mongoose');
const botVersion = require('./package.json');
const color = require('ansi-colors');
const ping = require('ping');
const net = require('net');
const dgram = require('dgram');
const { Webhook, MessageBuilder } = require('discord-webhook-node');
const discordBot = require('./discord-bot');
const rateLimit = require('express-rate-limit');

const Service = require('./models/serviceModel');
const History = require('./models/historyModel');
const StatusUpdate = require('./models/statusUpdateModel');
const DiscordMessage = require('./models/discordMessageModel');

const config = yaml.load(fs.readFileSync('./config.yml', 'utf8'));

const app = express();
const port = config.PageSettings.Port;
if (config.PageSettings.trustProxy && config.PageSettings.trustProxy > 0) app.set('trust proxy', config.PageSettings.trustProxy);

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

const refreshLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: 'Too many refresh requests, please wait before trying again.',
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(generalLimiter);

let pageCache = {
  data: null,
  timestamp: 0
};
const CACHE_DURATION = 30 * 1000;

function getCachedResponse() {
  const now = Date.now();
  if (pageCache.data && (now - pageCache.timestamp) < CACHE_DURATION) {
    return pageCache.data;
  }
  return null;
}

function setCachedResponse(data) {
  pageCache.data = data;
  pageCache.timestamp = Date.now();
}

function parseDuration(input) {
  if (typeof input === 'number') {
    return input;
  }
  
  if (typeof input !== 'string') {
    throw new Error('Duration must be a string or number');
  }
  
  const units = {
    ms: 1,
    s: 1000,
    sec: 1000,
    second: 1000,
    seconds: 1000,
    m: 60000,
    min: 60000,
    minute: 60000,
    minutes: 60000,
    h: 3600000,
    hr: 3600000,
    hour: 3600000,
    hours: 3600000,
    d: 86400000,
    day: 86400000,
    days: 86400000,
    w: 604800000,
    week: 604800000,
    weeks: 604800000,
    y: 31536000000,
    year: 31536000000,
    years: 31536000000
  };
  
  const regex = /^(\d+(?:\.\d+)?)\s*([a-zA-Z]+)$/;
  const match = input.trim().match(regex);
  
  if (!match) {
    throw new Error(`Invalid duration format: ${input}`);
  }
  
  const value = parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  
  if (!(unit in units)) {
    throw new Error(`Unknown time unit: ${unit}`);
  }
  
  return Math.round(value * units[unit]);
}

class StatusDebouncer {
  constructor(debounceCount = 2, debounceWindow = 30000, updateInterval = 30000) {
    this.statusCounts = new Map();
    this.debounceCount = debounceCount;
    this.debounceWindow = Math.max(debounceWindow, updateInterval * 2.5);
    
    if (config.DebugMode) {
      console.log(`[DEBOUNCE] Window: ${this.debounceWindow}ms, Update interval: ${updateInterval}ms`);
    }
  }

shouldUpdateStatus(serviceName, newStatus, currentStatus) {
  if (currentStatus === 'unknown' && newStatus !== 'unknown') {
    return true;
  }
  
  if (newStatus === 'maintenance') {
    return true;
  }
  
  if (newStatus === currentStatus) {
    this.resetDebounce(serviceName);
    return false;
  }

  const now = Date.now();
  const key = `${serviceName}-${newStatus}`;
  
  if (!this.statusCounts.has(key)) {
    this.statusCounts.set(key, { count: 1, firstSeen: now });
    return false;
  }

  const data = this.statusCounts.get(key);
  
  if (now - data.firstSeen > this.debounceWindow) {
    this.statusCounts.set(key, { count: 1, firstSeen: now });
    return false;
  }

  data.count++;
  
  if (data.count >= this.debounceCount) {
    this.resetDebounce(serviceName);
    return true;
  }

  return false;
}

  resetDebounce(serviceName) {
    for (const [key] of this.statusCounts) {
      if (key.startsWith(`${serviceName}-`)) {
        this.statusCounts.delete(key);
      }
    }
  }
}

const statusDebouncer = new StatusDebouncer(
  config.Performance?.DebounceCount || 2,
  config.Performance?.DebounceWindow || 30000
);

const axiosInstance = axios.create({
  timeout: 10000,
  maxRedirects: 3,
  validateStatus: (status) => status >= 200 && status < 400,
  headers: {
    'User-Agent': 'PlexStatus/1.0 Health-Check'
  }
});

axiosInstance.interceptors.response.use(
  response => response,
  error => {
    if (error.code === 'ECONNABORTED') {
      error.isTimeout = true;
    }
    throw error;
  }
);

const backoffMap = new Map();

function getServiceConfigHash(serviceConfig) {
  const configString = `${serviceConfig.url}-${serviceConfig.type}-${serviceConfig.port || ''}-${serviceConfig.maintenance || false}`;
  return configString;
}

function shouldSkipCheck(serviceName, currentStatus, serviceConfig) {
  if (currentStatus !== 'offline') {
    backoffMap.delete(serviceName);
    return false;
  }

  const backoffData = backoffMap.get(serviceName);
  const now = Date.now();

  if (!backoffData) {
    backoffMap.set(serviceName, { 
      lastCheck: now, 
      backoffMultiplier: 1,
      configHash: getServiceConfigHash(serviceConfig)
    });
    return false;
  }

  const configHash = getServiceConfigHash(serviceConfig);
  if (backoffData.configHash !== configHash) {
    backoffMap.set(serviceName, { 
      lastCheck: now, 
      backoffMultiplier: 1,
      configHash: configHash
    });
    if (config.DebugMode) {
      console.log(`[BACKOFF] Service ${serviceName} configuration changed, resetting backoff`);
    }
    return false;
  }

  const maxBackoff = config.Performance?.MaxBackoffInterval || 300000;
  const backoffInterval = Math.min(backoffData.backoffMultiplier * 30000, maxBackoff);
  
  if (now - backoffData.lastCheck < backoffInterval) {
    return true;
  }

  backoffData.lastCheck = now;
  backoffData.backoffMultiplier = Math.min(backoffData.backoffMultiplier * 2, 10);
  return false;
}

function logError(message, error) {
  const timestamp = new Date().toISOString();
  const logMessage = `\n\n[${timestamp}] [ERROR] ${message}\n${error.stack}`;
  
  fs.appendFile("./logs.txt", logMessage, (err) => {
    if (err && config.DebugMode) {
      console.error('Failed to write to log file:', err);
    }
  });
  
  if (config.DebugMode) {
    console.error(`[${timestamp}] ${message}:`, error.message);
  }
}

const connectToMongoDB = async () => {
    try {
        if (config.MongoURI) await mongoose.set('strictQuery', false);

        if (config.MongoURI) {
            await mongoose.connect(config.MongoURI, {
              maxPoolSize: 10,
              serverSelectionTimeoutMS: 5000,
              socketTimeoutMS: 45000,
            });
            console.log('[MONGO] Connected to MongoDB successfully');
        } else {
            throw new Error('[ERROR] MongoDB Connection String is not specified in the config! (MongoURI)');
        }
    } catch (error) {
        console.error('\x1b[31m%s\x1b[0m', `[ERROR] Failed to connect to MongoDB: ${error.message}\n${error.stack}`);

        if (error.message.includes('authentication failed')) {
            await console.error('Authentication failed. Make sure to check if you entered the correct username and password in the connection URL.');
            await process.exit(1)
        } else if (error.message.includes('network error')) {
            await console.error('Network error. Make sure the MongoDB server is reachable and the connection URL is correct.');
            await process.exit(1)
        } else if (error.message.includes('permission denied')) {
            await console.error('Permission denied. Make sure the MongoDB cluster has the necessary permissions to read and write.');
            await process.exit(1)
        } else {
            await console.error('An unexpected error occurred. Check the MongoDB connection URL and credentials.');
            await process.exit(1)
        }
    }
};

connectToMongoDB();

let discordBotInitialized = false;

async function createDatabaseIndexes() {
  try {
    await Service.collection.createIndex({ name: 1 }, { unique: true });
    await Service.collection.createIndex({ currentStatus: 1 });
    await Service.collection.createIndex({ category: 1 });
    
    await StatusUpdate.collection.createIndex({ createdAt: -1 });
    
    if (config.DebugMode) {
      console.log('[DB] Database indexes created successfully');
    }
  } catch (error) {
    logError('Error creating database indexes', error);
  }
}

async function initializeServices() {
    try {
        for (const serviceConfig of config.services) {
            const existingService = await Service.findOne({ name: serviceConfig.name });
            
            if (!existingService) {
                await Service.create({
                    name: serviceConfig.name,
                    category: serviceConfig.category || "Uncategorized",
                    url: serviceConfig.url,
                    type: serviceConfig.type,
                    port: serviceConfig.port || null,
                    currentStatus: 'unknown',
                    webhookURL: serviceConfig.webhookURL || null,
                    maintenance: serviceConfig.maintenance || false,
                    tooltip: serviceConfig.tooltip || null,
                    lastResponseTime: 0,
                    history: []
                });
                if (config.DebugMode) {
                  console.log(`[INIT] Created service: ${serviceConfig.name}`);
                }
            } else {
                const oldConfig = {
                    url: existingService.url,
                    type: existingService.type,
                    port: existingService.port,
                    maintenance: existingService.maintenance
                };
                
                const newConfig = {
                    url: serviceConfig.url,
                    type: serviceConfig.type,
                    port: serviceConfig.port || null,
                    maintenance: serviceConfig.maintenance || false
                };
                
                const configChanged = JSON.stringify(oldConfig) !== JSON.stringify(newConfig);
                
                await Service.updateOne(
                    { name: serviceConfig.name },
                    {
                        category: serviceConfig.category || "Uncategorized",
                        url: serviceConfig.url,
                        type: serviceConfig.type,
                        port: serviceConfig.port || null,
                        webhookURL: serviceConfig.webhookURL || null,
                        maintenance: serviceConfig.maintenance || false,
                        tooltip: serviceConfig.tooltip || null
                    }
                );
                
                if (configChanged) {
                    console.log(`[INIT] Service ${serviceConfig.name} configuration changed, clearing backoff`);
                    backoffMap.delete(serviceConfig.name);
                    statusDebouncer.resetDebounce(serviceConfig.name);
                }
            }
        }
        
        const configServiceNames = config.services.map(s => s.name);
        await Service.deleteMany({ name: { $nin: configServiceNames } });
        
        if (config.DebugMode) {
          console.log('[INIT] Services synchronized with config');
        }
    } catch (error) {
        console.error('[ERROR] Failed to initialize services:', error);
    }
}

app.use((req, res, next) => {
  const send = res.send;
  res.send = function (body) {
      if (typeof body === 'string' && body.includes('</body>')) {
          const consoleScript = `
              <script>
                  (function() {
                      const message = \`
%c
Plex Status is made by Plex Development.
Version: ${botVersion.version}
Buy - https://plexdevelopment.net/products/plexstatus
\`,
                          style = \`
font-family: monospace;
color: #5e99ff;
background-color: #1e1e1e;
padding: 10px;
border: 1px solid #00aaff;
\`;
      
                      console.log(message, style);
                  })();
              </script>
              `;
          body = body.replace('</body>', consoleScript + '</body>');
      }
      send.call(this, body);
  };
  next();
});

async function sendDiscordNotification(webhookURL, title, description, color) {
  try {
    const hook = new Webhook(webhookURL);

    hook.setUsername(config.PageSettings.Name);
    hook.setAvatar(`${config.PageSettings.baseURL}/logo.png`);

    const embed = new MessageBuilder()
      .setTitle(title)
      .setDescription(description)
      .setColor(color)
      .setTimestamp();

    await hook.send(embed);
  } catch (error) {
    logError(`Failed to send Discord notification`, error);
  }
}

function formatDuration(seconds) {
  if (seconds < 60) {
    return `${Math.floor(seconds)} seconds`;
  } else if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60);
    return `${minutes} minute${minutes > 1 ? 's' : ''}`;
  } else if (seconds < 86400) {
    const hours = Math.floor(seconds / 3600);
    return `${hours} hour${hours > 1 ? 's' : ''}`;
  } else {
    const days = Math.floor(seconds / 86400);
    return `${days} day${days > 1 ? 's' : ''}`;
  }
}

async function logStatusChange(serviceName, status, responseTime) {
  const timestamp = new Date();
  
  try {
    const service = await Service.findOne({ name: serviceName });
    if (!service) {
      console.error(`Service ${serviceName} not found`);
      return;
    }

    const lastHistoryEntry = service.history.length > 0 ? service.history[service.history.length - 1] : null;

    if (lastHistoryEntry && lastHistoryEntry.status === 'offline' && status === 'online') {
      const lastTimestamp = new Date(lastHistoryEntry.timestamp);
      const duration = (timestamp - lastTimestamp) / 1000;
      lastHistoryEntry.duration = duration;
    }

    const newHistoryEntry = {
      status,
      timestamp,
      responseTime
    };

    service.history.push(newHistoryEntry);
    service.currentStatus = status;
    service.lastResponseTime = responseTime;
    
    await service.save();

    if (!lastHistoryEntry || lastHistoryEntry.status !== status) {
      console.log(`[STATUS] ${serviceName}: ${lastHistoryEntry?.status || 'unknown'} → ${status}`);
    }

    if (service.webhookURL) {
      if (lastHistoryEntry && lastHistoryEntry.status !== status) {
        let description;
        const title = config.WebhookMessages[status === 'online' ? 'Online' : 'Offline'].Title;

        if (status === 'online' && lastHistoryEntry) {
          const formattedDuration = lastHistoryEntry.duration ? formatDuration(lastHistoryEntry.duration) : 'N/A';
          description = config.WebhookMessages.Online.Description
            .replace('{{serviceName}}', serviceName)
            .replace('{{lastOfflineTimestamp}}', Math.floor(new Date(lastHistoryEntry.timestamp).getTime() / 1000))
            .replace('{{currentTimestamp}}', Math.floor(timestamp.getTime() / 1000))
            .replace('{{formattedDuration}}', formattedDuration);
        } else if (status === 'offline') {
          description = config.WebhookMessages.Offline.Description
            .replace('{{serviceName}}', serviceName)
            .replace('{{currentTimestamp}}', Math.floor(timestamp.getTime() / 1000));
        }

        const webhookColor = status === 'online' ? config.StatusColors.Online : config.StatusColors.Offline;
        if(service.webhookURL) await sendDiscordNotification(service.webhookURL, title, description, webhookColor);
      }
    }
  } catch (error) {
    logError(`Error logging status change for ${serviceName}`, error);
  }
}

async function calculateOverallStatus() {
  try {
    const [totalServices, onlineServices] = await Promise.all([
      Service.countDocuments(),
      Service.countDocuments({ currentStatus: 'online' })
    ]);
    
    if (onlineServices === 0) return 'offline';
    if (onlineServices < totalServices) return 'partial';
    return 'online';
  } catch (error) {
    logError('Error calculating overall status', error);
    return 'unknown';
  }
}

async function checkWebsite(url) {
  const response = await axiosInstance.get(url);
  return response.status >= 200 && response.status < 400;
}

async function checkMinecraft(url) {
  const response = await axiosInstance.get(`https://api.mcstatus.io/v2/status/java/${url}`);
  return response.data.online === true;
}

async function checkTcpPort(host, port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const timeout = 5000;
    let resolved = false;

    const cleanup = () => {
      if (!resolved) {
        resolved = true;
        socket.destroy();
      }
    };

    const timer = setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeout);

    socket.on('connect', () => {
      clearTimeout(timer);
      cleanup();
      resolve(true);
    });

    socket.on('error', () => {
      clearTimeout(timer);
      cleanup();
      resolve(false);
    });

    socket.on('timeout', () => {
      clearTimeout(timer);
      cleanup();
      resolve(false);
    });

    socket.setTimeout(timeout);
    socket.connect(port, host);
  });
}

async function checkUdpPort(host, port) {
  return new Promise((resolve) => {
    const client = dgram.createSocket('udp4');
    const message = Buffer.from('ping');
    const timeout = 3000;
    let resolved = false;

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        client.close();
        resolve(false);
      }
    }, timeout);

    client.send(message, 0, message.length, port, host, (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        client.close();
        resolve(!err);
      }
    });

    client.on('error', () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        client.close();
        resolve(false);
      }
    });
  });
}

async function checkServiceStatusWithResponseTime(service) {
  if (service.maintenance) {
    return { status: 'maintenance', responseTime: 0 };
  }

  const startTime = process.hrtime.bigint();
  let responseTime = 0;

  try {
    let result;
    
    switch (service.type) {
      case 'website':
        result = await checkWebsite(service.url);
        break;
      case 'minecraft':
        result = await checkMinecraft(service.url);
        break;
      case 'tcp':
        result = await checkTcpPort(service.url, service.port);
        break;
      case 'udp':
        result = await checkUdpPort(service.url, service.port);
        break;
      case 'ip':
        result = await checkIpStatus(service.url);
        break;
      default:
        throw new Error(`Unknown service type: ${service.type}`);
    }

    responseTime = Number(process.hrtime.bigint() - startTime) / 1000000;
    return { 
      status: result === true || result === 'online' ? 'online' : 'offline', 
      responseTime: Math.round(responseTime) 
    };
    
  } catch (error) {
    responseTime = Number(process.hrtime.bigint() - startTime) / 1000000;
    
    if (!error.isTimeout && error.code !== 'ECONNREFUSED' && error.code !== 'ENOTFOUND') {
      logError(`Service check error for ${service.name}`, error);
    }
    
    return { status: 'offline', responseTime: Math.round(responseTime) };
  }
}

async function checkIpStatus(ip) {
  try {
    const res = await ping.promise.probe(ip);
    if (res.alive) {
      return 'online';
    } else {
      throw new Error('Ping failed');
    }
  } catch (error) {
    if (config.DebugMode) {
      logError(`Error checking IP ${ip}, trying external`, error);
    }
    return await checkIpStatusExternal(ip);
  }
}

async function checkIpStatusExternal(ip) {
  try {
    const response = await axios.post(
      'https://ping.plexdevelopment.net',
      { ip },
      {
        headers: {
          'x-api-key': "59dChEwF1qaWmVrkmPQP",
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );
    if (response.data.status === 'online') {
      return 'online';
    } else {
      return 'offline';
    }
  } catch (error) {
    if (config.DebugMode) {
      logError(`Checking external IP (ping.plexdevelopment.net) for ${ip}`, error);
    }
    
    if (error.response && error.response.status === 403) {
      return 'offline';
    } else if (error.response && error.response.status >= 400 && error.response.status < 500) {
      return 'offline';
    } else {
      return 'online';
    }
  }
}

async function updateStatuses() {
  try {
    const services = await Service.find().lean();
    const configServices = new Map(config.services.map(s => [s.name, s]));
    const concurrencyLimit = config.Performance?.ConcurrencyLimit || 10;
    
    for (let i = 0; i < services.length; i += concurrencyLimit) {
      const batch = services.slice(i, i + concurrencyLimit);
      
      const promises = batch.map(async (service) => {
        try {
          const serviceConfig = configServices.get(service.name);
          if (!serviceConfig) {
            return;
          }

          if (shouldSkipCheck(service.name, service.currentStatus, serviceConfig)) {
            return;
          }

          const { status: newStatus, responseTime } = await checkServiceStatusWithResponseTime(service);
          
          if (statusDebouncer.shouldUpdateStatus(service.name, newStatus, service.currentStatus)) {
            await Service.updateOne(
              { name: service.name },
              { currentStatus: newStatus, lastResponseTime: responseTime }
            );
            await logStatusChange(service.name, newStatus, responseTime);
          } else if (newStatus === service.currentStatus) {
            await updateServiceResponseTime(service.name, responseTime);
          }
        } catch (error) {
          logError(`Error checking service ${service.name}`, error);
        }
      });

      await Promise.allSettled(promises);
    }

    const timestamp = new Date();
    await StatusUpdate.create({
      lastUpdated: timestamp,
      overallStatus: await calculateOverallStatus(),
      onlineServices: await Service.countDocuments({ currentStatus: 'online' }),
      totalServices: await Service.countDocuments()
    });
  } catch (error) {
    logError('Error updating statuses', error);
  }
}

async function updateDiscordStatus() {
  if (!config.DiscordBot || !config.DiscordBot.Enabled || !discordBotInitialized) {
    return;
  }

  try {
    const services = await Service.find().lean();
    const lastStatusUpdate = await StatusUpdate.findOne().sort({ createdAt: -1 });
    const lastUpdated = lastStatusUpdate ? lastStatusUpdate.lastUpdated : new Date();

    const historyByService = await Promise.all(services.map(async (service) => {
      const historyByDay = aggregateHistory(service.history);
      const last90Days = getLast90UniqueDays(historyByDay);
      
      const totalEntries = service.history.length;
      const onlineEntries = service.history.filter(entry => entry.status === 'online').length;
      const uptimePercentage = totalEntries ? (onlineEntries / totalEntries) * 100 : 0;
      
      const dayAgo = Date.now() - (24 * 60 * 60 * 1000);
      const recentHistory = service.history.filter(entry => {
        const entryTime = new Date(entry.timestamp).getTime();
        return entryTime > dayAgo && entry.responseTime;
      });
      
      let avgResponseTime = 0;
      if (recentHistory.length > 0) {
        const totalResponseTime = recentHistory.reduce((sum, entry) => sum + (entry.responseTime || 0), 0);
        avgResponseTime = Math.round(totalResponseTime / recentHistory.length);
      } else {
        avgResponseTime = service.lastResponseTime || 0;
      }

      return {
        name: service.name,
        category: service.category || "Uncategorized",
        status: service.currentStatus,
        history: last90Days,
        tooltip: service.tooltip,
        uptimePercentage: uptimePercentage.toFixed(2),
        responseTime: avgResponseTime
      };
    }));

    let overallStatus = 'All services are online';
    let statusClass = 'online';
    const onlineServices = historyByService.filter(service => service.status === 'online').length;

    if (onlineServices === 0) {
      overallStatus = 'All services are offline';
      statusClass = 'offline';
    } else if (onlineServices < services.length) {
      overallStatus = 'Partial services are offline';
      statusClass = 'partial';
    }

    await discordBot.updateStatusEmbeds(historyByService, overallStatus, statusClass, lastUpdated);
  } catch (error) {
    logError('Error updating Discord status', error);
  }
}

async function updateServiceResponseTime(serviceName, responseTime) {
  try {
    await Service.updateOne(
      { name: serviceName },
      { 
        lastResponseTime: responseTime,
        $set: { "history.$[elem].responseTime": responseTime }
      },
      { arrayFilters: [{ "elem.responseTime": { $exists: false } }] }
    );
  } catch (error) {
    logError(`Error updating response time for ${serviceName}`, error);
  }
}

async function periodicallySaveStatus() {
  try {
    const services = await Service.find().lean();
    const timestamp = new Date();
    const updates = [];

    for (const service of services) {
      if (service.history && service.history.length > 0) {
        updates.push({
          updateOne: {
            filter: { name: service.name },
            update: {
              $push: {
                history: {
                  status: service.currentStatus,
                  timestamp,
                  responseTime: service.lastResponseTime
                }
              }
            }
          }
        });

        if(config.DebugMode) console.log(`Status for ${service.name} saved at ${timestamp}`);
      }
    }

    if (updates.length > 0) {
      await Service.bulkWrite(updates);
    }
  } catch (error) {
    logError('Error in periodicallySaveStatus', error);
  }
}

async function startServices() {
  console.log("[STARTUP] Starting Plex Status services...");
  
  await createDatabaseIndexes();
  await initializeServices();
  console.log("[INIT] Services initialized");
  
  await updateStatuses();
  console.log("[STATUS] Initial status update completed");
  
  if (config.DiscordBot && config.DiscordBot.Enabled) {
    try {
      console.log("[DISCORD] Initializing Discord bot...");
      discordBotInitialized = await discordBot.initializeBot();
      
      if (discordBotInitialized) {
        console.log(`[DISCORD] Bot initialized successfully`);
        
        await updateDiscordStatus();
        console.log(`[DISCORD] Status embed updated successfully`);
        
        const discordUpdateInterval = config.DiscordBot.UpdateInterval 
          ? parseDuration(config.DiscordBot.UpdateInterval) 
          : updateInterval;
        
        setInterval(updateDiscordStatus, discordUpdateInterval);
        console.log(`[DISCORD] Scheduled regular updates every ${formatDuration(discordUpdateInterval / 1000)}`);
      } else {
        console.log(`[DISCORD] Failed to initialize Discord bot`);
      }
    } catch (error) {
      logError('Error during Discord initialization', error);
    }
  }
  
  console.log(`[STATUS] Setting up regular status updates...`);
}

const updateInterval = parseDuration(config.PageSettings.updateInterval);
setInterval(updateStatuses, updateInterval);

const saveInterval = 6 * 60 * 1000;
setInterval(periodicallySaveStatus, saveInterval);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.static('public'));

function aggregateHistory(serviceHistory) {
  if (!serviceHistory || !Array.isArray(serviceHistory)) {
    return {};
  }

  const historyByDay = {};

  serviceHistory.forEach(entry => {
    const date = new Date(entry.timestamp).toISOString().split('T')[0]; 
    
    if (!historyByDay[date]) {
      historyByDay[date] = { 
        total: 0, 
        online: 0, 
        offline: 0, 
        maintenance: 0,
        responseTimes: [],
        offlineDurations: [],
        status: 'online',
        uptimePercentage: 100
      };
    }
    
    historyByDay[date].total++;
    
    if (entry.status === 'offline') {
      historyByDay[date].offline++;
      if (entry.duration) {
        historyByDay[date].offlineDurations.push(entry.duration);
      }
    } else if (entry.status === 'maintenance') {
      historyByDay[date].maintenance++;
    } else {
      historyByDay[date].online++;
    }
    
    if (entry.responseTime) {
      historyByDay[date].responseTimes.push(entry.responseTime);
    }
    
    if (historyByDay[date].total > 0) {
      const onlineRatio = historyByDay[date].online / historyByDay[date].total;
      historyByDay[date].uptimePercentage = (onlineRatio * 100).toFixed(2);
    }
    
const maintenanceRatio = historyByDay[date].maintenance / historyByDay[date].total;
const uptimePercentage = parseFloat(historyByDay[date].uptimePercentage);

if (maintenanceRatio >= 0.5) {
  historyByDay[date].status = 'maintenance';
} else if (uptimePercentage >= 99.5) {
  historyByDay[date].status = 'online';
} else if (uptimePercentage >= 80) {
  historyByDay[date].status = 'partial';
} else {
  historyByDay[date].status = 'offline';
}
    
    if (historyByDay[date].responseTimes.length > 0) {
      const totalResponseTime = historyByDay[date].responseTimes.reduce((sum, time) => sum + time, 0);
historyByDay[date].avgResponseTime = Math.round(totalResponseTime / historyByDay[date].responseTimes.length);
   }
 });

 return historyByDay;
}

function getLast90UniqueDays(historyByDay) {
 const uniqueDays = Object.keys(historyByDay)
   .sort((a, b) => new Date(a) - new Date(b))
   .slice(-90);

 const result = uniqueDays.map(date => ({
   date,
   status: historyByDay[date].status,
   durations: historyByDay[date].offlineDurations || [],
   uptimePercentage: historyByDay[date].uptimePercentage || '100',
   avgResponseTime: historyByDay[date].avgResponseTime
 }));

 while (result.length < 90) {
   result.unshift({ 
     date: 'N/A', 
     status: 'placeholder', 
     durations: [],
     uptimePercentage: '100',
     avgResponseTime: null
   });
 }

 return result;
}

app.get('/', async (req, res) => {
  const cachedData = getCachedResponse();
  if (cachedData) {
    return res.render('index', cachedData);
  }

  try {
    const services = await Service.find().lean();
    const lastStatusUpdate = await StatusUpdate.findOne().sort({ createdAt: -1 });
    const lastUpdated = lastStatusUpdate ? lastStatusUpdate.lastUpdated : new Date();

    const historyByService = services.map(service => {
      const historyByDay = aggregateHistory(service.history || []);
      const last90Days = getLast90UniqueDays(historyByDay);
      
      const totalEntries = service.history ? service.history.length : 0;
      const onlineEntries = service.history ? service.history.filter(entry => entry.status === 'online').length : 0;
      const uptimePercentage = totalEntries ? (onlineEntries / totalEntries) * 100 : 0;
      
      const dayAgo = Date.now() - (24 * 60 * 60 * 1000);
      const recentHistory = service.history ? service.history.filter(entry => {
        const entryTime = new Date(entry.timestamp).getTime();
        return entryTime > dayAgo && entry.responseTime;
      }) : [];
      
      let avgResponseTime = 0;
      if (recentHistory.length > 0) {
        const totalResponseTime = recentHistory.reduce((sum, entry) => sum + (entry.responseTime || 0), 0);
        avgResponseTime = Math.round(totalResponseTime / recentHistory.length);
      } else {
        avgResponseTime = service.lastResponseTime || 0;
      }

      return {
        name: service.name,
        category: service.category || "Uncategorized",
        status: service.currentStatus,
        history: last90Days,
        tooltip: service.tooltip,
        uptimePercentage: uptimePercentage.toFixed(2),
        responseTime: avgResponseTime
      };
    });

    let overallStatus = 'All services are online';
    let statusColor = config.StatusColors.Online;
    let statusIcon = 'fas fa-check-circle';
    let statusClass = 'online';
    const onlineServices = historyByService.filter(service => service.status === 'online').length;

    if (onlineServices === 0) {
      overallStatus = 'All services are offline';
      statusColor = config.StatusColors.Offline;
      statusIcon = 'fas fa-times-circle';
      statusClass = 'offline';
    } else if (onlineServices < services.length) {
      overallStatus = 'Partial services are offline';
      statusColor = config.StatusColors.PartialOffline;
      statusIcon = 'fas fa-exclamation-circle';
      statusClass = 'partial';
    }

    function getRelativeTime(date) {
      const currentDate = new Date();
      const targetDate = new Date(date);
      const timeDifference = currentDate.getTime() - targetDate.getTime();

      const seconds = Math.floor(timeDifference / 1000);
      const minutes = Math.floor(seconds / 60);
      const hours = Math.floor(minutes / 60);
      const days = Math.floor(hours / 24);

      if (days > 0) {
          return days === 1 ? '1 day ago' : `${days} days ago`;
      } else if (hours > 0) {
          return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
      } else if (minutes > 0) {
          return minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`;
      } else {
          return seconds <= 10 ? 'just now' : `${seconds} seconds ago`;
      }
    }

    function hexToRgb(hex) {
      hex = hex.replace(/^#/, '');
    
      let bigint = parseInt(hex, 16);
      let r = (bigint >> 16) & 255;
      let g = (bigint >> 8) & 255;
      let b = bigint & 255;
    
      return `${r}, ${g}, ${b}`;
    }

    const themeColorRgb = hexToRgb(config.PageSettings.ThemeColor);

    const servicesByCategory = historyByService.reduce((categories, service) => {
      categories[service.category] = categories[service.category] || [];
      categories[service.category].push(service);
      return categories;
    }, {});

    const renderData = { 
      services: historyByService, 
      themeColorRgb, 
      servicesByCategory, 
      lastUpdated, 
      getRelativeTime, 
      overallStatus, 
      statusColor, 
      statusIcon, 
      statusClass, 
      config 
    };

    setCachedResponse(renderData);

    res.render('index', renderData);
  } catch (error) {
    logError('Error rendering index page', error);
    res.status(500).send('Internal Server Error');
  }
});

app.get('/refresh', refreshLimiter, async (req, res) => {
 try {
   await updateStatuses();
   const lastStatusUpdate = await StatusUpdate.findOne().sort({ createdAt: -1 });
   const lastUpdated = lastStatusUpdate ? lastStatusUpdate.lastUpdated : new Date();

   res.json({ lastUpdated });
 } catch (error) {
   logError('Error refreshing status', error);
   res.status(500).json({ error: 'Failed to refresh status' });
 }
});

process.on('SIGTERM', async () => {
 console.log('Received SIGTERM, shutting down gracefully...');
 try {
   await mongoose.connection.close();
   process.exit(0);
 } catch (error) {
   console.error('Error during shutdown:', error);
   process.exit(1);
 }
});

process.on('SIGINT', async () => {
 console.log('Received SIGINT, shutting down gracefully...');
 try {
   await mongoose.connection.close();
   process.exit(0);
 } catch (error) {
   console.error('Error during shutdown:', error);
   process.exit(1);
 }
});

app.listen(port, async () => {

   console.log("――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――");
   console.log("                                                                          ");
   if (config.LicenseKey) console.log(`${color.green.bold.underline(`Plex Status v${botVersion.version} is now Online!`)} (${color.gray(`${config.LicenseKey.slice(0, -10)}`)})`);
   if (!config.LicenseKey) console.log(`${color.green.bold.underline(`Plex Status v${botVersion.version} is now Online! `)}`);
   console.log(`• Join our discord server for support, ${color.cyan(`discord.gg/plexdev`)}`);
   console.log(`• By using this product you agree to all terms located here, ${color.yellow(`plexdevelopment.net/tos`)}`);
   if (config.LicenseKey) console.log("                                                                          ");
   if (config.LicenseKey) console.log(`${color.green.bold.underline(`Source Code:`)}`);
   if (config.LicenseKey) console.log(`• You can buy the full source code at ${color.yellow(`plexdevelopment.net/store/pstsourcecode`)}`);
   if (config.LicenseKey) console.log(`• Use code ${color.green.bold.underline(`PLEX`)} for 10% OFF!`);
   console.log("                                                                          ");
   console.log("――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――");
   console.log(color.yellow("[DASHBOARD] ") + `Web Server has started and is accessible with port ${color.yellow(`${config.PageSettings.Port}`)}`)

   try {
     const pingRes = await ping.promise.probe('8.8.8.8');
     if (pingRes.alive) {
       if(config.DebugMode) console.log(`Ping to 8.8.8.8 successful. Server has sufficient permissions.`);
     }
   } catch (error) {
     console.warn(
       color.yellow.bold('\n\n[WARNING] ') + 
       'Since you are hosting the application on pterodactyl, or similar and it does not have access to pinging, \nDirect IP pinging won\'t work. ' +
       'We will be forced to ping IPs externally through our own API (ping.plexdevelopment.net). ' +
       '\nIt will still work, so don\'t worry. ' +
       color.gray('\nYou can safely ignore this message. (It only affects the IP type) ') +
       '\nHowever, we recommend hosting it on a VPS or another environment if you want to ping everything yourself.\n\n'
     );
   }

   await startServices();
});

const packageFile = require('./package.json');

async function uploadToHaste(textToUpload) {
 try {
   const response = await axios.post('https://paste.plexdevelopment.net/documents', textToUpload, {
     timeout: 10000
   });
   return response.data.key;
 } catch (error) {
   if (error.response) {
     console.error('Error uploading to Haste-server. Status:', error.response.status);
     console.error('Response data:', error.response.data);
   } else {
     console.error('Error uploading to Haste-server:', error.message);
   }
   return null;
 }
}

const filePath = './logs.txt';
const maxLength = 300;

async function handleAndUploadError(errorType, error) {
 console.log(error);

 const errorPrefix = `[${new Date().toLocaleString()}] [${errorType}] [v${packageFile.version}]`;
 const errorMsg = `\n\n${errorPrefix}\n${error.stack}`;
 fs.appendFile("./logs.txt", errorMsg, (e) => {
   if (e) console.log(e);
 });

 fs.readFile(filePath, 'utf8', (err, data) => {
   if (err) {
     console.error('Error reading file:', err.message);
     return;
   }

   const lines = data.split('\n');
   const truncatedContent = lines.length > maxLength ? lines.slice(-maxLength).join('\n') : data;

   uploadToHaste(truncatedContent).then(key => {
     if (key) {
       const hasteURL = `https://paste.plexdevelopment.net/${key}`;
       console.log(`${color.green.bold(`[v${packageFile.version}]`)} ${color.red(`If you require assistance, create a ticket in our Discord server and share this link:`)} ${color.yellow(hasteURL)}\n\n`);
     } else {
       console.log('Paste Upload failed.');
     }
   });
 });
}

process.on('warn', async (error) => {
 handleAndUploadError('WARN', error);
});

process.on('error', async (error) => {
 handleAndUploadError('ERROR', error);
});

process.on('unhandledRejection', async (error) => {
 handleAndUploadError('unhandledRejection', error);
});

process.on('uncaughtException', async (error) => {
 handleAndUploadError('uncaughtException', error);
});