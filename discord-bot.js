const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const yaml = require('js-yaml');
const fs = require('fs');
const DiscordMessage = require('./models/discordMessageModel');

const config = yaml.load(fs.readFileSync('./config.yml', 'utf8'));

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

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages
  ]
});

let statusMessage = null;

async function saveMessageId(messageId, channelId) {
  try {
    await DiscordMessage.findOneAndUpdate(
      {},
      {
        messageId,
        channelId,
        lastSaved: new Date()
      },
      {
        upsert: true,
        new: true
      }
    );
    if (config.DebugMode) {
      console.log(`[DISCORD] Message ID ${messageId} saved successfully to MongoDB`);
    }
  } catch (error) {
    console.error('[DISCORD] Failed to save message ID to MongoDB:', error.message);
  }
}

async function loadMessageId() {
  try {
    const savedMessage = await DiscordMessage.findOne().sort({ lastSaved: -1 });

    if (savedMessage) {
      if (config.DebugMode) {
        console.log(`[DISCORD] Loaded saved message ID from MongoDB: ${savedMessage.messageId}`);
      }
      return {
        messageId: savedMessage.messageId,
        channelId: savedMessage.channelId,
        lastSaved: savedMessage.lastSaved
      };
    }

    return null;
  } catch (error) {
    console.error('[DISCORD] Failed to load message ID from MongoDB:', error.message);
    return null;
  }
}

async function initializeBot() {
  if (!config.DiscordBot || !config.DiscordBot.Enabled) {
    return false;
  }

  try {
    const readyPromise = new Promise(resolve => {
      client.once('ready', () => {
        console.log(`[DISCORD] Bot is online as ${client.user.tag}`);
        resolve();
      });
    });

    await client.login(config.DiscordBot.Token);
    await readyPromise;

    const savedData = await loadMessageId();
    if (savedData && savedData.messageId && savedData.channelId) {
      try {
        const channel = client.channels.cache.get(savedData.channelId);
        if (!channel) {
          return true;
        }

        const message = await channel.messages.fetch(savedData.messageId)
          .catch(err => {
            return null;
          });

        if (message) {
          statusMessage = message;
        }
      } catch (error) {
        console.error('[DISCORD] Error retrieving saved message:', error.message);
      }
    }

    return true;
  } catch (error) {
    console.error('[DISCORD] Failed to initialize bot:', error.message);
    return false;
  }
}

function replaceVariables(text, variables) {
  if (!text) return '';

  let result = text;
  Object.keys(variables).forEach(key => {
    const regex = new RegExp(`{{${key}}}`, 'g');
    result = result.replace(regex, variables[key] || '');
  });

  return result;
}

function hexToDiscordColor(hex) {
  if (!hex || !hex.startsWith('#')) return 0x6b7280;
  return parseInt(hex.slice(1), 16);
}

function formatDuration(milliseconds) {
  const seconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) return `${hours}h`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}

let isUpdating = false;

async function updateStatusEmbeds(services, overallStatus, statusClass, lastUpdated) {
  if (!config.DiscordBot || !config.DiscordBot.Enabled || !client.isReady()) {
    return;
  }

  if (isUpdating) {
    if (config.DebugMode) {
      console.log('[DISCORD] Update already in progress, skipping');
    }
    return;
  }

  isUpdating = true;

  try {
    const guild = client.guilds.cache.get(config.DiscordBot.GuildID);
    if (!guild) {
      console.error(`[DISCORD] Could not find guild with ID ${config.DiscordBot.GuildID}`);
      return;
    }

    const channel = guild.channels.cache.get(config.DiscordBot.ChannelID);
    if (!channel) {
      console.error(`[DISCORD] Could not find channel with ID ${config.DiscordBot.ChannelID} in guild ${guild.name}`);
      return;
    }

    const statusEmbed = createStatusEmbed(services, overallStatus, statusClass, lastUpdated);

    if (statusMessage) {
      try {
        await statusMessage.edit({ embeds: [statusEmbed] });
        if (config.DebugMode) {
          console.log(`[DISCORD] Status embed updated at ${new Date().toISOString()}`);
        }
      } catch (error) {
        if (error.code === 10008) {
          if (config.DebugMode) {
            console.log('[DISCORD] Message was deleted, creating new one');
          }
          statusMessage = null;
        } else {
          console.error('[DISCORD] Error updating message:', error.message);
          statusMessage = null;
        }
      }
    }

    if (!statusMessage) {
      statusMessage = await channel.send({ embeds: [statusEmbed] });
      await saveMessageId(statusMessage.id, channel.id);
      if (config.DebugMode) {
        console.log('[DISCORD] New status message created');
      }
    }
  } catch (error) {
    console.error('[DISCORD] Error updating status embed:', error);
  } finally {
    isUpdating = false;
  }
}

function createStatusEmbed(services, overallStatus, statusClass, lastUpdated) {
  const embedConfig = config.DiscordEmbed || {};
  const currentTimestamp = Math.floor(Date.now() / 1000);

  const onlineServices = services.filter(s => s.status === 'online').length;
  const totalServices = services.length;
  const avgUptime = services.length > 0 ?
    (services.reduce((sum, s) => sum + parseFloat(s.uptimePercentage || 0), 0) / services.length).toFixed(1) : 0;

  const responseTimes = services.filter(s => s.responseTime > 0 && s.status === 'online');
  const avgResponseTime = responseTimes.length > 0 ?
    Math.round(responseTimes.reduce((sum, s) => sum + s.responseTime, 0) / responseTimes.length) : 0;

  const servicesByCategory = services.reduce((acc, service) => {
    const category = service.category || 'Uncategorized';
    if (!acc[category]) {
      acc[category] = [];
    }
    acc[category].push(service);
    return acc;
  }, {});

  let servicesText = '';
  Object.entries(servicesByCategory).forEach(([categoryName, categoryServices]) => {
    const formattedServices = categoryServices.map(service => {
      const normalizedStatus = service.status.charAt(0).toUpperCase() + service.status.slice(1).toLowerCase();
      const emoji = embedConfig.Emojis?.[normalizedStatus] || embedConfig.Emojis?.[service.status] || '⚪';
      const status = normalizedStatus;
      const uptime = service.uptimePercentage || '0';
      const responseTime = service.responseTime || 0;

      const serviceVars = {
        emoji: emoji,
        name: service.name,
        status: status,
        uptime: uptime,
        responseTime: responseTime
      };

      return replaceVariables(embedConfig.ServiceFormat || '{{emoji}} **{{name}}** - {{status}}', serviceVars);
    }).join('\n');

    const categoryVars = {
      categoryName: categoryName,
      services: formattedServices
    };

    const categoryText = replaceVariables(
      embedConfig.CategoryFormat || '**{{categoryName}}**\n{{services}}',
      categoryVars
    );

    servicesText += categoryText + '\n\n';
  });

  if (servicesText.trim()) {
    servicesText = servicesText.trim() + '\n\u200B\n\u200B\n\u200B';
  }

  const mainVars = {
    siteName: config.PageSettings.Name,
    overallStatus: overallStatus,
    timestamp: currentTimestamp,
    currentTimestamp: currentTimestamp,
    onlineCount: onlineServices,
    totalCount: totalServices,
    avgUptime: avgUptime,
    avgResponseTime: avgResponseTime,
    servicesText: servicesText.trim(),
    updateInterval: formatDuration(config.DiscordBot.UpdateInterval ?
      parseDuration(config.DiscordBot.UpdateInterval) : 180000)
  };

  const embed = new EmbedBuilder();

  const title = replaceVariables(embedConfig.Title || '{{siteName}} Status', mainVars);
  embed.setTitle(title);

  const description = replaceVariables(embedConfig.Description || '**{{overallStatus}}**\n\n{{servicesText}}', mainVars);
  embed.setDescription(description);

  const normalizedStatusClass = statusClass.charAt(0).toUpperCase() + statusClass.slice(1).toLowerCase();
  const colorHex = embedConfig.Colors?.[normalizedStatusClass] || embedConfig.Colors?.[statusClass] || '#6b7280';
  embed.setColor(hexToDiscordColor(colorHex));

  if (embedConfig.ShowFields !== false && embedConfig.Fields && Array.isArray(embedConfig.Fields)) {
    embedConfig.Fields.forEach(field => {
      if (field.Name && field.Value) {
        const fieldName = replaceVariables(field.Name, mainVars);
        const fieldValue = replaceVariables(field.Value, mainVars);

        embed.addFields({
          name: fieldName,
          value: fieldValue,
          inline: field.Inline || false
        });
      }
    });
  }

  if (embedConfig.ShowThumbnail !== false) {
    embed.setThumbnail(`${config.PageSettings.baseURL}/logo.png`);
  }

  if (embedConfig.ShowFooter !== false) {
    const footerText = replaceVariables(
      embedConfig.FooterText || '{{siteName}} Status',
      mainVars
    );
    embed.setFooter({ text: footerText });
  }

  return embed;
}

module.exports = {
  initializeBot,
  updateStatusEmbeds
};