import React, { useState, useEffect } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInWithPopup, GoogleAuthProvider, signOut, onAuthStateChanged } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: process.env.REACT_APP_FIREBASE_API_KEY || 'test',
  authDomain: process.env.REACT_APP_FIREBASE_AUTH_DOMAIN || 'test',
  projectId: process.env.REACT_APP_FIREBASE_PROJECT_ID || 'test',
  storageBucket: process.env.REACT_APP_FIREBASE_STORAGE_BUCKET || 'test',
  messagingSenderId: process.env.REACT_APP_FIREBASE_MESSAGING_SENDER_ID || 'test',
  appId: process.env.REACT_APP_FIREBASE_APP_ID || 'test',
};

let app, auth, db;
try {
  app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = getFirestore(app);
} catch (error) {
  console.error('Firebase init error:', error);
}

export default function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!auth) {
      setLoading(false);
      return;
    }
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      setLoading(false);
    });
    return unsubscribe;
  }, []);

  if (loading) {
    return <div style={{ padding: '50px', textAlign: 'center' }}>Loading...</div>;
  }

  if (!user) {
    return (
      <div style={{ padding: '100px 20px', textAlign: 'center' }}>
        <h1>CoachFlow AI</h1>
        <p>Coaching Dashboard</p>
        <button 
          onClick={() => {
            if (auth) signInWithPopup(auth, new GoogleAuthProvider());
            else alert('Firebase not initialized');
          }}
          style={{
            padding: '12px 32px',
            fontSize: '16px',
            backgroundColor: '#0891b2',
            color: 'white',
            border: 'none',
            borderRadius: '6px',
            cursor: 'pointer'
          }}
        >
          Sign in with Google
        </button>
      </div>
    );
  }

  return (
    <div style={{ padding: '50px' }}>
      <h1>Welcome {user.email}</h1>
      <button onClick={() => signOut(auth)}>Sign out</button>
      <p>Dashboard coming soon...</p>
    </div>
  );
}