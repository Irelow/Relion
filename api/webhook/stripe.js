const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { sql } = require('@vercel/postgres');
const bcrypt = require('bcryptjs');
const { Resend } = require('resend');

// IMPORTANT: désactiver le bodyParser Vercel pour lire le body brut (requis par Stripe)
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const sig = req.headers['stripe-signature'];
  let rawBody = '';

  try {
    rawBody = await new Promise((resolve, reject) => {
      let data = '';
      req.on('data', chunk => { data += chunk; });
      req.on('end', () => resolve(data));
      req.on('error', reject);
    });
  } catch (err) {
    return res.status(400).json({ error: 'Impossible de lire le body' });
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[webhook] Signature invalide:', err.message);
    return res.status(400).json({ error: `Webhook invalide: ${err.message}` });
  }

  // Paiement réussi → créer le compte utilisateur
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const { email, prenom, telephone, activite, sms } = session.metadata || {};

    if (!email || !telephone) {
      console.error('[webhook] Metadata manquantes:', session.metadata);
      return res.status(200).json({ received: true });
    }

    try {
      // Générer un mot de passe temporaire lisible
      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      const tempPassword = Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
      const hash = await bcrypt.hash(tempPassword, 10);

      // Insérer l'utilisateur (ou mettre à jour si email déjà présent)
      await sql`
        INSERT INTO users (
          email, password_hash, prenom, telephone, activite, sms_message,
          stripe_customer_id, stripe_subscription_id, subscription_status
        ) VALUES (
          ${email.toLowerCase().trim()},
          ${hash},
          ${prenom || ''},
          ${telephone},
          ${activite || ''},
          ${sms || 'Bonjour, je suis actuellement occupe. Je vous rappelle des que possible.'},
          ${session.customer || ''},
          ${session.subscription || ''},
          'active'
        )
        ON CONFLICT (email) DO UPDATE SET
          stripe_customer_id     = EXCLUDED.stripe_customer_id,
          stripe_subscription_id = EXCLUDED.stripe_subscription_id,
          subscription_status    = 'active'
      `;

      // Envoyer email de bienvenue avec identifiants
      const resend = new Resend(process.env.RESEND_API_KEY);
      await resend.emails.send({
        from: 'Relion <onboarding@resend.dev>',
        to: email,
        subject: `Bienvenue sur Relion, ${prenom || ''} — Vos accès`,
        html: `
          <div style="font-family: -apple-system, sans-serif; max-width: 520px; margin: 0 auto; color: #1a1a1a;">
            <div style="background: #7c3aed; padding: 32px; border-radius: 12px 12px 0 0; text-align: center;">
              <h1 style="color: white; margin: 0; font-size: 28px;">Relion</h1>
            </div>
            <div style="background: #fff; padding: 32px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 12px 12px;">
              <h2 style="margin-top: 0;">Bienvenue ${prenom ? ', ' + prenom : ''} ! 🎉</h2>
              <p>Votre abonnement Relion est actif. Voici vos identifiants pour accéder à votre espace :</p>
              <div style="background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 20px; margin: 24px 0;">
                <p style="margin: 0 0 8px 0;"><strong>Email :</strong> ${email}</p>
                <p style="margin: 0;"><strong>Mot de passe temporaire :</strong>
                  <span style="font-family: monospace; font-size: 20px; letter-spacing: 3px; color: #7c3aed; font-weight: bold;">${tempPassword}</span>
                </p>
              </div>
              <p>👉 <a href="https://relionapp.fr" style="color: #7c3aed; font-weight: bold;">Connectez-vous sur relionapp.fr</a></p>
              <p style="color: #6b7280; font-size: 14px;">Pensez à changer votre mot de passe depuis votre tableau de bord.</p>
              <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;">
              <p style="color: #6b7280; font-size: 13px; margin: 0;">Des questions ? Répondez à cet email ou écrivez-nous à <a href="mailto:contact@relionapp.fr">contact@relionapp.fr</a></p>
            </div>
          </div>
        `
      });

      console.log('[webhook] Utilisateur créé:', email);
    } catch (err) {
      console.error('[webhook] Erreur création user:', err.message);
      // On renvoie 200 pour que Stripe ne réessaie pas
    }
  }

  // Abonnement annulé
  if (event.type === 'customer.subscription.deleted') {
    const subscription = event.data.object;
    try {
      await sql`
        UPDATE users SET subscription_status = 'canceled'
        WHERE stripe_subscription_id = ${subscription.id}
      `;
      console.log('[webhook] Abonnement annulé:', subscription.id);
    } catch (err) {
      console.error('[webhook] Erreur annulation:', err.message);
    }
  }

  return res.status(200).json({ received: true });
};

module.exports.config = {
  api: { bodyParser: false }
};
