const { sql } = require('@vercel/postgres');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Methode non autorisee' });

  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'Email et mot de passe requis' });
  }

  try {
    const { rows } = await sql`
      SELECT * FROM users WHERE email = ${email.toLowerCase().trim()} LIMIT 1
    `;
    const user = rows[0];

    if (!user) {
      return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
    }

    if (user.subscription_status === 'canceled') {
      return res.status(403).json({ error: 'Abonnement annule. Contactez le support.' });
    }

    const token = jwt.sign(
      { userId: user.id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    return res.status(200).json({
      token,
      user: {
        id: user.id,
        email: user.email,
        prenom: user.prenom,
        telephone: user.telephone,
        activite: user.activite,
        sms_message: user.sms_message,
        subscription_status: user.subscription_status
      }
    });
  } catch (err) {
    console.error('[login] Erreur:', err.message);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
};
