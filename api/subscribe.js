const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Methode non autorisee' });

  const { email, prenom, telephone, activite, sms } = req.body || {};

  if (!email || !telephone) {
    return res.status(400).json({ error: 'Champs manquants' });
  }

  const priceId = process.env.STRIPE_PRICE_ESSENTIEL;
  if (!priceId) {
    return res.status(500).json({ error: 'Prix Stripe non configure' });
  }

  const appUrl = process.env.APP_URL || 'https://relion-five.vercel.app';

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      customer_email: email,
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: {
        prenom: prenom || '',
        telephone: telephone,
        activite: activite || '',
        sms: sms || '',
        plan: 'Relion'
      },
      subscription_data: {
        trial_period_days: 30,
        metadata: { prenom: prenom || '', telephone: telephone, plan: 'Relion' }
      },
      success_url: `${appUrl}/?stripe=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${appUrl}/#pricing`,
      locale: 'fr',
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('[subscribe] Erreur Stripe :', err.message);
    return res.status(500).json({ error: err.message });
  }
};
