/**
 * POST /api/stripe-webhook
 * Reçoit les événements Stripe après paiement.
 *
 * À configurer dans Stripe Dashboard :
 *  Développeurs → Webhooks → Ajouter un endpoint
 *  URL : https://votre-site.vercel.app/api/stripe-webhook
 *  Événements à écouter :
 *    - checkout.session.completed   (paiement réussi)
 *    - customer.subscription.deleted (résiliation)
 *
 * Variable d'environnement :
 *   STRIPE_WEBHOOK_SECRET  – Signing secret du webhook Stripe (whsec_...)
 */

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const twilio = require('twilio');

/* Vercel : désactiver le body parser pour lire le raw body (requis par Stripe) */
module.exports.config = { api: { bodyParser: false } };

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  /* Lire le body brut */
  const rawBody = await readRawBody(req);
  const sig     = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('[webhook] Signature invalide :', err.message);
    return res.status(400).send('Webhook Error: ' + err.message);
  }

  /* ─── Paiement / essai gratuit confirmé ─── */
  if (event.type === 'checkout.session.completed') {
    const session  = event.data.object;
    const meta     = session.metadata || {};
    const prenom   = meta.prenom   || 'l\'artisan';
    const telephone = meta.telephone;
    const activite = meta.activite || '';
    const plan     = meta.plan     || '';
    const sms      = meta.sms      || '';

    console.log(`[webhook] Nouvel abonné : ${prenom} (${plan}) — ${telephone}`);

    /* Notifier le propriétaire par SMS */
    try {
      const twilioClient = twilio(
        process.env.TWILIO_ACCOUNT_SID,
        process.env.TWILIO_AUTH_TOKEN
      );

      await twilioClient.messages.create({
        body: [
          '🎉 Nouvel abonné Relion !',
          `Prénom   : ${prenom}`,
          `Tél      : ${telephone}`,
          `Activité : ${activite}`,
          `Plan     : ${plan}`,
          `SMS configuré : "${sms.slice(0, 80)}…"`
        ].join('\n'),
        from: process.env.TWILIO_PHONE_NUMBER,
        to:   process.env.OWNER_PHONE_NUMBER
      });

      /* Envoyer un SMS de bienvenue à l'artisan */
      if (telephone) {
        await twilioClient.messages.create({
          body: `Bonjour ${prenom} ! Bienvenue sur Relion 🎉\nVotre SMS automatique est en cours de configuration. Notre équipe vous contacte sous 48h. — Relion`,
          from: process.env.TWILIO_PHONE_NUMBER,
          to:   telephone
        });
      }
    } catch (smsErr) {
      /* Ne pas bloquer le webhook si le SMS échoue */
      console.error('[webhook] Erreur SMS :', smsErr.message);
    }

    /*
     * TODO base de données : marquer l'artisan comme actif
     * Exemple Supabase :
     *   await supabase.from('artisans').update({ active: true, plan }).eq('email', session.customer_email);
     */
  }

  /* ─── Abonnement résilié ─── */
  if (event.type === 'customer.subscription.deleted') {
    const sub = event.data.object;
    console.log('[webhook] Résiliation :', sub.customer);
    /*
     * TODO : désactiver le numéro Twilio de l'artisan
     *        mettre à jour la base de données
     */
  }

  return res.status(200).json({ received: true });
};

/* Utilitaire : lire le body brut depuis la requête Node.js */
function readRawBody(req) {
  return new Promise(function(resolve, reject) {
    var chunks = [];
    req.on('data', function(chunk) { chunks.push(chunk); });
    req.on('end',  function()      { resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}
