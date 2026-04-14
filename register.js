/**
 * POST /api/auth/register  (endpoint auxiliaire serveur)
 *
 * L'authentification principale est gérée côté client via @supabase/supabase-js.
 * Cet endpoint peut être utilisé pour :
 *  - Créer des enregistrements supplémentaires en DB après inscription
 *  - Vérifier un token Supabase côté serveur
 *  - Déclencher des actions post-inscription (email Stripe, webhook, etc.)
 *
 * Variables d'environnement :
 *   SUPABASE_URL          – URL du projet Supabase
 *   SUPABASE_SERVICE_KEY  – Clé service_role (jamais exposée côté client)
 */

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Méthode non autorisée' });

  const { prenom, email, telephone } = req.body || {};

  if (!email) {
    return res.status(400).json({ error: 'Email manquant' });
  }

  /*
   * Exemple d'action post-inscription avec Supabase service role :
   *
   * const { createClient } = require('@supabase/supabase-js');
   * const supabase = createClient(
   *   process.env.SUPABASE_URL,
   *   process.env.SUPABASE_SERVICE_KEY
   * );
   * const { error } = await supabase
   *   .from('profiles')
   *   .upsert({ email, prenom, telephone });
   * if (error) return res.status(500).json({ error: error.message });
   */

  console.log(`[register] Post-inscription : ${prenom || ''} <${email}>`);

  return res.status(200).json({ success: true });
};
