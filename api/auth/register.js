const { sql } = require('@vercel/postgres');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Resend } = require('resend');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Methode non autorisee' });

  const { prenom, nom, email, telephone, password } = req.body || {};

  if (!prenom || !email || !telephone || !password) {
    return res.status(400).json({ error: 'Tous les champs sont requis' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 8 caractères' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Email invalide' });
  }

  try {
    // Vérifier si email déjà utilisé
    const { rows: existing } = await sql`
      SELECT id FROM users WHERE email = ${email.toLowerCase().trim()} LIMIT 1
    `;
    if (existing.length > 0) {
      return res.status(409).json({ error: 'Un compte existe déjà avec cet email' });
    }

    const hash = await bcrypt.hash(password, 10);
    const fullName = (prenom + (nom ? ' ' + nom : '')).trim();

    const { rows } = await sql`
      INSERT INTO users (email, password_hash, prenom, telephone, subscription_status)
      VALUES (
        ${email.toLowerCase().trim()},
        ${hash},
        ${fullName},
        ${telephone},
        'trial'
      )
      RETURNING id, email, prenom, telephone, sms_message, subscription_status
    `;
    const user = rows[0];

    const token = jwt.sign(
      { userId: user.id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    // Email de confirmation
    if (process.env.RESEND_API_KEY) {
      const resend = new Resend(process.env.RESEND_API_KEY);
      resend.emails.send({
        from: 'Relion <onboarding@resend.dev>',
        to: email,
        subject: 'Bienvenue sur Relion — Votre compte est créé',
        html: `
          <div style="font-family:-apple-system,sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a;">
            <div style="background:#1A56E8;padding:32px;border-radius:12px 12px 0 0;text-align:center;">
              <h1 style="color:white;margin:0;font-size:28px;">Relion</h1>
            </div>
            <div style="background:#fff;padding:32px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 12px 12px;">
              <h2 style="margin-top:0;">Bienvenue, ${prenom} ! 🎉</h2>
              <p>Votre compte Relion a bien été créé. Vous bénéficiez de <strong>30 jours d'essai gratuit</strong>.</p>
              <p>👉 <a href="https://relionapp.fr" style="color:#1A56E8;font-weight:bold;">Accéder à mon espace</a></p>
              <p style="color:#6b7280;font-size:13px;">Des questions ? Écrivez-nous à <a href="mailto:contact@relionapp.fr">contact@relionapp.fr</a></p>
            </div>
          </div>
        `
      }).catch(() => {});
    }

    return res.status(200).json({ token, user });
  } catch (err) {
    console.error('[register] Erreur:', err.message);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
};
