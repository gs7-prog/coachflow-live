import React, { useState, useEffect } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInWithPopup, GoogleAuthProvider, signOut, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, collection, addDoc, query, where, getDocs, serverTimestamp, getDoc, doc, updateDoc, setDoc } from 'firebase/firestore';
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

// Helper: Generate unique referral code
const generateReferralCode = () => {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
};

// Helper: Get referral code from URL
const getReferralCodeFromUrl = () => {
  const path = window.location.pathname;
  const match = path.match(/\/referral\/([a-z0-9]+)/i);
  return match ? match[1] : null;
};

function App() {
  const [user, setUser] = useState(null);
  const [userRole, setUserRole] = useState(null); // "coach" or "client"
  const [currentPage, setCurrentPage] = useState("dashboard"); // dashboard, client-detail, profile, checkin
  const [selectedClientId, setSelectedClientId] = useState(null);
  
  // Coach data
  const [clients, setClients] = useState([]);
  
  // Client data
  const [profile, setProfile] = useState(null);
  const [coachInfo, setCoachInfo] = useState(null);
  const [weeklyCheckIns, setWeeklyCheckIns] = useState([]);
  
  // UI state
  const [loading, setLoading] = useState(false);
  const [coachName, setCoachName] = useState("");
  
  // Get referral code from URL on component mount
  const referralCodeFromUrl = getReferralCodeFromUrl();

  // Load user data function
  const loadUserData = async (userId) => {
    try {
      const userDoc = await getDoc(doc(db, 'users', userId));
      if (userDoc.exists()) {
        setUserRole(userDoc.data().role);
        if (userDoc.data().role === 'coach') {
          fetchCoachData(userId);
        } else if (userDoc.data().role === 'client') {
          fetchClientData(userId);
        }
      }
    } catch (error) {
      console.error('Error loading user data:', error);
    }
  };

  // Auth listener
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      setUser(currentUser);
      if (currentUser) {
        await loadUserData(currentUser.uid);
      }
    });
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);



  const fetchCoachData = async (coachId) => {
    try {
      const q = query(collection(db, 'clients'), where('coachId', '==', coachId));
      const snapshot = await getDocs(q);
      setClients(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })));
    } catch (error) {
      console.error('Error fetching coach data:', error);
    }
  };

  const fetchClientData = async (clientId) => {
    try {
      const profileDoc = await getDoc(doc(db, 'profiles', clientId));
      if (profileDoc.exists()) {
        setProfile(profileDoc.data());
      }

      // Find which coach this client belongs to
      const q = query(collection(db, 'referrals'), 
        where('clientId', '==', clientId),
        where('status', '==', 'accepted')
      );
      const referralDocs = await getDocs(q);
      if (referralDocs.docs.length > 0) {
        const coachId = referralDocs.docs[0].data().coachId;
        const coachDoc = await getDoc(doc(db, 'users', coachId));
        setCoachInfo({
          id: coachId,
          name: coachDoc.data().displayName,
          email: coachDoc.data().email
        });
      }

      // Fetch weekly check-ins
      const checkInQ = query(collection(db, 'weeklyCheckIns'), where('clientId', '==', clientId));
      const checkInDocs = await getDocs(checkInQ);
      setWeeklyCheckIns(checkInDocs.docs.map(doc => ({ id: doc.id, ...doc.data() })));
    } catch (error) {
      console.error('Error fetching client data:', error);
    }
  };

  // Sign in with Google
  const handleGoogleSignIn = async () => {
    try {
      const result = await signInWithPopup(auth, googleProvider);
      const googleUser = result.user;

      // Check if user already exists
      const userDoc = await getDoc(doc(db, 'users', googleUser.uid));
      
      if (!userDoc.exists()) {
        // First time user - determine role based on referral code
        // Check URL again after auth completes (in case it changed)
        const currentRefCode = getReferralCodeFromUrl();
        console.log('Current URL pathname:', window.location.pathname);
        console.log('Detected referral code:', currentRefCode);
        let role = 'coach';
        if (currentRefCode) {
          role = 'client';
          console.log('Setting role as CLIENT');
          // Fetch coach name for display
          const refQ = query(collection(db, 'referrals'), where('referralCode', '==', currentRefCode));
          const refDocs = await getDocs(refQ);
          if (refDocs.docs.length > 0) {
            const referral = refDocs.docs[0].data();
            const coachDoc = await getDoc(doc(db, 'users', referral.coachId));
            setCoachName(coachDoc.data().displayName);

              // Update referral and client
              const clientDoc = await getDoc(doc(db, 'clients', referral.clientId));
              if (clientDoc.exists()) {
                await updateDoc(doc(db, 'clients', referral.clientId), {
                  userId: googleUser.uid
                });
                await updateDoc(doc(db, 'referrals', refDocs.docs[0].id), {
                  status: 'accepted',
                  acceptedAt: serverTimestamp()
                });
              }
            }
          }
        }

        // Create user doc
        await setDoc(doc(db, 'users', googleUser.uid), {
          email: googleUser.email,
          displayName: googleUser.displayName,
          role,
          createdAt: serverTimestamp()
        });

        // If coach, create coach doc
        if (role === 'coach') {
          await setDoc(doc(db, 'coaches', googleUser.uid), {
            userId: googleUser.uid,
            name: googleUser.displayName,
            email: googleUser.email,
            createdAt: serverTimestamp()
          });
        }

        setUserRole(role);
      }
    } catch (error) {
      console.error('Sign in error:', error);
    }
  };

  const handleSignOut = async () => {
    try {
      await signOut(auth);
      setUser(null);
      setUserRole(null);
      setClients([]);
      setProfile(null);
      setCurrentPage('dashboard');
    } catch (error) {
      console.error('Sign out error:', error);
    }
  };

  // Coach: Add new client
  const handleAddClient = async (e) => {
    e.preventDefault();
    const formData = new FormData(e.target);
    const clientName = formData.get('clientName');

    if (!clientName.trim()) return;

    try {
      setLoading(true);
      // Create client doc
      const clientRef = await addDoc(collection(db, 'clients'), {
        coachId: user.uid,
        userId: null,
        name: clientName,
        email: '',
        status: 'pending',
        createdAt: serverTimestamp()
      });

      // Create referral
      const referralCode = generateReferralCode();
      const referralLink = `${window.location.origin}/referral/${referralCode}`;
      
      await addDoc(collection(db, 'referrals'), {
        coachId: user.uid,
        clientId: clientRef.id,
        referralCode,
        referralLink,
        status: 'pending',
        createdAt: serverTimestamp()
      });

      e.target.reset();
      fetchCoachData(user.uid);
    } catch (error) {
      console.error('Error adding client:', error);
    } finally {
      setLoading(false);
    }
  };

  // Client: Save profile
  const handleSaveProfile = async (e) => {
    e.preventDefault();
    const formData = new FormData(e.target);

    try {
      setLoading(true);
      const profileData = {
        age: parseInt(formData.get('age')),
        sex: formData.get('sex'),
        height: parseFloat(formData.get('height')),
        weight: parseFloat(formData.get('weight')),
        targetWeight: parseFloat(formData.get('targetWeight')),
        activityLevel: formData.get('activityLevel'),
        steps: parseInt(formData.get('steps')),
        water: parseFloat(formData.get('water')),
        createdAt: serverTimestamp(),
        lastUpdated: serverTimestamp()
      };

      await setDoc(doc(db, 'profiles', user.uid), profileData);
      setProfile(profileData);
      setCurrentPage('dashboard');
      e.target.reset();
    } catch (error) {
      console.error('Error saving profile:', error);
    } finally {
      setLoading(false);
    }
  };

  // Client: Save weekly check-in
  const handleSaveWeeklyCheckIn = async (e) => {
    e.preventDefault();
    const formData = new FormData(e.target);

    try {
      setLoading(true);
      const days = [];
      for (let i = 1; i <= 7; i++) {
        days.push({
          day: i,
          weight: parseFloat(formData.get(`weight-${i}`)) || 0,
          meals: {
            breakfast: formData.get(`breakfast-${i}`),
            lunch: formData.get(`lunch-${i}`),
            dinner: formData.get(`dinner-${i}`),
            snacks: formData.get(`snacks-${i}`)
          },
          water: parseFloat(formData.get(`water-${i}`)) || 0
        });
      }

      // Find coach
      const refQ = query(collection(db, 'referrals'),
        where('clientId', '==', user.uid),
        where('status', '==', 'accepted')
      );
      const refDocs = await getDocs(refQ);
      const coachId = refDocs.docs[0]?.data().coachId;

      await addDoc(collection(db, 'weeklyCheckIns'), {
        clientId: user.uid,
        coachId,
        weekStart: serverTimestamp(),
        weekNumber: Math.ceil((new Date().getDate()) / 7),
        days,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });

      fetchClientData(user.uid);
      setCurrentPage('dashboard');
      e.target.reset();
    } catch (error) {
      console.error('Error saving check-in:', error);
    } finally {
      setLoading(false);
    }
  };

  // Coach: Get referral link for client
  const getReferralLink = async (clientId) => {
    try {
      const q = query(collection(db, 'referrals'), where('clientId', '==', clientId));
      const docs = await getDocs(q);
      return docs.docs[0]?.data().referralLink || 'Not found';
    } catch (error) {
      console.error('Error getting referral link:', error);
      return 'Error';
    }
  };

  // Render referral landing page
  if (referralCodeFromUrl && !user) {
    return (
      <div className="referral-page">
        <div className="referral-card">
          <div className="referral-icon">🏋️</div>
          <h1>{coachName} invited you to CoachFlow</h1>
          <p className="referral-subtitle">
            CoachFlow is your personal fitness coaching platform. Your coach will guide you through your fitness journey with personalized insights and weekly check-ins.
          </p>
          <button className="referral-google-btn" onClick={handleGoogleSignIn}>
            Sign in with Google
          </button>
          <p className="referral-footer">You'll be guided through a simple profile setup after signing in.</p>
        </div>
      </div>
    );
  }

  // Not logged in
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

  // Client: Profile setup
  if (userRole === 'client' && !profile && currentPage === 'dashboard') {
    return (
      <div className="client-container">
        <header className="client-header">
          <h1>CoachFlow</h1>
          <div className="header-actions">
            <span className="user-email">{user.email}</span>
            <button className="btn-secondary" onClick={handleSignOut}>Sign out</button>
          </div>
        </header>

        <main className="client-main">
          <section className="section">
            <h2>Complete Your Profile</h2>
            <p className="section-subtitle">Help your coach understand your fitness background</p>

            <form className="form" onSubmit={handleSaveProfile}>
              <div className="form-row">
                <div className="form-group">
                  <label>Age</label>
                  <input type="number" name="age" min="18" required />
                </div>
                <div className="form-group">
                  <label>Sex</label>
                  <select name="sex" required>
                    <option value="">Select...</option>
                    <option value="M">Male</option>
                    <option value="F">Female</option>
                    <option value="Other">Other</option>
                  </select>
                </div>
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label>Height (cm)</label>
                  <input type="number" name="height" min="100" max="250" required />
                </div>
                <div className="form-group">
                  <label>Current Weight (kg)</label>
                  <input type="number" name="weight" step="0.1" required />
                </div>
              </div>

              <div className="form-group">
                <label>Target Weight (kg)</label>
                <input type="number" name="targetWeight" step="0.1" required />
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label>Activity Level</label>
                  <select name="activityLevel" required>
                    <option value="">Select...</option>
                    <option value="sedentary">Sedentary (little exercise)</option>
                    <option value="light">Light (1-3 days/week)</option>
                    <option value="moderate">Moderate (3-5 days/week)</option>
                    <option value="active">Active (6-7 days/week)</option>
                    <option value="very active">Very Active (twice a day)</option>
                  </select>
                </div>
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label>Daily Steps (average)</label>
                  <input type="number" name="steps" min="0" required />
                </div>
                <div className="form-group">
                  <label>Daily Water (liters)</label>
                  <input type="number" name="water" step="0.5" min="0" required />
                </div>
              </div>

              <button type="submit" className="btn-primary" disabled={loading}>
                {loading ? 'Saving...' : 'Save Profile'}
              </button>
            </form>
          </section>
        </main>
      </div>
    );
  }

  // Coach dashboard
  if (userRole === 'coach') {
    const selectedClient = clients.find(c => c.id === selectedClientId);

    return (
      <div className="dashboard-container">
        <aside className="sidebar">
          <div className="sidebar-header">
            <h1>CoachFlow</h1>
          </div>
          
          <nav className="sidebar-nav">
            <button
              className={`nav-item ${currentPage === 'dashboard' ? 'active' : ''}`}
              onClick={() => {
                setCurrentPage('dashboard');
                setSelectedClientId(null);
              }}
            >
              Dashboard
            </button>
          </nav>

          <div className="sidebar-section">
            <h3>Clients ({clients.length})</h3>
            <button 
              className="btn-add-client"
              onClick={() => setCurrentPage('add-client')}
            >
              + Add Client
            </button>
            <ul className="client-list">
              {clients.map(client => (
                <li key={client.id}>
                  <button
                    className={`client-item ${selectedClientId === client.id ? 'active' : ''}`}
                    onClick={() => {
                      setSelectedClientId(client.id);
                      setCurrentPage('client-detail');
                    }}
                  >
                    {client.name}
                    <span className={`status ${client.status}`}>{client.status}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>

          <div className="sidebar-footer">
            <button className="btn-secondary" onClick={handleSignOut}>Sign out</button>
          </div>
        </aside>

        <main className="main-content">
          {currentPage === 'dashboard' && (
            <div className="dashboard-view">
              <div className="page-header">
                <h2>Dashboard</h2>
                <p>Welcome, {user.displayName}</p>
              </div>

              <div className="stats-grid">
                <div className="stat-card">
                  <div className="stat-value">{clients.length}</div>
                  <div className="stat-label">Total Clients</div>
                </div>
                <div className="stat-card">
                  <div className="stat-value">{clients.filter(c => c.status === 'active').length}</div>
                  <div className="stat-label">Active Clients</div>
                </div>
                <div className="stat-card">
                  <div className="stat-value">{clients.filter(c => c.status === 'pending').length}</div>
                  <div className="stat-label">Pending Invites</div>
                </div>
              </div>

              <section className="section">
                <h3>Recent Clients</h3>
                <div className="clients-table">
                  {clients.length === 0 ? (
                    <p className="empty-state">No clients yet. Add your first client to get started.</p>
                  ) : (
                    clients.map(client => (
                      <div key={client.id} className="table-row" onClick={() => {
                        setSelectedClientId(client.id);
                        setCurrentPage('client-detail');
                      }}>
                        <div className="row-cell">{client.name}</div>
                        <div className="row-cell"><span className={`badge ${client.status}`}>{client.status}</span></div>
                        <div className="row-cell">View</div>
                      </div>
                    ))
                  )}
                </div>
              </section>
            </div>
          )}

          {currentPage === 'add-client' && (
            <div className="page-view">
              <div className="page-header">
                <button className="btn-back" onClick={() => setCurrentPage('dashboard')}>← Back</button>
                <h2>Add New Client</h2>
              </div>

              <form className="form" onSubmit={handleAddClient}>
                <div className="form-group">
                  <label>Client Name</label>
                  <input type="text" name="clientName" placeholder="John Smith" required />
                </div>
                <button type="submit" className="btn-primary" disabled={loading}>
                  {loading ? 'Adding...' : 'Add Client'}
                </button>
              </form>
            </div>
          )}

          {currentPage === 'client-detail' && selectedClient && (
            <div className="page-view">
              <div className="page-header">
                <button className="btn-back" onClick={() => {
                  setCurrentPage('dashboard');
                  setSelectedClientId(null);
                }}>← Back</button>
                <div>
                  <h2>{selectedClient.name}</h2>
                  <p className="status-text">Status: <span className={`status-badge ${selectedClient.status}`}>{selectedClient.status}</span></p>
                </div>
              </div>

              {selectedClient.status === 'pending' && (
                <div className="pending-section">
                  <h3>Waiting for client to accept invitation...</h3>
                  <p>Share this link with your client:</p>
                  <div className="referral-link-box">
                    <input 
                      type="text" 
                      value={`${window.location.origin}/referral/[code]`}
                      readOnly 
                    />
                    <button className="btn-copy" onClick={async () => {
                      const link = await getReferralLink(selectedClient.id);
                      navigator.clipboard.writeText(link);
                      alert('Link copied!');
                    }}>
                      Copy Link
                    </button>
                  </div>
                </div>
              )}

              {selectedClient.status === 'active' && (
                <div className="client-detail-view">
                  <div className="detail-grid">
                    <div className="detail-section">
                      <h3>Profile Information</h3>
                      <p>Profile data will appear here once client completes setup</p>
                    </div>
                    <div className="detail-section">
                      <h3>Weekly Check-ins</h3>
                      <p>Check-ins will appear here</p>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </main>
      </div>
    );
  }

  // Client dashboard
  if (userRole === 'client') {
    return (
      <div className="client-container">
        <header className="client-header">
          <h1>CoachFlow</h1>
          <div className="header-actions">
            <span className="user-email">{coachInfo && `Coach: ${coachInfo.name}`}</span>
            <button className="btn-secondary" onClick={handleSignOut}>Sign out</button>
          </div>
        </header>

        <main className="client-main">
          {currentPage === 'dashboard' && (
            <>
              <section className="section">
                <div className="section-header">
                  <h2>Your Profile</h2>
                  {profile && <button className="btn-secondary" onClick={() => setCurrentPage('profile')}>Edit</button>}
                </div>
                
                {profile ? (
                  <div className="profile-grid">
                    <div className="profile-item">
                      <span className="label">Current Weight</span>
                      <span className="value">{profile.weight} kg</span>
                    </div>
                    <div className="profile-item">
                      <span className="label">Target Weight</span>
                      <span className="value">{profile.targetWeight} kg</span>
                    </div>
                    <div className="profile-item">
                      <span className="label">Progress</span>
                      <span className="value">{((profile.weight - profile.targetWeight) / (profile.weight - profile.targetWeight + 1) * 100).toFixed(0)}%</span>
                    </div>
                  </div>
                ) : (
                  <button className="btn-primary" onClick={() => setCurrentPage('profile')}>Complete Profile</button>
                )}
              </section>

              <section className="section">
                <div className="section-header">
                  <h2>Weekly Check-ins</h2>
                  <button className="btn-primary" onClick={() => setCurrentPage('checkin')}>+ Log Check-in</button>
                </div>

                {weeklyCheckIns.length === 0 ? (
                  <p className="empty-state">No check-ins yet. Log your first weekly check-in!</p>
                ) : (
                  <div className="checkins-list">
                    {weeklyCheckIns.map(checkIn => (
                      <div key={checkIn.id} className="checkin-summary">
                        <h4>Week {checkIn.weekNumber}</h4>
                        <p>{checkIn.days?.length || 0} days logged</p>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </>
          )}

          {currentPage === 'profile' && (
            <div>
              <button className="btn-back" onClick={() => setCurrentPage('dashboard')}>← Back</button>
              <form className="form" onSubmit={handleSaveProfile}>
                <div className="form-row">
                  <div className="form-group">
                    <label>Age</label>
                    <input type="number" name="age" defaultValue={profile?.age} min="18" required />
                  </div>
                  <div className="form-group">
                    <label>Sex</label>
                    <select name="sex" defaultValue={profile?.sex} required>
                      <option value="">Select...</option>
                      <option value="M">Male</option>
                      <option value="F">Female</option>
                      <option value="Other">Other</option>
                    </select>
                  </div>
                </div>

                <div className="form-row">
                  <div className="form-group">
                    <label>Height (cm)</label>
                    <input type="number" name="height" defaultValue={profile?.height} min="100" max="250" required />
                  </div>
                  <div className="form-group">
                    <label>Current Weight (kg)</label>
                    <input type="number" name="weight" defaultValue={profile?.weight} step="0.1" required />
                  </div>
                </div>

                <div className="form-group">
                  <label>Target Weight (kg)</label>
                  <input type="number" name="targetWeight" defaultValue={profile?.targetWeight} step="0.1" required />
                </div>

                <div className="form-row">
                  <div className="form-group">
                    <label>Activity Level</label>
                    <select name="activityLevel" defaultValue={profile?.activityLevel} required>
                      <option value="">Select...</option>
                      <option value="sedentary">Sedentary (little exercise)</option>
                      <option value="light">Light (1-3 days/week)</option>
                      <option value="moderate">Moderate (3-5 days/week)</option>
                      <option value="active">Active (6-7 days/week)</option>
                      <option value="very active">Very Active (twice a day)</option>
                    </select>
                  </div>
                </div>

                <div className="form-row">
                  <div className="form-group">
                    <label>Daily Steps (average)</label>
                    <input type="number" name="steps" defaultValue={profile?.steps} min="0" required />
                  </div>
                  <div className="form-group">
                    <label>Daily Water (liters)</label>
                    <input type="number" name="water" defaultValue={profile?.water} step="0.5" min="0" required />
                  </div>
                </div>

                <button type="submit" className="btn-primary" disabled={loading}>
                  {loading ? 'Saving...' : 'Save Profile'}
                </button>
              </form>
            </div>
          )}

          {currentPage === 'checkin' && (
            <div>
              <button className="btn-back" onClick={() => setCurrentPage('dashboard')}>← Back</button>
              <h2>Weekly Check-in</h2>
              <form className="form weekly-form" onSubmit={handleSaveWeeklyCheckIn}>
                {[1, 2, 3, 4, 5, 6, 7].map(day => (
                  <div key={day} className="day-section">
                    <h4>Day {day}</h4>
                    
                    <div className="form-row">
                      <div className="form-group">
                        <label>Weight (kg)</label>
                        <input type="number" name={`weight-${day}`} step="0.1" />
                      </div>
                    </div>

                    <div className="form-group">
                      <label>Breakfast</label>
                      <input type="text" name={`breakfast-${day}`} placeholder="What did you eat?" />
                    </div>

                    <div className="form-group">
                      <label>Lunch</label>
                      <input type="text" name={`lunch-${day}`} placeholder="What did you eat?" />
                    </div>

                    <div className="form-group">
                      <label>Dinner</label>
                      <input type="text" name={`dinner-${day}`} placeholder="What did you eat?" />
                    </div>

                    <div className="form-row">
                      <div className="form-group">
                        <label>Snacks</label>
                        <input type="text" name={`snacks-${day}`} placeholder="Any snacks?" />
                      </div>
                      <div className="form-group">
                        <label>Water (liters)</label>
                        <input type="number" name={`water-${day}`} step="0.5" min="0" />
                      </div>
                    </div>
                  </div>
                ))}

                <button type="submit" className="btn-primary" disabled={loading}>
                  {loading ? 'Saving...' : 'Save Check-in'}
                </button>
              </form>
            </div>
          )}
        </main>
      </div>
    );
  }
}

export default App;
