const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

// v3 node-fetch wrapper
const fetch = (...args) =>
  import('node-fetch').then(({ default: fetch }) => fetch(...args));

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// 🔧 PostgreSQL pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.NODE_ENV === 'production'
      ? { rejectUnauthorized: false }
      : false,
});

// 👇 Zorg dat de tabel bestaat
async function ensureTable() {
  if (!process.env.DATABASE_URL) {
    console.warn('⚠️ DATABASE_URL is niet ingesteld, tokens worden niet opgeslagen.');
    return;
  }

  const sql = `
    CREATE TABLE IF NOT EXISTS expo_tokens (
      id SERIAL PRIMARY KEY,
      token TEXT UNIQUE NOT NULL,
      platform TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ DEFAULT NOW()
    );
  `;

  await pool.query(sql);
  console.log('✅ Tabel expo_tokens is klaar.');
}

ensureTable().catch((err) => {
  console.error('Fout bij aanmaken tabel expo_tokens:', err);
});

app.get('/', (req, res) => {
  res.json({ ok: true, message: 'Festibal push backend werkt 🎉' });
});

/**
 * POST /register-token
 * body: { token: "ExponentPushToken[...]", platform?: "ios" | "android" }
 */
app.post('/register-token', async (req, res) => {
  const { token, platform } = req.body;

  console.log('Ontvangen register-token:', token, platform);

  if (!token || typeof token !== 'string') {
    return res.status(400).json({ ok: false, error: 'Ongeldig token' });
  }

  if (!process.env.DATABASE_URL) {
    console.warn('DATABASE_URL ontbreekt, token wordt niet in DB opgeslagen.');
    return res.json({ ok: true, warning: 'Token niet persistent opgeslagen (geen DATABASE_URL).' });
  }

  try {
    await pool.query(
      `
      INSERT INTO expo_tokens (token, platform)
      VALUES ($1, $2)
      ON CONFLICT (token)
      DO UPDATE SET last_seen_at = NOW(), platform = COALESCE($2, expo_tokens.platform);
      `,
      [token, platform || null]
    );

    const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM expo_tokens;');
    console.log('Aantal geregistreerde tokens in DB:', rows[0].count);

    return res.json({ ok: true });
  } catch (err) {
    console.error('Fout bij opslaan token:', err);
    return res.status(500).json({ ok: false, error: 'DB error bij opslaan token' });
  }
});

/**
 * POST /broadcast
 * body: { title, body }
 */
app.post('/broadcast', async (req, res) => {
  const { title, body } = req.body;

  console.log('Ontvangen /broadcast body:', req.body);

  if (!title || !body) {
    return res.status(400).json({
      ok: false,
      error: 'title en body zijn verplicht',
    });
  }

  if (!process.env.DATABASE_URL) {
    return res.status(500).json({
      ok: false,
      error: 'DATABASE_URL ontbreekt, geen tokens beschikbaar.',
    });
  }

  try {
    const { rows } = await pool.query('SELECT token FROM expo_tokens;');

    if (!rows || rows.length === 0) {
      return res.status(400).json({
        ok: false,
        error: 'Geen geregistreerde tokens om naar te sturen',
      });
    }

    const messages = rows.map((row) => ({
      to: row.token,
      title,
      body,
    }));

    return sendToExpo(messages, res);
  } catch (err) {
    console.error('Fout bij ophalen tokens:', err);
    return res.status(500).json({
      ok: false,
      error: 'DB error bij ophalen tokens',
    });
  }
});

/**
 * (optioneel) Oude single-token endpoint laten staan voor testen
 * POST /send-notification
 * body: { to, title, body }
 */
app.post('/send-notification', async (req, res) => {
  const { to, title, body } = req.body;

  if (!to || !title || !body) {
    return res.status(400).json({
      ok: false,
      error: 'to, title en body zijn verplicht',
    });
  }

  const messages = [{ to, title, body }];
  return sendToExpo(messages, res);
});

/**
 * Helper: stuurt messages-array naar Expo
 */
async function sendToExpo(messages, res) {
  try {
    const response = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Accept-encoding': 'gzip, deflate',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(messages),
    });

    const data = await response.json();
    console.log('Expo push response raw:', JSON.stringify(data, null, 2));

    if (!Array.isArray(data.data) || data.data.length === 0) {
      return res.status(500).json({
        ok: false,
        error: 'Ongeldige Expo push response',
        expo: data,
      });
    }

    return res.json({ ok: true, tickets: data.data });
  } catch (err) {
    console.error('Fout bij versturen push:', err);
    return res.status(500).json({
      ok: false,
      error: 'Push failed (server error)',
    });
  }
}

app.listen(PORT, () => {
  console.log(`Festibal push backend draait op http://localhost:${PORT}`);
});
