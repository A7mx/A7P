// Use ES module syntax
import 'dotenv/config';
import { Client, GatewayIntentBits } from 'discord.js';
import axios from 'axios';
import express from 'express';

const app = express();
const port = process.env.PORT || 3000;

// Environment variables
const botToken = process.env.botToken;
const webhookUrl = process.env.webhookUrl; // For cheater notifications
const apiKey = process.env.apiKey;
const serverId = process.env.server_id2; // Server ID for Server #1

// Validate environment variables
if (!botToken || !webhookUrl || !apiKey || !serverId) {
  console.error('Missing required environment variables. Please check your .env file.');
  process.exit(1);
}

// Initialize Discord client
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// Local caches
const flaggedPlayersCache = new Set(); // Tracks flagged players currently online
const previousFlaggedPlayers = new Set(); // Tracks previously flagged players for removal

// Rate limiting variables
const maxApiCallsPerMinute = 60; // Maximum allowed API calls per minute
let apiCallCount = 0; // Tracks the total number of API calls made in the current minute
let lastResetTime = Date.now(); // Tracks the last reset time for the global API call counter

// Function to enforce global rate limiting
const enforceRateLimit = async () => {
  const now = Date.now();
  const resetInterval = 60000; // 1 minute in milliseconds

  // Reset the counter if the interval has passed
  if (now - lastResetTime >= resetInterval) {
    apiCallCount = 0;
    lastResetTime = now;
  }

  // Enforce rate limiting
  if (apiCallCount >= maxApiCallsPerMinute) {
    console.log(`Reached the maximum API call limit (${maxApiCallsPerMinute}/minute). Waiting...`);
    await new Promise(resolve => setTimeout(resolve, resetInterval - (now - lastResetTime)));
    apiCallCount = 0; // Reset the counter after waiting
  }

  apiCallCount++;
};

// Fetch online players for Server #1
const getOnlinePlayers = async () => {
  let allPlayers = [];
  let nextPage = `https://api.battlemetrics.com/players?filter[servers]=${serverId}&filter[online]=true&fields[player]=name&page[size]=100&sort=-updatedAt`;

  try {
    while (nextPage && allPlayers.length < 100) {
      await enforceRateLimit(); // Enforce rate limiting before making the API call

      const response = await axios.get(nextPage, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      });

      console.log(`API Response (Players for Server #1):`, JSON.stringify(response.data, null, 2));

      if (!response.data || !response.data.data || response.data.data.length === 0) {
        console.log(`No online players found for Server #1.`);
        break;
      }

      allPlayers = allPlayers.concat(response.data.data);
      nextPage = response.data.links?.next || null; // Check for next page
    }

    console.log(`Found ${allPlayers.length} online players for Server #1.`);
    return allPlayers; // Return all players without slicing
  } catch (error) {
    console.error(`Error fetching players for Server #1:`, error.message);
    return [];
  }
};

// Fetch player flags for a specific player
const getPlayerFlags = async (playerId) => {
  const url = `https://api.battlemetrics.com/players/${playerId}`;
  const headers = {
    Authorization: `Bearer ${apiKey}`,
  };
  const params = {
    include: 'playerFlag',
    'fields[playerFlag]': 'name,description',
  };

  try {
    await enforceRateLimit(); // Enforce rate limiting before making the API call

    const response = await axios.get(url, { headers, params });
    console.log(`API Response (Player Flags for Player ${playerId}):`, JSON.stringify(response.data, null, 2));

    if (!response.data || !response.data.included || response.data.included.length === 0) {
      console.log(`No flags found for player ID ${playerId}.`);
      return [];
    }

    console.log(`Found ${response.data.included.length} flags for player ID ${playerId}.`);
    return response.data.included.filter(item => item.type === 'playerFlag');
  } catch (error) {
    console.error(`Error fetching player flags for player ID ${playerId}:`, error.message);
    return [];
  }
};

// Send Discord notification for flagged players
const sendDiscordNotification = async (playerName, flagName, flagDescription, steamProfileUrl, steamAvatarUrl) => {
  const data = {
    embeds: [
      {
        title: `⚠️ Possible Cheater Detected on Server #1`,
        description: `Player **${playerName}** has the flag: **${flagName}**.\n\nDescription: ${flagDescription}`,
        url: steamProfileUrl, // Link to the player's Steam profile
        thumbnail: {
          url: steamAvatarUrl || 'https://cdn.discordapp.com/embed/avatars/0.png', // Default avatar if none is provided
        },
        color: 16711680, // Red color for warnings
        footer: {
          text: `Server #1 | Powered by A7 Servers`,
        },
      },
    ],
  };

  try {
    const response = await axios.post(webhookUrl, data);
    if (response.status === 204) {
      console.log(`Notification sent for player: ${playerName}`);
    }
  } catch (error) {
    console.error(`Failed to send Discord notification:`, error.message);
  }
};

// Remove Discord notification for players who left the server
const removeDiscordNotification = async (playerName) => {
  const data = {
    embeds: [
      {
        title: `✅ Possible Cheater Left Server #1`,
        description: `Player **${playerName}** is no longer online.`,
        color: 3447003, // Green color for removal
        footer: {
          text: `Server #1 | Powered by A7 Servers`,
        },
      },
    ],
  };

  try {
    const response = await axios.post(webhookUrl, data);
    if (response.status === 204) {
      console.log(`Removal notification sent for player: ${playerName}`);
    }
  } catch (error) {
    console.error(`Failed to send removal notification:`, error.message);
  }
};

// Check players and handle notifications for Server #1
const checkPlayersForServer = async () => {
  console.log(`Starting scan for all online players in Server #1...`);
  const players = await getOnlinePlayers();

  if (players.length === 0) {
    console.log(`No online players to check for Server #1.`);
    return;
  }

  console.log(`Processing ${players.length} online players in Server #1...`);

  // Track current flagged players during this scan
  const currentFlaggedPlayers = new Set();

  for (const player of players) {
    const playerName = player.attributes.name;
    const playerId = player.id;
    const steamProfileUrl = player.attributes.profile || null; // Steam profile URL
    const steamAvatarUrl = player.attributes.avatar || null; // Steam avatar URL

    console.log(`Checking player: ${playerName} (ID: ${playerId}) on Server #1`);

    const flags = await getPlayerFlags(playerId); // Call the getPlayerFlags function
    if (flags.length > 0) {
      for (const flag of flags) {
        const flagName = flag.attributes.name;
        const flagDescription = flag.attributes.description || 'No description provided.';
        console.log(`Player ${playerName} on Server #1 has flag: ${flagName}`);

        // Case-insensitive flag matching
        if (flagName.trim().toLowerCase() === 'possible cheater') {
          // Add the player to the current flagged players set
          currentFlaggedPlayers.add(playerId);

          // If the player is not already flagged, send a notification
          if (!flaggedPlayersCache.has(playerId)) {
            await sendDiscordNotification(
              playerName,
              flagName,
              flagDescription,
              steamProfileUrl,
              steamAvatarUrl
            );
            flaggedPlayersCache.add(playerId);
            console.log(`Added player ${playerName} (ID: ${playerId}) to the flagged cache.`);
          }
        }
      }
    }
  }

  // Identify players who are no longer online and remove their notifications
  for (const playerId of flaggedPlayersCache) {
    if (!currentFlaggedPlayers.has(playerId)) {
      const playerName = players.find(player => player.id === playerId)?.attributes.name || 'Unknown Player';
      await removeDiscordNotification(playerName);
      flaggedPlayersCache.delete(playerId);
      console.log(`Removed player ${playerName} (ID: ${playerId}) from the flagged cache.`);
    }
  }

  console.log(`Finished scanning all players in Server #1.`);
};

// Periodically check players for Server #1
const checkServers = async () => {
  const now = Date.now();
  const resetInterval = 60000; // 1 minute in milliseconds

  // Reset the API call counter if the interval has passed
  if (now - lastResetTime >= resetInterval) {
    apiCallCount = 0;
    lastResetTime = now;
  }

  // Check players for Server #1
  await checkPlayersForServer();

  // Stop checking if the global API call limit is reached
  if (apiCallCount >= maxApiCallsPerMinute) {
    console.log(`Reached the maximum API call limit (${maxApiCallsPerMinute}/minute). Pausing checks until the next minute.`);
  }
};

// Discord bot initialization
client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
  checkServers(); // Perform an initial check
  setInterval(checkServers, 60 * 1000); // Check every minute
});

// Start the bot
client.login(botToken).catch(error => {
  console.error('Failed to log in to Discord:', error.message);
});

// Start the Express server
app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
