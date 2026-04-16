const { sql } = require('@vercel/postgres');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.headers['x-setup-key'] !== process.env.SETUP_KEY) {
    return res.status(403).json({ error: 'Acces refuse' });
  }

  try {
    await sql`
      CREATE TABLE IF NOT EXISTS users (
        id                    SERIAL PRIMARY KEY,
        email                 VARCHAR(255) UNIQUE NOT NULL,
        password_hash         VARCHAR(255) NOT NULL,
        prenom                VARCHAR(100),
        telephone             VARCHAR(20),
        activite              VARCHAR(100),
        sms_message           TEXT DEFAULT 'Bonjour, je suis actuellement occupe. Je vous rappelle des que possible.',
        stripe_customer_id    VARCHAR(100),
        stripe_subscription_id VARCHAR(100),
        subscription_status   VARCHAR(50) DEFAULT 'trial',
        created_at            TIMESTAMP DEFAULT NOW()
      )
    `;

    return res.status(200).json({ success: true, message: 'Table users creee avec succes' });
  } catch (err) {
    console.error('[setup-db] Erreur:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
