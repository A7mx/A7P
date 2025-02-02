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

// Dynamically load server IDs from .env and assign numbers (#1, #2, etc.)
const serverMap = new Map(); // Maps server number to server ID
for (let i = 1; ; i++) {
  const serverId = process.env[`server_id${i}`];
  if (!serverId) break; // Stop when no more server IDs are found
  serverMap.set(i, serverId.trim()); // Assign server number (e.g., 1 -> SERVER_ID_1)
}

// Validate environment variables
if (!botToken || !webhookUrl || !apiKey || serverMap.size === 0) {
  console.error('Missing required environment variables. Please check your .env file.');
  process.exit(1);
}

// Initialize Discord client
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// Local caches
const flaggedPlayersCache = {}; // Stores flagged players per server ID

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

// Fetch online players for a specific server
const getOnlinePlayers = async (serverId, serverNumber) => {
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

      console.log(`API Response (Players for Server #${serverNumber}):`, JSON.stringify(response.data, null, 2));

      if (!response.data || !response.data.data || response.data.data.length === 0) {
        console.log(`No online players found for server #${serverNumber}.`);
        break;
      }

      allPlayers = allPlayers.concat(response.data.data);
      nextPage = response.data.links?.next || null; // Check for next page
    }

    console.log(`Found ${allPlayers.length} online players for server #${serverNumber}.`);
    return allPlayers; // Return all players without slicing
  } catch (error) {
    console.error(`Error fetching players for server #${serverNumber}:`, error.message);
    return [];
  }
};

// Fetch player flags for a specific player
const getPlayerFlags = async (playerId, serverNumber) => {
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
    console.log(`API Response (Player Flags for Player ${playerId} on Server #${serverNumber}):`, JSON.stringify(response.data, null, 2));

    if (!response.data || !response.data.included || response.data.included.length === 0) {
      console.log(`No flags found for player ID ${playerId} on server #${serverNumber}.`);
      return [];
    }

    console.log(`Found ${response.data.included.length} flags for player ID ${playerId} on server #${serverNumber}.`);
    return response.data.included.filter(item => item.type === 'playerFlag');
  } catch (error) {
    console.error(`Error fetching player flags for player ID ${playerId} on server #${serverNumber}:`, error.message);
    return [];
  }
};

// Send Discord notification for flagged players
const sendDiscordNotification = async (serverNumber, playerName, flagName, flagDescription, steamProfileUrl, steamAvatarUrl) => {
  const data = {
    embeds: [
      {
        title: `⚠️ Possible Cheater Detected on Server #${serverNumber}`,
        description: `Player **${playerName}** has the flag: **${flagName}**.\n\nDescription: ${flagDescription}`,
        url: steamProfileUrl, // Link to the player's Steam profile
        thumbnail: {
          url: steamAvatarUrl || 'https://i.ibb.co/sp9fyrSv/A7.png', // Default avatar if none is provided
        },
        color: 16711680, // Red color for warnings
        footer: {
          text: `Server #${serverNumber} | Powered by @A7madShooter | @Xeco`,
        },
      },
    ],
  };

  try {
    const response = await axios.post(webhookUrl, data);
    if (response.status === 204) {
      console.log(`Notification sent for player: ${playerName} on server #${serverNumber}`);
    }
  } catch (error) {
    console.error(`Failed to send Discord notification for server #${serverNumber}:`, error.message);
  }
};

// Check players and send notifications for a specific server
const checkPlayersForServer = async (serverNumber, serverId) => {
  console.log(`Fetching online players for server #${serverNumber} (ID: ${serverId})...`);
  const players = await getOnlinePlayers(serverId, serverNumber);

  if (players.length === 0) {
    console.log(`No online players to check for server #${serverNumber}.`);
    return;
  }

  // Initialize cache for this server if it doesn't exist
  if (!flaggedPlayersCache[serverId]) {
    flaggedPlayersCache[serverId] = new Set();
  }

  for (const player of players) {
    const playerName = player.attributes.name;
    const playerId = player.id;
    const steamProfileUrl = player.attributes.profile || null; // Steam profile URL
    const steamAvatarUrl = player.attributes.avatar || null; // Steam avatar URL

    // Skip if the player has already been flagged for this server
    if (flaggedPlayersCache[serverId].has(playerId)) {
      console.log(`Player ${playerName} (ID: ${playerId}) on server #${serverNumber} has already been flagged. Skipping...`);
      continue;
    }

    console.log(`Checking player: ${playerName} on server #${serverNumber}`);

    const flags = await getPlayerFlags(playerId, serverNumber); // Call the getPlayerFlags function
    if (flags.length > 0) {
      for (const flag of flags) {
        const flagName = flag.attributes.name;
        const flagDescription = flag.attributes.description || 'No description provided.';
        console.log(`Player ${playerName} on server #${serverNumber} is Online He is a: ${flagName}`);

        // Case-insensitive flag matching
        if (flagName.trim().toLowerCase() === 'possible cheater') {
          await sendDiscordNotification(
            serverNumber,
            playerName,
            flagName,
            flagDescription,
            steamProfileUrl,
            steamAvatarUrl
          );

          // Add the player to the flagged cache for this server
          flaggedPlayersCache[serverId].add(playerId);
          console.log(`Added player ${playerName} (ID: ${playerId}) to the flagged cache for server #${serverNumber}.`);
        }
      }
    }
  }
};

// Check players for all servers sequentially
const checkServers = async () => {
  const now = Date.now();
  const resetInterval = 60000; // 1 minute in milliseconds

  // Reset the API call counter if the interval has passed
  if (now - lastResetTime >= resetInterval) {
    apiCallCount = 0;
    lastResetTime = now;
  }

  // Loop through all servers sequentially
  for (const [serverNumber, serverId] of serverMap.entries()) {
    console.log(`Starting checks for server #${serverNumber} (ID: ${serverId})...`);

    // Check players
    await checkPlayersForServer(serverNumber, serverId);

    // Stop checking if the global API call limit is reached
    if (apiCallCount >= maxApiCallsPerMinute) {
      console.log(`Reached the maximum API call limit (${maxApiCallsPerMinute}/minute). Pausing checks until the next minute.`);
      break;
    }
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
