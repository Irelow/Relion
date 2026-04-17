const { sql } = require('@vercel/postgres');

// Endpoint one-shot pour créer la table users
// A appeler UNE SEULE FOIS avec le header x-setup-key
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Protection par clé secrète
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

    await sql`
      CREATE TABLE IF NOT EXISTS appointments (
        id         SERIAL PRIMARY KEY,
        date       DATE NOT NULL,
        time_slot  VARCHAR(5) NOT NULL,
        name       VARCHAR(100),
        phone      VARCHAR(30),
        phone_norm VARCHAR(20),
        email      VARCHAR(255),
        status     VARCHAR(20) DEFAULT 'booked',
        notes      TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(date, time_slot)
      )
    `;

    // Migration : ajouter phone_norm si la table existe déjà sans cette colonne
    await sql`
      ALTER TABLE appointments ADD COLUMN IF NOT EXISTS phone_norm VARCHAR(20)
    `.catch(() => {});

    // Index sur phone_norm pour les lookups rapides
    await sql`
      CREATE INDEX IF NOT EXISTS idx_appointments_phone_norm ON appointments(phone_norm)
    `.catch(() => {});

    await sql`
      CREATE TABLE IF NOT EXISTS pending_registrations (
        id            SERIAL PRIMARY KEY,
        email         VARCHAR(255) UNIQUE NOT NULL,
        telephone     VARCHAR(20) NOT NULL,
        prenom        VARCHAR(100) NOT NULL,
        nom           VARCHAR(100),
        password_hash VARCHAR(255) NOT NULL,
        resend_count  INT DEFAULT 0,
        last_resend_at TIMESTAMPTZ DEFAULT NOW(),
        created_at    TIMESTAMPTZ DEFAULT NOW(),
        expires_at    TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '24 hours')
      )
    `;

    return res.status(200).json({ success: true, message: 'Tables users, appointments et pending_registrations creees' });
  } catch (err) {
    console.error('[setup-db] Erreur:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
