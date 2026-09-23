/* Best&Fairest Beta.7.18 - verifica email */

const loginScreen = document.querySelector('#login');
const dashboardScreen = document.querySelector('#dashboard');
const registerScreen = document.querySelector('#register');
const verifyScreen = document.querySelector('#verifyEmail');
const loginForm = document.querySelector('#loginForm');
const loginMsg = document.querySelector('#loginMsg');
const registerForm = document.querySelector('#registerForm');
const registerMsg = document.querySelector('#registerMsg');
const verifyMsg = document.querySelector('#verifyMsg');
const verifyEmailText = document.querySelector('#verifyEmailText');
const roleBtn = document.querySelector('#roleBtn');
const sessionBoot = document.querySelector('#sessionBoot');
function hideSessionBoot(){ sessionBoot?.classList.remove('active'); }

async function showAuthenticatedArea(userData) {
  // Mantieni la schermata di avvio visibile finché Home e dati iniziali
  // non sono stati caricati. In caso di errore, il catch dell'Auth mostrerà
  // il login evitando una pagina completamente vuota.
  window.currentUserData = userData;
  if (typeof window.applyRolePermissions === 'function') {
    await window.applyRolePermissions(userData);
  }
  document.querySelectorAll('.screen').forEach(x => x.classList.remove('active'));
  dashboardScreen.classList.add('active');
  hideSessionBoot();
  const name = userData?.nome || userData?.displayName || firebase.auth().currentUser?.email || 'Utente';
  roleBtn.textContent = userData?.role === 'superAdmin' ? 'Super Admin · Esci' : (userData?.role === 'admin' ? 'Admin · Esci' : `${name} · Esci`);
}

function showLogin(message='') {
  hideSessionBoot();
  document.querySelectorAll('.screen').forEach(x => x.classList.remove('active'));
  loginScreen.classList.add('active');
  roleBtn.textContent = 'Accedi';
  if (loginMsg) loginMsg.textContent = message;
}

function showRegister() {
  hideSessionBoot();
  document.querySelectorAll('.screen').forEach(x => x.classList.remove('active'));
  registerScreen?.classList.add('active');
  if(registerMsg) registerMsg.textContent='';
}

function showVerifyEmail(user, message='') {
  hideSessionBoot();
  document.querySelectorAll('.screen').forEach(x => x.classList.remove('active'));
  verifyScreen?.classList.add('active');
  if (verifyEmailText) verifyEmailText.textContent = user?.email || '';
  if (verifyMsg) verifyMsg.textContent = message;
  roleBtn.textContent = 'Verifica email';
}

async function sendVerificationEmail() {
  const user = auth.currentUser;
  if (!user) {
    showLogin('Accedi per richiedere una nuova email di verifica.');
    return;
  }
  try {
    await user.sendEmailVerification();
    if (verifyMsg) verifyMsg.textContent = '📧 Email di verifica inviata. Controlla anche la cartella Spam.';
  } catch (error) {
    console.error('Invio verifica email:', error);
    if (verifyMsg) verifyMsg.textContent = '❌ Non è stato possibile inviare la email. Attendi qualche secondo e riprova.';
  }
}

async function checkEmailVerified() {
  const user = auth.currentUser;
  if (!user) {
    showLogin();
    return;
  }
  try {
    await user.reload();
    const refreshedUser = auth.currentUser;
    if (!refreshedUser.emailVerified) {
      showVerifyEmail(refreshedUser, '⏳ La email non risulta ancora verificata. Dopo aver cliccato il link, premi nuovamente il pulsante.');
      return;
    }
    await continueAfterVerified(refreshedUser);
  } catch (error) {
    console.error('Verifica email:', error);
    showVerifyEmail(user, '❌ Impossibile controllare lo stato della verifica. Riprova.');
  }
}

async function continueAfterVerified(user) {
  const snap = await db.collection('users').doc(user.uid).get();
  if (!snap.exists) {
    await auth.signOut();
    showLogin('❌ Account verificato, ma non ancora presente in Best&Fairest.');
    return;
  }
  const userData = snap.data();
  if (userData.active !== true) {
    await auth.signOut();
    showLogin('⏳ Email verificata. La registrazione è ricevuta: l’Admin deve ancora associarti alla rosa.');
    return;
  }
  console.log('Best&Fairest Beta.7.18: utente autenticato.', {uid:user.uid,role:userData.role,leagueId:userData.leagueId,emailVerified:user.emailVerified});
  await showAuthenticatedArea(userData);
}

document.querySelector('#showRegisterBtn')?.addEventListener('click', showRegister);
document.querySelector('#cancelRegisterBtn')?.addEventListener('click', ()=>showLogin());
document.querySelector('#resendVerificationBtn')?.addEventListener('click', sendVerificationEmail);
document.querySelector('#checkVerificationBtn')?.addEventListener('click', checkEmailVerified);
document.querySelector('#verifyLogoutBtn')?.addEventListener('click', async ()=>{ await auth.signOut(); showLogin(); });

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  loginMsg.textContent = 'Accesso in corso...';
  try {
    const cred = await auth.signInWithEmailAndPassword(
      document.querySelector('#loginEmail').value.trim(),
      document.querySelector('#loginPassword').value
    );
    if (!cred.user.emailVerified) {
      showVerifyEmail(cred.user, '📧 Prima di accedere devi verificare il tuo indirizzo email.');
      return;
    }
  } catch (error) {
    console.error(error);
    loginMsg.textContent = '❌ Accesso non riuscito. Controlla email e password.';
  }
});

registerForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const nome=document.querySelector('#registerNome').value.trim();
  const cognome=document.querySelector('#registerCognome').value.trim();
  const email=document.querySelector('#registerEmail').value.trim();
  const password=document.querySelector('#registerPassword').value;
  const password2=document.querySelector('#registerPassword2').value;
  if(password!==password2){ registerMsg.textContent='❌ Le password non coincidono.'; return; }
  registerMsg.textContent='Registrazione in corso...';
  window.isRegistering=true;
  try{
    const cred=await auth.createUserWithEmailAndPassword(email,password);
    await db.collection('users').doc(cred.user.uid).set({
      nome, cognome, email, role:'player', leagueId:'demo', active:false, playerId:null,
      registrationStatus:'pending', registeredAt:firebase.firestore.FieldValue.serverTimestamp()
    });
    await cred.user.sendEmailVerification();
    window.isRegistering=false;
    registerForm.reset();
    showVerifyEmail(cred.user, '📧 Registrazione ricevuta. Ti abbiamo inviato un link per verificare la tua email.');
  }catch(error){
    console.error('Registrazione:',error);
    window.isRegistering=false;
    if(error.code==='auth/email-already-in-use') registerMsg.textContent='❌ Questa email è già registrata.';
    else registerMsg.textContent='❌ Registrazione non riuscita. Riprova.';
  }
});

roleBtn.addEventListener('click', async () => {
  if (auth.currentUser) {
    await auth.signOut();
    showLogin();
  } else {
    showLogin();
  }
});

auth.onAuthStateChanged(async (user) => {
  if (!user) {
    // A-04: forza il nuovo caricamento del tabellino alla sessione successiva.
    if (typeof window.resetMatchViewCache === 'function') window.resetMatchViewCache();
    if(!window.isRegistering) showLogin();
    return;
  }
  if(window.isRegistering) return;
  try {
    if (!user.emailVerified) {
      showVerifyEmail(user, '📧 Verifica il tuo indirizzo email per continuare.');
      return;
    }
    await continueAfterVerified(user);
  } catch (error) {
    console.error('Errore lettura profilo utente:', error);
    await auth.signOut();
    showLogin('❌ Impossibile leggere il profilo utente da Firebase.');
  }
});
