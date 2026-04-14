/**
 * POST /api/subscribe
 * Crée une session Stripe Checkout et renvoie l'URL de paiement.
 *
 * Variables d'environnement (à configurer dans Vercel) :
 *   STRIPE_SECRET_KEY        – Clé secrète Stripe (sk_live_... ou sk_test_...)
 *   STRIPE_PRICE_ESSENTIEL   – ID du prix Stripe pour le plan Essentiel (price_xxx)
 *   STRIPE_PRICE_PRO         – ID du prix Stripe pour le plan Pro (price_xxx)
 *   APP_URL                  – URL publique du site (ex. https://relion.fr)
 *
 * Comment créer les prix dans Stripe :
 *  1. Stripe Dashboard → Produits → Nouveau produit
 *  2. Créez "Relion Essentiel" et "Relion Pro" en mode abonnement mensuel
 *  3. Copiez les IDs (price_xxx) dans vos variables d'environnement Vercel
 */

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Méthode non autorisée' });

  const { plan, email, prenom, telephone, activite, sms } = req.body || {};

  if (!plan || !email || !telephone) {
    return res.status(400).json({ error: 'Champs manquants' });
  }

  const priceId = plan === 'Pro'
    ? process.env.STRIPE_PRICE_PRO
    : process.env.STRIPE_PRICE_ESSENTIEL;

  if (!priceId) {
    return res.status(500).json({ error: 'Prix Stripe non configuré pour ce plan' });
  }

  const appUrl = process.env.APP_URL || 'https://relion.fr';

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      customer_email: email,

      line_items: [{ price: priceId, quantity: 1 }],

      /* Métadonnées transmises au webhook après paiement */
      metadata: {
        prenom:   prenom   || '',
        telephone: telephone,
        activite: activite || '',
        sms:      sms      || '',
        plan:     plan
      },

      /* Période d'essai gratuite de 30 jours */
      subscription_data: {
        trial_period_days: 30,
        metadata: {
          prenom:    prenom    || '',
          telephone: telephone,
          plan:      plan
        }
      },

      success_url: `${appUrl}/?stripe=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${appUrl}/#pricing`,

      locale: 'fr',
    });

    return res.status(200).json({ url: session.url });

  } catch (err) {
    console.error('[subscribe] Erreur Stripe :', err.message);
    return res.status(500).json({ error: err.message });
  }
};
