import React, { useState, useEffect } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInWithPopup, GoogleAuthProvider, signOut, onAuthStateChanged } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: "AIzaSyBjEFixKe1bgovoZovJZlzjanipdn6WRtE",
  authDomain: "fitness-2e6c2.firebaseapp.com",
  projectId: "fitness-2e6c2",
  storageBucket: "fitness-2e6c2.firebasestorage.app",
  messagingSenderId: "564661696727",
  appId: "1:564661696727:web:159f9bff9dcb9907e61892",
};

let app, auth;
// eslint-disable-next-line no-unused-vars
let db;
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
            cursor:
