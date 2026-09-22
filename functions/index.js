const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

initializeApp();
setGlobalOptions({ region: 'europe-west8' });

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

exports.updatePlayerEmail = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Devi effettuare l\'accesso.');
  }

  const db = getFirestore();
  const auth = getAuth();
  const callerRef = db.collection('users').doc(request.auth.uid);
  const callerSnap = await callerRef.get();

  if (!callerSnap.exists) {
    throw new HttpsError('permission-denied', 'Profilo amministratore non trovato.');
  }

  const caller = callerSnap.data() || {};
  if (!['admin', 'superAdmin'].includes(caller.role) || caller.active !== true) {
    throw new HttpsError('permission-denied', 'Operazione riservata agli Admin.');
  }

  const uid = String(request.data?.uid || '').trim();
  const newEmail = normalizeEmail(request.data?.newEmail);

  if (!uid) {
    throw new HttpsError('invalid-argument', 'UID utente mancante.');
  }
  if (!isValidEmail(newEmail)) {
    throw new HttpsError('invalid-argument', 'Indirizzo email non valido.');
  }

  const targetRef = db.collection('users').doc(uid);
  const targetSnap = await targetRef.get();
  if (!targetSnap.exists) {
    throw new HttpsError('not-found', 'Utente non trovato.');
  }

  const target = targetSnap.data() || {};
  if (target.role !== 'player') {
    throw new HttpsError('failed-precondition', 'È possibile modificare solo le email dei Player.');
  }
  if (target.leagueId !== caller.leagueId) {
    throw new HttpsError('permission-denied', 'Il Player appartiene a un\'altra lega.');
  }

  try {
    const authUser = await auth.getUser(uid);
    if (normalizeEmail(authUser.email) === newEmail) {
      throw new HttpsError('already-exists', 'Il nuovo indirizzo coincide con quello attuale.');
    }

    // Manteniamo lo stesso UID: associazione al giocatore, voti e storico
    // restano quindi invariati. La nuova email deve essere verificata di nuovo.
    await auth.updateUser(uid, {
      email: newEmail,
      emailVerified: false
    });

    await targetRef.update({
      email: newEmail,
      emailVerified: false,
      emailUpdatedAt: FieldValue.serverTimestamp(),
      emailUpdatedBy: request.auth.uid
    });

    return {
      ok: true,
      uid,
      email: newEmail,
      requiresVerification: true
    };
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    console.error('updatePlayerEmail:', error);
    if (error.code === 'auth/email-already-exists') {
      throw new HttpsError('already-exists', 'Questa email è già associata a un altro account Firebase.');
    }
    if (error.code === 'auth/user-not-found') {
      throw new HttpsError('not-found', 'Account Firebase non trovato.');
    }
    throw new HttpsError('internal', 'Non è stato possibile modificare l\'indirizzo email.');
  }
});
