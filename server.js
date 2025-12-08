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

// —————————————————————————
//  DB setup: expo_tokens
// —————————————————————————
async function ensureTokenTable() {
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

ensureTokenTable().catch((err) => {
  console.error('Fout bij aanmaken tabel expo_tokens:', err);
});

// —————————————————————————
//  DB setup: news_items
// —————————————————————————
async function ensureNewsTable() {
  if (!process.env.DATABASE_URL) {
    console.warn('⚠️ DATABASE_URL is niet ingesteld, nieuws wordt niet opgeslagen.');
    return;
  }

  const sql = `
    CREATE TABLE IF NOT EXISTS news_items (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `;

  await pool.query(sql);
  console.log('✅ Tabel news_items is klaar.');
}

ensureNewsTable().catch((err) => {
  console.error('Fout bij aanmaken tabel news_items:', err);
});

// —————————————————————————
//  Health check
// —————————————————————————
app.get('/', (req, res) => {
  res.json({ ok: true, message: 'Festibal push backend werkt 🎉' });
});

// —————————————————————————
//  Nieuws endpoints
// —————————————————————————

/**
 * GET /news
 * Haalt alle nieuwsberichten op, nieuwste eerst
 */
app.get('/news', async (req, res) => {
  if (!process.env.DATABASE_URL) {
    return res.status(500).json({
      ok: false,
      error: 'DATABASE_URL ontbreekt, geen databaseverbinding voor nieuws.',
    });
  }

  try {
    const { rows } = await pool.query(
      `
      SELECT
        id,
        title,
        message,
        created_at AS "createdAt"
      FROM news_items
      ORDER BY created_at DESC;
      `
    );

    return res.json(rows);
  } catch (err) {
    console.error('Fout bij ophalen nieuws:', err);
    return res.status(500).json({
      ok: false,
      error: 'DB error bij ophalen nieuws',
    });
  }
});

/**
 * POST /news
 * body: { title: string, message: string }
 */
app.post('/news', async (req, res) => {
  if (!process.env.DATABASE_URL) {
    return res.status(500).json({
      ok: false,
      error: 'DATABASE_URL ontbreekt, nieuws kan niet opgeslagen worden.',
    });
  }

  const { title, message } = req.body;

  if (!title || !message) {
    return res.status(400).json({
      ok: false,
      error: 'title en message zijn verplicht',
    });
  }

  try {
    const { rows } = await pool.query(
      `
      INSERT INTO news_items (title, message)
      VALUES ($1, $2)
      RETURNING
        id,
        title,
        message,
        created_at AS "createdAt";
      `,
      [title, message]
    );

    const created = rows[0];

    // 🔔 Optioneel: automatisch een broadcast versturen
    // try {
    //   await autoBroadcastNews(created);
    // } catch (e) {
    //   console.warn('Kon auto broadcast voor nieuws niet versturen:', e);
    // }

    return res.status(201).json(created);
  } catch (err) {
    console.error('Fout bij opslaan nieuws:', err);
    return res.status(500).json({
      ok: false,
      error: 'DB error bij opslaan nieuws',
    });
  }
});

// —————————————————————————
//  Token registratie & push
// —————————————————————————

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
    return res.json({
      ok: true,
      warning: 'Token niet persistent opgeslagen (geen DATABASE_URL).',
    });
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
 * (optioneel) Single-token endpoint voor testen
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

// —————————————————————————
//  Helper: sturen naar Expo
// —————————————————————————
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

// —————————————————————————
//  (Optioneel) Auto broadcast bij nieuws
// —————————————————————————
// async function autoBroadcastNews(newsItem) {
//   if (!process.env.DATABASE_URL) {
//     throw new Error('Geen DATABASE_URL, kan geen auto broadcast doen.');
//   }
//
//   const { title, message } = newsItem;
//   const { rows } = await pool.query('SELECT token FROM expo_tokens;');
//
//   if (!rows || rows.length === 0) {
//     console.log('Geen tokens voor auto broadcast, skip.');
//     return;
//   }
//
//   const messages = rows.map((row) => ({
//     to: row.token,
 //     title: title,
 //     body: message,
//   }));
//
//   // We negeren hier de HTTP response richting client, puur fire & forget
//   await sendToExpo(messages, { json: () => {}, status: () => ({ json: () => {} }) });
// }

// —————————————————————————
//  Start server
// —————————————————————————
app.listen(PORT, () => {
  console.log(`Festibal push backend draait op port ${PORT}`);
});
