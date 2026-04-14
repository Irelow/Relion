/**
 * POST /api/auth/register
 * Crée un compte artisan.
 *
 * Pour une vraie prod, connectez une base de données (PlanetScale, Supabase, MongoDB Atlas…).
 * En l'état, ce fichier illustre la structure et renvoie un succès.
 *
 * Variables d'environnement :
 *   DATABASE_URL  – URL de connexion à votre base (si utilisée)
 */

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Méthode non autorisée' });

  const { prenom, email, telephone, password } = req.body || {};

  if (!prenom || !email || !telephone || !password) {
    return res.status(400).json({ error: 'Champs manquants' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Mot de passe trop court' });
  }

  /*
   * TODO : insérer l'artisan en base de données
   * Exemple avec Supabase :
   *
   *   const { createClient } = require('@supabase/supabase-js');
   *   const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
   *   const { error } = await supabase.from('artisans').insert({ prenom, email, telephone });
   *   if (error) return res.status(500).json({ error: error.message });
   */

  console.log(`[register] Nouveau compte : ${prenom} <${email}> — ${telephone}`);

  return res.status(200).json({ success: true, message: `Bienvenue ${prenom} !` });
};
