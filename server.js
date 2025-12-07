const express = require('express');
const cors = require('cors');

// v3 node-fetch, via dynamic import wrapper
const fetch = (...args) =>
  import('node-fetch').then(({ default: fetch }) => fetch(...args));

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ ok: true, message: 'Festibal push backend werkt 🎉' });
});

// 👉 POST /send-notification
// body: { to: "ExponentPushToken[...]", title: "...", body: "..." }
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

    const ticket = data.data[0];

    if (ticket.status === 'ok') {
      return res.json({ ok: true, ticket });
    } else {
      return res.status(400).json({
        ok: false,
        error: ticket.message || 'Expo push error',
        details: ticket.details || null,
      });
    }
  } catch (err) {
    console.error('Fout bij versturen push:', err);
    return res.status(500).json({
      ok: false,
      error: 'Push failed (server error)',
    });
  }
});

app.listen(PORT, () => {
  console.log(`Festibal push backend draait op http://localhost:${PORT}`);
});
