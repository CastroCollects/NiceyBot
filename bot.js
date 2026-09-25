require('dotenv').config();
const tmi = require('tmi.js');
const fs = require('fs');
const path = require('path');

function loadData() {
  const raw = fs.readFileSync(path.join(__dirname, 'data.json'), 'utf8');
  return JSON.parse(raw);
}

const { TWITCH_BOT_USERNAME, TWITCH_OAUTH_TOKEN, TWITCH_CHANNELS } = process.env;

if (!TWITCH_BOT_USERNAME || !TWITCH_OAUTH_TOKEN || !TWITCH_CHANNELS) {
  console.error(
    'Missing required .env values. Copy .env.example to .env and fill in ' +
    'TWITCH_BOT_USERNAME, TWITCH_OAUTH_TOKEN, and TWITCH_CHANNELS.'
  );
  process.exit(1);
}

const channels = TWITCH_CHANNELS.split(',').map((c) => c.trim()).filter(Boolean);

const client = new tmi.Client({
  identity: {
    username: TWITCH_BOT_USERNAME,
    password: TWITCH_OAUTH_TOKEN,
  },
  channels,
});

client.connect().catch((err) => {
  console.error('Failed to connect to Twitch:', err);
  process.exit(1);
});

client.on('connected', (addr, port) => {
  console.log(`NiceyBot connected to ${addr}:${port}, joining: ${channels.join(', ')}`);
});

function normalizeKey(str) {
  return str.toLowerCase().replace(/[^a-z0-9]/g, '');
}

client.on('message', (channel, tags, message, self) => {
  if (self) return;
  if (!message.startsWith('!')) return;

  const parts = message.slice(1).trim().split(/\s+/);
  const command = parts.shift()?.toLowerCase();
  const query = parts.join(' ').trim();

  if (!command) return;

  let data;
  try {
    data = loadData();
  } catch (err) {
    console.error('Failed to read data.json:', err);
    return;
  }

  const category = data[command];
  if (!category) return;

  if (!query) {
    client.say(channel, `@${tags['display-name']} usage: !${command} <name> — e.g. !${command} Haaland`);
    return;
  }

  const normalizedQuery = normalizeKey(query);
  const matchKey = Object.keys(category).find(
    (key) => normalizeKey(key) === normalizedQuery
  );

  if (!matchKey) {
    client.say(
      channel,
      `@${tags['display-name']} no ${command} entry found for "${query}" yet — check back after the sheet's updated!`
    );
    return;
  }

  client.say(channel, `@${tags['display-name']} ${category[matchKey]}`);
});
