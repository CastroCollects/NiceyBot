// NiceyBot — Twitch chat bot that answers pre-drafted "spot" checklist questions.
//
// Command format:
//   !spots <set> <query...>
//   e.g. "!spots royalty Arsenal Wenger" or "!spots royalty Wenger"
//
// Each product lives in its own plain-text file in the data/ folder, named
// after the set (e.g. data/royalty.txt is the "royalty" set). Every line in
// that file is one spot, formatted as:
//   Display Name | The answer to show in chat
// Blank lines and lines starting with # are ignored, so you can leave notes.
//
// Matching is fuzzy on purpose: word order doesn't matter, accents/punctuation
// are ignored, and a query only needs to be a partial match against the
// spot's name — so "Arsenal Wenger", "Arsene Wenger", "Wenger", and
// "Arsenal  Arsene Wenger" (extra space) all find the same spot.
//
// Run locally with: npm install && npm start
// (requires a .env file — copy .env.example to .env and fill it in first)

require('dotenv').config();
const tmi = require('tmi.js');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');

// ---- Loading the data/ folder ----
// Every .txt file in data/ becomes one set, named after the file
// (data/royalty.txt -> set "royalty"). Re-read on every lookup so edits
// take effect after a restart without touching any code.
function loadSets() {
  const sets = {};

  if (!fs.existsSync(DATA_DIR)) {
    return sets;
  }

  const files = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith('.txt'));

  for (const file of files) {
    const setName = path.basename(file, '.txt').toLowerCase();
    const raw = fs.readFileSync(path.join(DATA_DIR, file), 'utf8');
    const spots = [];

    raw.split(/\r?\n/).forEach((line, index) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return; // blank line or comment

      const pipeIndex = trimmed.indexOf('|');
      if (pipeIndex === -1) {
        console.warn(`[${file}] line ${index + 1} has no "|" separator, skipping: ${trimmed}`);
        return;
      }

      const display = trimmed.slice(0, pipeIndex).trim();
      const description = trimmed.slice(pipeIndex + 1).trim();
      if (!display || !description) {
        console.warn(`[${file}] line ${index + 1} is missing a name or description, skipping.`);
        return;
      }

      spots.push({ display, description });
    });

    sets[setName] = { spots };
  }

  return sets;
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

// ---- Temporary debug logging ----
// Helps confirm the bot is actually joining the channel and receiving chat
// messages at all. Safe to remove once things are confirmed working.
client.on('join', (channel, username, self) => {
  if (self) console.log(`[debug] Successfully joined ${channel}`);
});

client.on('disconnected', (reason) => {
  console.log(`[debug] Disconnected: ${reason}`);
});

client.on('notice', (channel, msgid, message) => {
  console.log(`[debug] NOTICE on ${channel} (${msgid}): ${message}`);
});

// ---- Text matching helpers ----

// A few accented letters aren't decomposed by Unicode NFD normalization
// (Ø, Æ, etc. are distinct letters, not letter+accent), so map those by hand
// before running the standard accent-stripping pass.
const MANUAL_CHAR_MAP = {
  'ø': 'o', 'Ø': 'O',
  'æ': 'ae', 'Æ': 'AE',
  'đ': 'd', 'Đ': 'D',
  'ß': 'ss',
  'ł': 'l', 'Ł': 'L',
};

function stripDiacritics(str) {
  let out = '';
  for (const ch of str) {
    out += MANUAL_CHAR_MAP[ch] !== undefined ? MANUAL_CHAR_MAP[ch] : ch;
  }
  return out.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Turns any string into a lowercase array of alphanumeric tokens, with
// accents stripped and punctuation (including "+") treated as a separator.
function tokenize(str) {
  return stripDiacritics(str)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

// A spot matches a query if every query token is a substring of at least
// one of the spot's tokens. Order doesn't matter, partial words are OK
// ("wenge" still matches "wenger"), and leaving out words (like the team
// name) is fine as long as what IS typed narrows it down to one spot.
function spotMatchesQuery(spotTokens, queryTokens) {
  return queryTokens.every((qt) => spotTokens.some((st) => st.includes(qt)));
}

function findMatches(spots, query) {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];
  return spots.filter((spot) => spotMatchesQuery(spot.tokens, queryTokens));
}

// ---- Command handling ----

client.on('message', (channel, tags, message, self) => {
  if (self) return;
  console.log(`[debug] ${channel} ${tags['display-name']}: ${message}`);
  if (!message.startsWith('!')) return;

  const parts = message.slice(1).trim().split(/\s+/);
  const command = parts.shift()?.toLowerCase();
  if (command !== 'spots') return; // only !spots is wired up right now

  const user = tags['display-name'];
  const setName = parts.shift()?.toLowerCase();
  const query = parts.join(' ').trim();

  const sets = loadSets();

  if (!setName) {
    const available = Object.keys(sets).join(', ') || '(none configured yet)';
    client.say(channel, `@${user} usage: !spots <set> <name> — available sets: ${available}`);
    return;
  }

  const set = sets[setName];
  if (!set) {
    const available = Object.keys(sets).join(', ') || '(none configured yet)';
    client.say(channel, `@${user} no set called "${setName}" — available sets: ${available}`);
    return;
  }

  if (!query) {
    client.say(channel, `@${user} usage: !spots ${setName} <name> — e.g. !spots ${setName} Haaland`);
    return;
  }

  const spotsWithTokens = set.spots.map((spot) => ({
    ...spot,
    tokens: tokenize(spot.display),
  }));

  const matches = findMatches(spotsWithTokens, query);

  if (matches.length === 0) {
    client.say(channel, `@${user} no spot found matching "${query}" in ${setName} — try a team or player name.`);
    return;
  }

  if (matches.length > 1) {
    const names = matches.slice(0, 5).map((m) => m.display).join(' | ');
    client.say(channel, `@${user} that matches more than one spot: ${names} — try being more specific.`);
    return;
  }

  client.say(channel, `@${user} ${matches[0].description}`);
});
