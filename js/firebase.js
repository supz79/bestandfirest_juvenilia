/*
 * Best&Fairest Beta.2
 * Firebase initialization only.
 * The existing Beta.1 localStorage logic is intentionally unchanged.
 *
 * IMPORTANT:
 * Replace AIzaSyDZBq0X6NviwjWMFCAACjd4WKLPlb6kdL0 with the Web API key from:
 * Firebase Console > Project settings > Your apps > Web app
 */

const firebaseConfig = {
  apiKey: "AIzaSyDZBq0X6NviwjWMFCAACjd4WKLPlb6kdL0",
  authDomain: "bestandfaires.firebaseapp.com",
  projectId: "bestandfaires",
  storageBucket: "bestandfaires.firebasestorage.app",
  messagingSenderId: "710128594979",
  appId: "1:710128594979:web:6ef2b383b9168aebdc0196"
};

firebase.initializeApp(firebaseConfig);

const auth = firebase.auth();
const db = firebase.firestore();

console.log("Best&Fairest Beta.2: Firebase inizializzato.");
console.log("Firebase project:", firebaseConfig.projectId);
