/**
 * POST /api/stripe-webhook
 * Reçoit les événements Stripe et déclenche les actions post-paiement.
 *
 * Événements écoutés :
 *   checkout.session.completed    – paiement ou début d'essai gratuit
 *   customer.subscription.updated – changement de plan, fin d'essai
 *   customer.subscription.deleted – résiliation
 *   invoice.payment_succeeded     – renouvellement mensuel OK
 *   invoice.payment_failed        – échec de paiement
 *
 * Variables d'environnement (Vercel) :
 *   STRIPE_SECRET_KEY       – sk_live_...
 *   STRIPE_WEBHOOK_SECRET   – whsec_...
 *   TWILIO_ACCOUNT_SID
 *   TWILIO_AUTH_TOKEN
 *   TWILIO_PHONE_NUMBER
 *   OWNER_PHONE_NUMBER
 */

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const twilio = require('twilio');

/* Vercel : désactiver le body parser (requis par Stripe pour vérifier la signature) */
module.exports.config = { api: { bodyParser: false } };

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const rawBody = await readRawBody(req);
  const sig     = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[webhook] Signature invalide :', err.message);
    return res.status(400).send('Webhook Error: ' + err.message);
  }

  const obj  = event.data.object;
  const meta = obj.metadata || {};

  /* ─── Paiement initial / début essai gratuit ─── */
  if (event.type === 'checkout.session.completed') {
    const prenom    = meta.prenom    || 'l\'artisan';
    const telephone = meta.telephone || '';
    const activite  = meta.activite  || '';
    const plan      = meta.plan      || 'Relion';
    const sms       = meta.sms       || '';

    console.log(`[webhook] Nouvel abonné : ${prenom} — ${telephone}`);

    await sendSMS([
      '🎉 Nouvel abonné Relion !',
      `Prénom   : ${prenom}`,
      `Tél      : ${telephone}`,
      `Activité : ${activite}`,
      `Plan     : ${plan}`,
      sms ? `SMS auto : "${sms.slice(0, 60)}…"` : ''
    ].filter(Boolean).join('\n'), process.env.OWNER_PHONE_NUMBER);

    if (telephone) {
      await sendSMS(
        `Bonjour ${prenom} ! 👋 Bienvenue sur Relion.\nVotre numéro de rappel automatique est en cours d'activation. Notre équipe vous contacte sous 48h.`,
        telephone
      );
    }
  }

  /* ─── Fin de l'essai gratuit → premier vrai paiement ─── */
  if (event.type === 'customer.subscription.updated') {
    const prev   = event.data.previous_attributes || {};
    const trialEnded = prev.status === 'trialing' && obj.status === 'active';
    if (trialEnded) {
      console.log('[webhook] Essai gratuit terminé, abonnement actif :', obj.customer);
      await sendSMS(
        '💳 Un essai gratuit Relion vient de se convertir en abonnement payant.',
        process.env.OWNER_PHONE_NUMBER
      );
    }
  }

  /* ─── Abonnement résilié ─── */
  if (event.type === 'customer.subscription.deleted') {
    console.log('[webhook] Résiliation :', obj.customer);
    await sendSMS(
      '❌ Un abonné Relion a résilié son abonnement. Client : ' + obj.customer,
      process.env.OWNER_PHONE_NUMBER
    );
    /*
     * TODO : désactiver le numéro Twilio de l'artisan
     * TODO Supabase : supabase.from('artisans').update({ active: false }).eq('stripe_customer', obj.customer)
     */
  }

  /* ─── Renouvellement mensuel réussi ─── */
  if (event.type === 'invoice.payment_succeeded' && obj.billing_reason === 'subscription_cycle') {
    console.log('[webhook] Renouvellement OK :', obj.customer, obj.amount_paid / 100, '€');
  }

  /* ─── Échec de paiement ─── */
  if (event.type === 'invoice.payment_failed') {
    console.error('[webhook] Paiement échoué :', obj.customer);
    await sendSMS(
      '⚠️ Échec de paiement Relion. Client Stripe : ' + obj.customer + '. Vérifiez le dashboard Stripe.',
      process.env.OWNER_PHONE_NUMBER
    );
  }

  return res.status(200).json({ received: true });
};

/* ─── Helpers ─── */

function sendSMS(body, to) {
  if (!to || !process.env.TWILIO_ACCOUNT_SID) return Promise.resolve();
  const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  return client.messages.create({ body, from: process.env.TWILIO_PHONE_NUMBER, to })
    .catch(err => console.error('[webhook] SMS error:', err.message));
}

function readRawBody(req) {
  return new Promise(function(resolve, reject) {
    var chunks = [];
    req.on('data', function(c) { chunks.push(c); });
    req.on('end',  function()  { resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}
