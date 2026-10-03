import React, { useState, useEffect } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInWithPopup, GoogleAuthProvider, signOut, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, collection, addDoc, query, where, getDocs, serverTimestamp } from 'firebase/firestore';
import './App.css';

const firebaseConfig = {
  apiKey: "AIzaSyBjEFixKe1bgovoZovJZlzjanipdn6WRtE",
  authDomain: "fitness-2e6c2.firebaseapp.com",
  projectId: "fitness-2e6c2",
  storageBucket: "fitness-2e6c2.firebasestorage.app",
  messagingSenderId: "564661696727",
  appId: "1:564661696727:web:159f9bff9dcb9907e61892"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const googleProvider = new GoogleAuthProvider();

function App() {
  const [user, setUser] = useState(null);
  const [clients, setClients] = useState([]);
  const [checkIns, setCheckIns] = useState([]);
  const [showAddClient, setShowAddClient] = useState(false);
  const [showAddCheckIn, setShowAddCheckIn] = useState(false);
  const [selectedClient, setSelectedClient] = useState(null);
  const [loading, setLoading] = useState(false);

  // Auth state listener
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      if (currentUser) {
        fetchClients(currentUser.uid);
        fetchCheckIns(currentUser.uid);
      }
    });
    return unsubscribe;
  }, []);

  // Fetch clients for current coach
  const fetchClients = async (coachId) => {
    try {
      const q = query(collection(db, 'clients'), where('coachId', '==', coachId));
      const snapshot = await getDocs(q);
      setClients(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })));
    } catch (error) {
      console.error('Error fetching clients:', error);
    }
  };

  // Fetch check-ins for current coach
  const fetchCheckIns = async (coachId) => {
    try {
      const q = query(collection(db, 'checkIns'), where('coachId', '==', coachId));
      const snapshot = await getDocs(q);
      const data = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      // Sort by date, newest first
      setCheckIns(data.sort((a, b) => (b.createdAt?.toDate() || 0) - (a.createdAt?.toDate() || 0)));
    } catch (error) {
      console.error('Error fetching check-ins:', error);
    }
  };

  // Sign in with Google
  const handleGoogleSignIn = async () => {
    try {
      const result = await signInWithPopup(auth, googleProvider);
      const user = result.user;

      // Create user doc if first time
      await addDoc(collection(db, 'users'), {
        uid: user.uid,
        email: user.email,
        displayName: user.displayName,
        createdAt: serverTimestamp()
      }).catch(() => {}); // Ignore if already exists
    } catch (error) {
      console.error('Sign in error:', error);
    }
  };

  // Sign out
  const handleSignOut = async () => {
    try {
      await signOut(auth);
      setClients([]);
      setCheckIns([]);
    } catch (error) {
      console.error('Sign out error:', error);
    }
  };

  // Add new client
  const handleAddClient = async (e) => {
    e.preventDefault();
    const formData = new FormData(e.target);
    const clientName = formData.get('clientName');
    const clientEmail = formData.get('clientEmail') || '';

    if (!clientName.trim()) return;

    try {
      setLoading(true);
      await addDoc(collection(db, 'clients'), {
        coachId: user.uid,
        name: clientName,
        email: clientEmail,
        createdAt: serverTimestamp()
      });
      e.target.reset();
      setShowAddClient(false);
      fetchClients(user.uid);
    } catch (error) {
      console.error('Error adding client:', error);
    } finally {
      setLoading(false);
    }
  };

  // Generate mock AI analysis
  const generateAnalysis = (weight, workouts, notes) => {
    const flags = [];
    if (workouts < 3) flags.push('Low workout volume this week');
    if (notes.toLowerCase().includes('pain') || notes.toLowerCase().includes('injury')) flags.push('Injury concern mentioned');

    return {
      summary: `Client completed ${workouts} workouts this week with notes: "${notes.substring(0, 50)}..."`,
      flags: flags.length > 0 ? flags : ['On track'],
      recommendation: workouts >= 4 ? 'Continue current program' : 'Increase workout frequency'
    };
  };

  // Add check-in
  const handleAddCheckIn = async (e) => {
    e.preventDefault();
    if (!selectedClient) return;

    const formData = new FormData(e.target);
    const weight = parseFloat(formData.get('weight')) || null;
    const workouts = parseInt(formData.get('workouts')) || 0;
    const notes = formData.get('notes');

    try {
      setLoading(true);
      const analysis = generateAnalysis(weight, workouts, notes);

      await addDoc(collection(db, 'checkIns'), {
        clientId: selectedClient,
        coachId: user.uid,
        weight,
        workoutsCompleted: workouts,
        notes,
        analysis,
        createdAt: serverTimestamp()
      });

      e.target.reset();
      setShowAddCheckIn(false);
      setSelectedClient(null);
      fetchCheckIns(user.uid);
    } catch (error) {
      console.error('Error adding check-in:', error);
    } finally {
      setLoading(false);
    }
  };

  // Pre-login screen
  if (!user) {
    return (
      <div className="login-container">
        <div className="login-card">
          <h1>CoachFlow AI</h1>
          <p className="subtitle">Coaching Dashboard</p>
          <button className="google-btn" onClick={handleGoogleSignIn}>
            Sign in with Google
          </button>
        </div>
      </div>
    );
  }

  // Post-login dashboard
  return (
    <div className="app-container">
      <header className="app-header">
        <div className="header-content">
          <h1>CoachFlow AI</h1>
          <div className="header-actions">
            <span className="user-email">{user.email}</span>
            <button className="btn-secondary" onClick={handleSignOut}>Sign out</button>
          </div>
        </div>
      </header>

      <main className="app-main">
        <section className="section">
          <div className="section-header">
            <h2>Clients</h2>
            <button className="btn-primary" onClick={() => setShowAddClient(!showAddClient)}>
              {showAddClient ? 'Cancel' : '+ Add Client'}
            </button>
          </div>

          {showAddClient && (
            <form className="form" onSubmit={handleAddClient}>
              <input
                type="text"
                name="clientName"
                placeholder="Client name"
                required
              />
              <input
                type="email"
                name="clientEmail"
                placeholder="Email (optional)"
              />
              <button type="submit" className="btn-primary" disabled={loading}>
                {loading ? 'Adding...' : 'Add Client'}
              </button>
            </form>
          )}

          <div className="client-list">
            {clients.length === 0 ? (
              <p className="empty-state">No clients yet. Add your first client to get started.</p>
            ) : (
              clients.map(client => (
                <div key={client.id} className="client-card">
                  <h3>{client.name}</h3>
                  {client.email && <p className="client-email">{client.email}</p>}
                  <button className="btn-secondary" onClick={() => {
                    setSelectedClient(client.id);
                    setShowAddCheckIn(true);
                  }}>
                    Log Check-in
                  </button>
                </div>
              ))
            )}
          </div>
        </section>

        <section className="section">
          <div className="section-header">
            <h2>Check-ins</h2>
            {!showAddCheckIn && (
              <button className="btn-primary" onClick={() => setShowAddCheckIn(true)}>
                + New Check-in
              </button>
            )}
          </div>

          {showAddCheckIn && (
            <form className="form" onSubmit={handleAddCheckIn}>
              <div className="form-group">
                <label>Select client</label>
                <select
                  name="client"
                  value={selectedClient || ''}
                  onChange={(e) => setSelectedClient(e.target.value)}
                  required
                >
                  <option value="">Choose a client...</option>
                  {clients.map(client => (
                    <option key={client.id} value={client.id}>
                      {client.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label>Weight (lbs)</label>
                  <input type="number" name="weight" step="0.1" placeholder="170" />
                </div>
                <div className="form-group">
                  <label>Workouts completed</label>
                  <input type="number" name="workouts" min="0" max="7" placeholder="4" />
                </div>
              </div>

              <div className="form-group">
                <label>Notes</label>
                <textarea
                  name="notes"
                  placeholder="How did the week go?"
                  rows="3"
                  required
                />
              </div>

              <div className="form-actions">
                <button type="submit" className="btn-primary" disabled={loading}>
                  {loading ? 'Saving...' : 'Save Check-in'}
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => {
                    setShowAddCheckIn(false);
                    setSelectedClient(null);
                  }}
                >
                  Cancel
                </button>
              </div>
            </form>
          )}

          <div className="checkin-list">
            {checkIns.length === 0 ? (
              <p className="empty-state">No check-ins yet. Log your first check-in to get insights.</p>
            ) : (
              checkIns.map(checkIn => {
                const client = clients.find(c => c.id === checkIn.clientId);
                const date = checkIn.createdAt?.toDate().toLocaleDateString() || 'Unknown date';
                return (
                  <div key={checkIn.id} className="checkin-card">
                    <div className="checkin-header">
                      <h3>{client?.name || 'Unknown client'}</h3>
                      <span className="date">{date}</span>
                    </div>

                    <div className="checkin-metrics">
                      {checkIn.weight && <span className="metric">Weight: {checkIn.weight} lbs</span>}
                      <span className="metric">Workouts: {checkIn.workoutsCompleted}/7</span>
                    </div>

                    <p className="notes">{checkIn.notes}</p>

                    {checkIn.analysis && (
                      <div className="analysis">
                        <div className="analysis-section">
                          <h4>Summary</h4>
                          <p>{checkIn.analysis.summary}</p>
                        </div>

                        <div className="analysis-section">
                          <h4>Flags</h4>
                          <div className="flags">
                            {checkIn.analysis.flags.map((flag, idx) => (
                              <span key={idx} className="flag">{flag}</span>
                            ))}
                          </div>
                        </div>

                        <div className="analysis-section">
                          <h4>Recommendation</h4>
                          <p>{checkIn.analysis.recommendation}</p>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </section>
      </main>
    </div>
  );
}

export default App;

