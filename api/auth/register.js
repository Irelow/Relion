const { sql } = require('@vercel/postgres');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Resend } = require('resend');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

module.exports = async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

  try {
    const { prenom, nom, email: rawEmail, telephone: rawTel, password } = req.body || {};

    // --- Normalisation ---
    const email         = (rawEmail || '').trim().toLowerCase();
    const telephone     = (rawTel   || '').trim().replace(/[\s\-\.]/g, '');
    const prenomTrimmed = (prenom   || '').trim().slice(0, 100);
    const nomTrimmed    = (nom      || '').trim().slice(0, 100);

    // --- Validation ---
    if (!prenomTrimmed)
      return res.status(400).json({ error: 'Prénom requis.', field: 'prenom' });
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 254)
      return res.status(400).json({ error: 'Email invalide.', field: 'email' });
    if (!telephone || !/^(\+33|0033|0)[0-9]{9}$/.test(telephone))
      return res.status(400).json({ error: 'Numéro de téléphone invalide (format français).', field: 'telephone' });
    if (!password || password.length < 8)
      return res.status(400).json({ error: 'Mot de passe trop court (8 caractères minimum).', field: 'password' });

    // --- Compte déjà existant dans users ---
    const existingEmail = await sql`SELECT id FROM users WHERE email = ${email} LIMIT 1`;
    if (existingEmail.rows.length > 0)
      return res.status(409).json({ error: 'Un compte existe déjà avec cet email. Connectez-vous !', field: 'email' });

    const existingPhone = await sql`SELECT id FROM users WHERE telephone = ${telephone} LIMIT 1`;
    if (existingPhone.rows.length > 0)
      return res.status(409).json({ error: 'Un compte existe déjà avec ce numéro de téléphone.', field: 'telephone' });

    // --- Inscription en attente (pending_registrations) ---
    const pending = await sql`
      SELECT email, telephone, resend_count, last_resend_at, expires_at
      FROM pending_registrations
      WHERE email = ${email} OR telephone = ${telephone}
      LIMIT 1
    `;

    if (pending.rows.length > 0) {
      const p   = pending.rows[0];
      const now = new Date();

      // Lien expiré → supprimer et laisser recommencer
      if (now > new Date(p.expires_at)) {
        await sql`DELETE FROM pending_registrations WHERE email = ${p.email}`;
        // On continue pour réinscrire
      }
      // Même numéro de tél mais email différent → doublon de numéro
      else if (p.telephone === telephone && p.email !== email) {
        return res.status(409).json({ error: "Ce numéro est déjà en cours d'inscription.", field: 'telephone' });
      }
      // Même email → inscription déjà en attente, proposer renvoi
      else {
        const minsSince = (now - new Date(p.last_resend_at)) / 60000;
        return res.status(429).json({
          error:       'Un email de vérification a déjà été envoyé. Vérifiez vos spams.',
          canResend:   minsSince >= 5,
          waitMinutes: minsSince < 5 ? Math.ceil(5 - minsSince) : 0,
          email:       email
        });
      }
    }

    // --- Hash du mot de passe ---
    const passwordHash = await bcrypt.hash(password, 10);

    // --- Token de vérification (signé JWT, valide 24h) ---
    const verifyToken = jwt.sign(
      { prenom: prenomTrimmed, nom: nomTrimmed, email, telephone, passwordHash, purpose: 'email_verification' },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    // --- Stocker dans pending_registrations ---
    await sql`
      INSERT INTO pending_registrations
        (email, telephone, prenom, nom, password_hash, resend_count, last_resend_at, expires_at)
      VALUES
        (${email}, ${telephone}, ${prenomTrimmed}, ${nomTrimmed}, ${passwordHash}, 0, NOW(), NOW() + INTERVAL '24 hours')
      ON CONFLICT (email) DO UPDATE SET
        telephone      = ${telephone},
        prenom         = ${prenomTrimmed},
        nom            = ${nomTrimmed},
        password_hash  = ${passwordHash},
        resend_count   = 0,
        last_resend_at = NOW(),
        expires_at     = NOW() + INTERVAL '24 hours'
    `;

    // --- Envoi de l'email de vérification ---
    const resendClient = new Resend(process.env.RESEND_API_KEY);
    const verifyUrl    = `https://relion-five.vercel.app/api/auth/verify?token=${verifyToken}`;

    await resendClient.emails.send({
      from:    'Relion <noreply@relionapp.fr>',
      to:      email,
      subject: 'Confirmez votre adresse email — Relion',
      html: `
        <div style="font-family:Inter,sans-serif;max-width:520px;margin:0 auto;padding:40px 20px;background:#fff;">
          <h1 style="font-size:26px;font-weight:700;color:#1a1a2e;margin-bottom:8px;">
            Bienvenue, ${prenomTrimmed} 👋
          </h1>
          <p style="color:#555;font-size:15px;margin-bottom:28px;line-height:1.6;">
            Vous êtes à un clic de votre compte Relion.<br/>
            Cliquez sur le bouton ci-dessous pour confirmer votre adresse email.
          </p>
          <a href="${verifyUrl}"
            style="display:inline-block;padding:14px 28px;background:#1A56E8;color:#fff;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;">
            Confirmer mon email →
          </a>
          <p style="color:#aaa;font-size:12px;margin-top:28px;line-height:1.5;">
            Ce lien expire dans 24 heures.<br/>
            Si vous n'avez pas créé de compte Relion, ignorez simplement cet email.
          </p>
        </div>
      `
    });

    return res.status(200).json({ message: 'Email de vérification envoyé.', email });

  } catch (err) {
    console.error('[register] Erreur:', err);
    return res.status(500).json({ error: 'Erreur serveur — réessayez dans quelques instants.' });
  }
};
