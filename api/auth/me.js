const { sql } = require('@vercel/postgres');
const jwt = require('jsonwebtoken');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Methode non autorisee' });

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token manquant' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const { rows } = await sql`
      SELECT id, email, prenom, telephone, activite, sms_message, subscription_status, created_at
      FROM users WHERE id = ${decoded.userId} LIMIT 1
    `;
    const user = rows[0];

    if (!user) {
      return res.status(404).json({ error: 'Utilisateur introuvable' });
    }

    return res.status(200).json({ user });
  } catch (err) {
    if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token invalide ou expire' });
    }
    console.error('[me] Erreur:', err.message);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
};
