const express = require('express');
const cors = require('cors');

// v3 node-fetch wrapper
const fetch = (...args) =>
  import('node-fetch').then(({ default: fetch }) => fetch(...args));

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// 👉 heel simpel in-memory opslag van tokens
// (bij Render wordt dit geleegd bij restart, maar prima om te beginnen)
const tokens = new Set();

// Health check
app.get('/', (req, res) => {
  res.json({ ok: true, message: 'Festibal push backend werkt 🎉' });
});

/**
 * POST /register-token
 * body: { token: "ExponentPushToken[...]" }
 */
app.post('/register-token', (req, res) => {
  const { token } = req.body;

  console.log('Ontvangen register-token:', token);

  if (!token || typeof token !== 'string') {
    return res.status(400).json({
      ok: false,
      error: 'Ongeldig token',
    });
  }

  tokens.add(token);
  console.log('Aantal geregistreerde tokens:', tokens.size);

  return res.json({ ok: true });
});

/**
 * POST /send-notification
 * (blijft bestaan voor 1 specifieke token – handig voor testen)
 * body: { to, title, body }
 */
app.post('/send-notification', async (req, res) => {
  const { to, title, body } = req.body;

  console.log('Ontvangen /send-notification body:', req.body);

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
 * POST /broadcast
 * Stuurt naar ALLE geregistreerde tokens
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

  if (tokens.size === 0) {
    return res.status(400).json({
      ok: false,
      error: 'Geen geregistreerde tokens om naar te sturen',
    });
  }

  const messages = Array.from(tokens).map((to) => ({
    to,
    title,
    body,
  }));

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

    // Basis-check
    if (!Array.isArray(data.data) || data.data.length === 0) {
      return res.status(500).json({
        ok: false,
        error: 'Ongeldige Expo push response',
        expo: data,
      });
    }

    // We geven gewoon alle tickets terug
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
