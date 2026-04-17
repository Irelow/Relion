const { sql } = require('@vercel/postgres');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Methode non autorisee' });

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token manquant' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const { sms_message, new_password, current_password } = req.body || {};

    // Mise a jour du message SMS
    if (sms_message !== undefined) {
      await sql`
        UPDATE users SET sms_message = ${sms_message} WHERE id = ${decoded.userId}
      `;
    }

    // Changement de mot de passe
    if (new_password && current_password) {
      const { rows } = await sql`SELECT password_hash FROM users WHERE id = ${decoded.userId}`;
      const user = rows[0];
      const valid = await bcrypt.compare(current_password, user.password_hash);
      if (!valid) {
        return res.status(401).json({ error: 'Mot de passe actuel incorrect' });
      }
      const newHash = await bcrypt.hash(new_password, 10);
      await sql`UPDATE users SET password_hash = ${newHash} WHERE id = ${decoded.userId}`;
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token invalide ou expire' });
    }
    console.error('[update] Erreur:', err.message);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
};
