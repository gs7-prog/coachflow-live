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

const generateReferralCode = () => {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
};

// ---------------------------------------------------------------------------
// Activity thresholds (rolling days since the client's last weekly check-in)
//   green  : last check-in within GREEN_MAX_DAYS
//   yellow : last check-in within YELLOW_MAX_DAYS
//   red    : older than that, or no check-in at all
// ---------------------------------------------------------------------------
const DAY_MS = 24 * 60 * 60 * 1000;
const GREEN_MAX_DAYS = 7;
const YELLOW_MAX_DAYS = 14;

const ACTIVITY_META = {
  green: { label: 'Running good', rule: `Checked in within the last ${GREEN_MAX_DAYS} days` },
  yellow: { label: 'Keep watch', rule: `Last check-in ${GREEN_MAX_DAYS + 1} to ${YELLOW_MAX_DAYS} days ago` },
  red: { label: 'Action required', rule: `No check-in for over ${YELLOW_MAX_DAYS} days, or none yet` },
  pending: { label: 'Invite pending', rule: 'Waiting for the client to redeem their invite code' }
};

const LEVEL_ORDER = { red: 0, yellow: 1, green: 2, pending: 3 };

const TOP_NAV = [
  { id: 'dashboard', label: 'Dashboard', icon: 'dashboard' },
  { id: 'clients', label: 'Client List', icon: 'users' },
  { id: 'analytics', label: 'Analytics', icon: 'analytics' },
  { id: 'chat', label: 'Chat', icon: 'chat' }
];

// Firestore stores clientId on check-ins as the client's auth UID, while
// referrals.clientId is the id of the document in the "clients" collection.
// This finds the clients document that belongs to a signed-in client.
const getClientRecord = async (userId) => {
  const snap = await getDocs(query(collection(db, 'clients'), where('userId', '==', userId)));
  return snap.empty ? null : { id: snap.docs[0].id, ...snap.docs[0].data() };
};

const toDate = (ts) => {
  if (!ts) return null;
  if (typeof ts.toDate === 'function') return ts.toDate();
  const d = new Date(ts);
  return isNaN(d.getTime()) ? null : d;
};

const formatDate = (date) =>
  date ? date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '-';

// A client counts as active as soon as they are linked to a user account.
// This also fixes clients who redeemed their code before the status update existed.
const getAccountStatus = (client) => (client.userId ? 'active' : 'pending');

const getLastCheckInDate = (checkIns) => {
  const times = checkIns.map((c) => toDate(c.createdAt)).filter(Boolean).map((d) => d.getTime());
  return times.length ? new Date(Math.max(...times)) : null;
};

const getActivityLevel = (client, checkIns) => {
  if (getAccountStatus(client) === 'pending') return 'pending';
  const last = getLastCheckInDate(checkIns);
  if (!last) return 'red';
  const days = (Date.now() - last.getTime()) / DAY_MS;
  if (days <= GREEN_MAX_DAYS) return 'green';
  if (days <= YELLOW_MAX_DAYS) return 'yellow';
  return 'red';
};

const describeLastCheckIn = (date) => {
  if (!date) return 'No check-ins yet';
  const days = Math.floor((Date.now() - date.getTime()) / DAY_MS);
  if (days <= 0) return 'Last check-in today';
  if (days === 1) return 'Last check-in yesterday';
  return `Last check-in ${days} days ago`;
};

const getWeightPoints = (checkIns) => {
  const points = [];
  checkIns.forEach((ci) => {
    (ci.days || []).forEach((d) => {
      if (d.weight > 0) {
        points.push({ value: d.weight, label: `${formatDate(toDate(ci.createdAt))}, day ${d.day}` });
      }
    });
  });
  return points;
};

const buildClientStats = (profile, checkIns) => {
  const points = getWeightPoints(checkIns);
  const latestWeight = points.length ? points[points.length - 1].value : (profile?.weight ?? null);
  const target = profile?.targetWeight ?? null;
  const toGo = latestWeight != null && target != null ? latestWeight - target : null;
  const bmi = latestWeight && profile?.height ? latestWeight / Math.pow(profile.height / 100, 2) : null;
  const allDays = checkIns.flatMap((ci) => ci.days || []);
  const waterDays = allDays.filter((d) => d.water > 0);
  const avgWater = waterDays.length ? waterDays.reduce((s, d) => s + d.water, 0) / waterDays.length : null;
  return { points, latestWeight, target, toGo, bmi, avgWater };
};

const fmt = (value, digits = 1, unit = '') =>
  value == null || isNaN(value) ? '-' : `${Number(value).toFixed(digits)}${unit}`;

const initialOf = (name) => (name || '?').trim().charAt(0).toUpperCase();

// ---------------------------------------------------------------------------
// Icons (inline SVG, no extra dependency)
// ---------------------------------------------------------------------------
const ICONS = {
  dashboard: (
    <>
      <rect x="3" y="3" width="7" height="9" rx="1.5" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="12" width="7" height="9" rx="1.5" />
      <rect x="3" y="16" width="7" height="5" rx="1.5" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6" />
      <path d="M16 4.7a3.5 3.5 0 0 1 0 6.6" />
      <path d="M18 14.3c2.2.7 3.5 2.6 3.5 5.7" />
    </>
  ),
  analytics: (
    <>
      <path d="M5 20v-8" />
      <path d="M12 20V5" />
      <path d="M19 20v-5" />
      <path d="M2 20h20" />
    </>
  ),
  chat: <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.7A8 8 0 1 1 21 12z" />,
  logout: (
    <>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="M16 17l5-5-5-5" />
      <path d="M21 12H9" />
    </>
  ),
  plus: (
    <>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </>
  ),
  collapse: <path d="M15 6l-6 6 6 6" />,
  expand: <path d="M9 6l6 6-6 6" />,
  refresh: (
    <>
      <path d="M21 12a9 9 0 1 1-3-6.7" />
      <path d="M21 3v6h-6" />
    </>
  ),
  back: (
    <>
      <path d="M19 12H5" />
      <path d="M12 19l-7-7 7-7" />
    </>
  )
};

function Icon({ name, size = 20 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="icon"
    >
      {ICONS[name]}
    </svg>
  );
}

function WeightChart({ points, target }) {
  if (points.length < 2) {
    return <p className="empty-state">A trend line appears once the client has logged at least two weigh-ins.</p>;
  }

  const W = 640;
  const H = 200;
  const padX = 36;
  const padY = 24;
  const values = points.map((p) => p.value);
  if (target != null) values.push(target);
  const min = Math.min(...values) - 1;
  const max = Math.max(...values) + 1;
  const x = (i) => padX + (i * (W - 2 * padX)) / (points.length - 1);
  const y = (v) => H - padY - ((v - min) / (max - min)) * (H - 2 * padY);
  const line = points.map((p, i) => `${x(i)},${y(p.value)}`).join(' ');

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="weight-chart" role="img" aria-label="Weight trend">
      {target != null && (
        <g>
          <line x1={padX} x2={W - padX} y1={y(target)} y2={y(target)} className="chart-target" />
          <text x={W - padX} y={y(target) - 6} textAnchor="end" className="chart-label">
            Target {target} kg
          </text>
        </g>
      )}
      <polyline points={line} className="chart-line" />
      {points.map((p, i) => (
        <circle key={i} cx={x(i)} cy={y(p.value)} r="4" className="chart-dot">
          <title>{`${p.value} kg - ${p.label}`}</title>
        </circle>
      ))}
      <text x={padX} y={H - 4} className="chart-label">{points[0].label}</text>
      <text x={W - padX} y={H - 4} textAnchor="end" className="chart-label">{points[points.length - 1].label}</text>
    </svg>
  );
}

function App() {
  const [user, setUser] = useState(null);
  const [userRole, setUserRole] = useState(null);
  const [currentPage, setCurrentPage] = useState("dashboard");
  const [selectedClientId, setSelectedClientId] = useState(null);
  
  const [clients, setClients] = useState([]);
  const [profile, setProfile] = useState(null);
  const [coachInfo, setCoachInfo] = useState(null);
  const [weeklyCheckIns, setWeeklyCheckIns] = useState([]);
  const [loading, setLoading] = useState(false);

  // Coach dashboard state
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => window.innerWidth < 768);
  const [clientData, setClientData] = useState({});
  const [returnPage, setReturnPage] = useState('dashboard');
  const [inviteCode, setInviteCode] = useState('');
  const [copied, setCopied] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [expandedCheckIn, setExpandedCheckIn] = useState(null);
  
  // Invite code flow state
  const [showInviteCodeInput, setShowInviteCodeInput] = useState(false);
  const [inviteCodeInput, setInviteCodeInput] = useState('');
  const [inviteCodeError, setInviteCodeError] = useState('');

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
      const list = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));

      // Self-heal: clients who already redeemed their code but still carry the old "pending" status
      await Promise.all(
        list
          .filter((c) => c.userId && c.status !== 'active')
          .map(async (c) => {
            try {
              await updateDoc(doc(db, 'clients', c.id), { status: 'active' });
              c.status = 'active';
            } catch (err) {
              console.error('Could not sync client status:', err);
            }
          })
      );

      setClients(list);

      // Load each linked client's profile and check-ins (keyed by the clients document id)
      const entries = await Promise.all(
        list
          .filter((c) => c.userId)
          .map(async (c) => {
            const [profileSnap, checkInSnap] = await Promise.all([
              getDoc(doc(db, 'profiles', c.userId)),
              getDocs(query(collection(db, 'weeklyCheckIns'), where('clientId', '==', c.userId)))
            ]);
            const checkIns = checkInSnap.docs
              .map((d) => ({ id: d.id, ...d.data() }))
              .sort((a, b) => (toDate(a.createdAt)?.getTime() || 0) - (toDate(b.createdAt)?.getTime() || 0));
            return [c.id, { profile: profileSnap.exists() ? profileSnap.data() : null, checkIns }];
          })
      );
      setClientData(Object.fromEntries(entries));
    } catch (error) {
      console.error('Error fetching coach data:', error);
    }
  };

  // Load the invite code when a coach opens a client who has not redeemed yet
  useEffect(() => {
    setInviteCode('');
    setCopied(false);
    if (userRole !== 'coach' || currentPage !== 'client-detail' || !selectedClientId) return undefined;
    const target = clients.find((c) => c.id === selectedClientId);
    if (!target || target.userId) return undefined;
    let cancelled = false;
    getReferralCode(selectedClientId).then((code) => {
      if (!cancelled) setInviteCode(code);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedClientId, currentPage, userRole, clients]);

  const goTo = (page) => {
    setCurrentPage(page);
    setSelectedClientId(null);
    setExpandedCheckIn(null);
  };

  const openClient = (clientId) => {
    setReturnPage(['dashboard', 'clients', 'analytics'].includes(currentPage) ? currentPage : 'clients');
    setSelectedClientId(clientId);
    setExpandedCheckIn(null);
    setCurrentPage('client-detail');
  };

  const handleRefresh = async () => {
    if (!user) return;
    setRefreshing(true);
    await fetchCoachData(user.uid);
    setRefreshing(false);
  };

  const handleCopyInvite = async () => {
    if (!inviteCode) return;
    try {
      await navigator.clipboard.writeText(inviteCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      console.error('Copy failed:', error);
    }
  };

  const fetchClientData = async (clientId) => {
    try {
      const profileDoc = await getDoc(doc(db, 'profiles', clientId));
      if (profileDoc.exists()) {
        setProfile(profileDoc.data());
      }

      const clientRecord = await getClientRecord(clientId);
      if (clientRecord?.coachId) {
        const coachDoc = await getDoc(doc(db, 'users', clientRecord.coachId));
        if (coachDoc.exists()) {
          setCoachInfo({
            id: clientRecord.coachId,
            name: coachDoc.data().displayName,
            email: coachDoc.data().email
          });
        }
      }

      const checkInQ = query(collection(db, 'weeklyCheckIns'), where('clientId', '==', clientId));
      const checkInDocs = await getDocs(checkInQ);
      setWeeklyCheckIns(checkInDocs.docs.map(doc => ({ id: doc.id, ...doc.data() })));
    } catch (error) {
      console.error('Error fetching client data:', error);
    }
  };

  const handleGoogleSignIn = async () => {
    try {
      const result = await signInWithPopup(auth, googleProvider);
      const googleUser = result.user;

      const userDoc = await getDoc(doc(db, 'users', googleUser.uid));
      
      if (!userDoc.exists()) {
        await setDoc(doc(db, 'users', googleUser.uid), {
          email: googleUser.email,
          displayName: googleUser.displayName,
          role: 'coach',
          createdAt: serverTimestamp()
        });

        await setDoc(doc(db, 'coaches', googleUser.uid), {
          userId: googleUser.uid,
          name: googleUser.displayName,
          email: googleUser.email,
          createdAt: serverTimestamp()
        });

        setUserRole('coach');
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
      setClientData({});
      setSelectedClientId(null);
      setWeeklyCheckIns([]);
      setCoachInfo(null);
      setCurrentPage('dashboard');
      setShowInviteCodeInput(false);
      setInviteCodeInput('');
    } catch (error) {
      console.error('Sign out error:', error);
    }
  };



  const handleAddClient = async (e) => {
    e.preventDefault();
    const formData = new FormData(e.target);
    const clientName = formData.get('clientName');

    if (!clientName.trim()) return;

    try {
      setLoading(true);
      const clientRef = await addDoc(collection(db, 'clients'), {
        coachId: user.uid,
        userId: null,
        name: clientName,
        email: '',
        status: 'pending',
        createdAt: serverTimestamp()
      });

      const refCode = generateReferralCode();
      
      await addDoc(collection(db, 'referrals'), {
        coachId: user.uid,
        clientId: clientRef.id,
        referralCode: refCode,
        status: 'pending',
        createdAt: serverTimestamp()
      });

      e.target.reset();
      await fetchCoachData(user.uid);
      openClient(clientRef.id);
    } catch (error) {
      console.error('Error adding client:', error);
    } finally {
      setLoading(false);
    }
  };

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

      // referrals.clientId holds the clients-document id, not the auth uid,
      // so find the client record by userId to get the coach.
      const clientRecord = await getClientRecord(user.uid);
      const coachId = clientRecord?.coachId || null;

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

  const getReferralCode = async (clientId) => {
    try {
      const q = query(collection(db, 'referrals'), where('clientId', '==', clientId));
      const docs = await getDocs(q);
      return docs.docs[0]?.data().referralCode || 'Not found';
    } catch (error) {
      console.error('Error getting referral code:', error);
      return 'Error';
    }
  };

  if (!user) {
    return (
      <div className="login-container">
        <div className="login-card">
          <h1>CoachFlow AI</h1>
          <p className="subtitle">Coaching Dashboard</p>
          <button className="google-btn" onClick={handleGoogleSignIn}>
            Sign in with Google
          </button>
          <button 
            className="btn-secondary" 
            onClick={() => setShowInviteCodeInput(!showInviteCodeInput)}
            style={{ marginTop: '20px' }}
          >
            I have an invite code
          </button>
          
          {showInviteCodeInput && (
            <div style={{ marginTop: '20px', padding: '20px', backgroundColor: '#f5f3f0', borderRadius: '8px' }}>
              <h3>Enter Invite Code</h3>
              <input
                type="text"
                placeholder="Enter your invite code"
                value={inviteCodeInput}
                onChange={(e) => {
                  setInviteCodeInput(e.target.value);
                  setInviteCodeError('');
                }}
                style={{ width: '100%', padding: '10px', marginBottom: '10px', borderRadius: '4px', border: '1px solid #ccc' }}
              />
              {inviteCodeError && <p style={{ color: 'red', marginBottom: '10px' }}>{inviteCodeError}</p>}
              <button 
                className="btn-primary"
                onClick={async () => {
                  const codeToRedeem = inviteCodeInput.trim();
                  if (!codeToRedeem) {
                    setInviteCodeError('Please enter an invite code');
                    return;
                  }

                  try {
                    setLoading(true);
                    console.log('REDEEM: Step 1 - Code to redeem:', codeToRedeem);
                    
                    // Sign in FIRST
                    console.log('REDEEM: Step 2 - Signing in with Google');
                    const result = await signInWithPopup(auth, googleProvider);
                    const signedInUser = result.user;
                    console.log('REDEEM: Step 3 - Signed in as:', signedInUser.email, 'UID:', signedInUser.uid);

                    // Check if user already exists
                    const existingUser = await getDoc(doc(db, 'users', signedInUser.uid));
                    if (existingUser.exists()) {
                      console.log('REDEEM: User already exists');
                      setInviteCodeError('This account is already registered.');
                      setLoading(false);
                      return;
                    }

                    // NOW query the referral (after auth)
                    console.log('REDEEM: Step 4 - Querying referral');
                    const refQ = query(collection(db, 'referrals'), where('referralCode', '==', codeToRedeem));
                    const refDocs = await getDocs(refQ);
                    console.log('REDEEM: Step 5 - Found referral docs:', refDocs.docs.length);

                    if (refDocs.docs.length === 0) {
                      setInviteCodeError('Invalid invite code.');
                      setLoading(false);
                      return;
                    }

                    const referral = refDocs.docs[0].data();
                    const referralDocId = refDocs.docs[0].id;
                    console.log('REDEEM: Step 6 - Referral status:', referral.status);

                    if (referral.status !== 'pending') {
                      setInviteCodeError('This invite code has already been used.');
                      setLoading(false);
                      return;
                    }

                    // UPDATE client
                    console.log('REDEEM: Step 7 - Updating client', referral.clientId);
                    await updateDoc(doc(db, 'clients', referral.clientId), {
                      userId: signedInUser.uid,
                      email: signedInUser.email || '',
                      status: 'active',
                      acceptedAt: serverTimestamp()
                    });

                    // UPDATE referral
                    console.log('REDEEM: Step 8 - Updating referral');
                    await updateDoc(doc(db, 'referrals', referralDocId), {
                      status: 'accepted',
                      acceptedAt: serverTimestamp()
                    });

                    // CREATE user with role CLIENT
                    console.log('REDEEM: Step 9 - Creating user with role CLIENT');
                    await setDoc(doc(db, 'users', signedInUser.uid), {
                      email: signedInUser.email,
                      displayName: signedInUser.displayName,
                      role: 'client',
                      createdAt: serverTimestamp()
                    });

                    console.log('REDEEM: Step 10 - SUCCESS - User created as CLIENT');
                    setUserRole('client');
                    setShowInviteCodeInput(false);
                    setInviteCodeInput('');
                    setCurrentPage('dashboard');
                  } catch (error) {
                    console.error('REDEEM: ERROR:', error);
                    setInviteCodeError('An error occurred: ' + error.message);
                  } finally {
                    setLoading(false);
                  }
                }}
                disabled={loading}
              >
                {loading ? 'Processing...' : 'Sign In & Redeem'}
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

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

  if (userRole === 'coach') {
    const decorated = clients
      .map((c) => {
        const data = clientData[c.id] || { profile: null, checkIns: [] };
        return {
          ...c,
          accountStatus: getAccountStatus(c),
          profile: data.profile,
          checkIns: data.checkIns,
          lastCheckIn: getLastCheckInDate(data.checkIns),
          level: getActivityLevel(c, data.checkIns),
          stats: buildClientStats(data.profile, data.checkIns)
        };
      })
      .sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || (a.name || '').localeCompare(b.name || ''));

    const sidebarClients = [...decorated].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    const selectedClient = decorated.find((c) => c.id === selectedClientId);
    const activeTop = ['add-client', 'client-detail'].includes(currentPage) ? 'clients' : currentPage;
    const activeCount = decorated.filter((c) => c.accountStatus === 'active').length;
    const pendingCount = decorated.length - activeCount;

    const renderClientCard = (c) => (
      <button key={c.id} className={`activity-card level-${c.level}`} onClick={() => openClient(c.id)}>
        <div className="activity-card-head">
          <span className="client-avatar large">{initialOf(c.name)}</span>
          <div className="activity-card-title">
            <span className="activity-name">{c.name}</span>
            <span className="activity-sub">
              {c.accountStatus === 'pending' ? 'Invite not redeemed yet' : describeLastCheckIn(c.lastCheckIn)}
            </span>
          </div>
          <span className={`level-pill ${c.level}`}>{ACTIVITY_META[c.level].label}</span>
        </div>

        {c.accountStatus === 'pending' && (
          <p className="activity-note">Open this client to copy their invite code.</p>
        )}
        {c.accountStatus === 'active' && !c.profile && (
          <p className="activity-note">Profile not completed yet.</p>
        )}
        {c.accountStatus === 'active' && c.profile && (
          <div className="activity-metrics">
            <div>
              <span className="metric-value">{fmt(c.stats.latestWeight, 1, ' kg')}</span>
              <span className="metric-label">Current weight</span>
            </div>
            <div>
              <span className="metric-value">{fmt(c.stats.target, 1, ' kg')}</span>
              <span className="metric-label">Target</span>
            </div>
            <div>
              <span className="metric-value">{c.checkIns.length}</span>
              <span className="metric-label">Check-ins</span>
            </div>
          </div>
        )}
      </button>
    );

    const s = selectedClient ? selectedClient.stats : null;
    const sexLabel = { M: 'Male', F: 'Female', Other: 'Other' };

    return (
      <div className={`dashboard-container ${sidebarCollapsed ? 'collapsed' : ''}`}>
        <aside className="sidebar">
          <div className="sidebar-header">
            {!sidebarCollapsed && <h1>CoachFlow</h1>}
            <button
              className="sidebar-toggle"
              onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
              aria-label={sidebarCollapsed ? 'Expand menu' : 'Collapse menu'}
              title={sidebarCollapsed ? 'Expand menu' : 'Collapse menu'}
            >
              <Icon name={sidebarCollapsed ? 'expand' : 'collapse'} />
            </button>
          </div>

          <nav className="sidebar-nav">
            <button
              className={`nav-item ${currentPage === 'dashboard' ? 'active' : ''}`}
              onClick={() => goTo('dashboard')}
              title="Dashboard"
            >
              <Icon name="dashboard" />
              <span className="nav-label">Dashboard</span>
            </button>
            <button
              className={`nav-item ${currentPage === 'chat' ? 'active' : ''}`}
              onClick={() => goTo('chat')}
              title="Chat"
            >
              <Icon name="chat" />
              <span className="nav-label">Chat</span>
            </button>
          </nav>

          <div className="sidebar-section">
            {!sidebarCollapsed && <h3>Clients ({clients.length})</h3>}
            <button className="btn-add-client" onClick={() => goTo('add-client')} title="Add client">
              <Icon name="plus" size={16} />
              <span className="nav-label">Add Client</span>
            </button>
            <ul className="client-list">
              {sidebarClients.map((c) => (
                <li key={c.id}>
                  <button
                    className={`client-item ${selectedClientId === c.id ? 'active' : ''}`}
                    onClick={() => openClient(c.id)}
                    title={`${c.name} - ${ACTIVITY_META[c.level].label}`}
                  >
                    <span className="client-avatar">{initialOf(c.name)}</span>
                    <span className="nav-label client-name">{c.name}</span>
                    <span className={`level-dot nav-label ${c.level}`} />
                  </button>
                </li>
              ))}
            </ul>
          </div>

          <div className="sidebar-footer">
            <button className="nav-item logout" onClick={handleSignOut} title="Log out">
              <Icon name="logout" />
              <span className="nav-label">Log out</span>
            </button>
          </div>
        </aside>

        <header className="topbar">
          <nav className="topnav" aria-label="Main">
            {TOP_NAV.map((item) => (
              <button
                key={item.id}
                className={`topnav-item ${activeTop === item.id ? 'active' : ''}`}
                onClick={() => goTo(item.id)}
              >
                <Icon name={item.icon} size={18} />
                <span className="topnav-label">{item.label}</span>
              </button>
            ))}
          </nav>
          <div className="topbar-right">
            <button
              className="btn-icon"
              onClick={handleRefresh}
              disabled={refreshing}
              title="Reload client data"
              aria-label="Reload client data"
            >
              <Icon name="refresh" size={18} />
            </button>
            <span className="topbar-user">{user.displayName}</span>
          </div>
        </header>

        <main className="main-content">
          {currentPage === 'dashboard' && (
            <div className="dashboard-view">
              <div className="page-header">
                <h2>Dashboard</h2>
                <p>Welcome, {user.displayName}</p>
              </div>

              <div className="stats-grid">
                <div className="stat-card">
                  <div className="stat-value">{decorated.length}</div>
                  <div className="stat-label">Total Clients</div>
                </div>
                <div className="stat-card">
                  <div className="stat-value">{activeCount}</div>
                  <div className="stat-label">Active Clients</div>
                </div>
                <div className="stat-card">
                  <div className="stat-value">{pendingCount}</div>
                  <div className="stat-label">Pending Invites</div>
                </div>
              </div>

              <section className="section">
                <div className="section-header">
                  <div>
                    <h3>Client Activity</h3>
                    <p className="section-subtitle section-subtitle-tight">
                      Clients who need you most are listed first. Select a client to see everything they have logged.
                    </p>
                  </div>
                  <button className="btn-secondary" onClick={() => goTo('analytics')}>View analytics</button>
                </div>

                {decorated.length === 0 ? (
                  <p className="empty-state">No clients yet. Add your first client to get started.</p>
                ) : (
                  <div className="activity-grid">{decorated.map(renderClientCard)}</div>
                )}
              </section>
            </div>
          )}

          {currentPage === 'clients' && (
            <div className="dashboard-view">
              <div className="page-header page-header-row">
                <div>
                  <h2>Client List</h2>
                  <p>{decorated.length} {decorated.length === 1 ? 'client' : 'clients'} in total</p>
                </div>
                <button className="btn-primary" onClick={() => goTo('add-client')}>+ Add Client</button>
              </div>

              <section className="section">
                {decorated.length === 0 ? (
                  <p className="empty-state">No clients yet. Add your first client to get started.</p>
                ) : (
                  <div className="list-table">
                    <div className="list-row list-head">
                      <span>Client</span>
                      <span>Account</span>
                      <span>Activity</span>
                      <span>Last check-in</span>
                    </div>
                    {decorated.map((c) => (
                      <button key={c.id} className="list-row" onClick={() => openClient(c.id)}>
                        <span className="list-client">
                          <span className="client-avatar">{initialOf(c.name)}</span>
                          <span className="activity-name">{c.name}</span>
                        </span>
                        <span><span className={`badge ${c.accountStatus}`}>{c.accountStatus}</span></span>
                        <span><span className={`level-pill ${c.level}`}>{ACTIVITY_META[c.level].label}</span></span>
                        <span className="list-muted">{c.lastCheckIn ? formatDate(c.lastCheckIn) : '-'}</span>
                      </button>
                    ))}
                  </div>
                )}
              </section>
            </div>
          )}

          {currentPage === 'analytics' && (
            <div className="dashboard-view">
              <div className="page-header">
                <h2>Analytics</h2>
                <p>
                  How your active clients are keeping up with their weekly check-ins.
                  {pendingCount > 0 && ` ${pendingCount} pending ${pendingCount === 1 ? 'invite is' : 'invites are'} not included.`}
                </p>
              </div>

              <div className="analytics-grid">
                {['green', 'yellow', 'red'].map((level) => {
                  const list = decorated.filter((c) => c.level === level);
                  return (
                    <section key={level} className={`analytics-card level-${level}`}>
                      <div className="analytics-card-head">
                        <div>
                          <h3>{ACTIVITY_META[level].label}</h3>
                          <p>{ACTIVITY_META[level].rule}</p>
                        </div>
                        <span className="analytics-count">{list.length}</span>
                      </div>
                      {list.length === 0 ? (
                        <p className="empty-state">No clients in this group.</p>
                      ) : (
                        <ul className="analytics-list">
                          {list.map((c) => (
                            <li key={c.id}>
                              <button className="analytics-item" onClick={() => openClient(c.id)}>
                                <span className="client-avatar">{initialOf(c.name)}</span>
                                <span className="analytics-item-text">
                                  <span className="activity-name">{c.name}</span>
                                  <span className="activity-sub">{describeLastCheckIn(c.lastCheckIn)}</span>
                                </span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </section>
                  );
                })}
              </div>
            </div>
          )}

          {currentPage === 'chat' && (
            <div className="dashboard-view">
              <div className="page-header">
                <h2>Chat</h2>
                <p>Message your clients directly from CoachFlow.</p>
              </div>
              <section className="section chat-placeholder">
                <Icon name="chat" size={36} />
                <h3>Chat is coming soon</h3>
                <p>You will be able to message each client here. For now, use the client pages to review their check-ins.</p>
                <button className="btn-secondary" onClick={() => goTo('clients')}>Go to client list</button>
              </section>
            </div>
          )}

          {currentPage === 'add-client' && (
            <div className="page-view">
              <div className="page-header">
                <button className="btn-back icon-text" onClick={() => goTo('clients')}>
                  <Icon name="back" size={16} /> Back
                </button>
                <h2>Add New Client</h2>
                <p>You will get an invite code to share as soon as the client is created.</p>
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
            <div className="client-page">
              <button className="btn-back icon-text" onClick={() => goTo(returnPage)}>
                <Icon name="back" size={16} /> Back
              </button>

              <div className="client-page-header">
                <span className="client-avatar xlarge">{initialOf(selectedClient.name)}</span>
                <div className="client-page-title">
                  <h2>{selectedClient.name}</h2>
                  <div className="client-page-badges">
                    <span className={`badge ${selectedClient.accountStatus}`}>{selectedClient.accountStatus}</span>
                    <span className={`level-pill ${selectedClient.level}`}>{ACTIVITY_META[selectedClient.level].label}</span>
                    {selectedClient.accountStatus === 'active' && (
                      <span className="list-muted">{describeLastCheckIn(selectedClient.lastCheckIn)}</span>
                    )}
                  </div>
                </div>
              </div>

              {selectedClient.accountStatus === 'pending' && (
                <section className="section">
                  <h3>Share this invite code with your client</h3>
                  <p className="section-subtitle">
                    They sign in, choose "I have an invite code", and enter it. Once they do, this page fills with their data.
                  </p>
                  <div className="referral-link-box">
                    <input type="text" value={inviteCode || 'Loading code...'} readOnly aria-label="Invite code" />
                    <button className="btn-copy" onClick={handleCopyInvite} disabled={!inviteCode}>
                      {copied ? 'Copied' : 'Copy code'}
                    </button>
                  </div>
                </section>
              )}

              {selectedClient.accountStatus === 'active' && !selectedClient.profile && (
                <section className="section">
                  <p className="empty-state">
                    {selectedClient.name} has joined but has not completed their profile yet. Their stats appear here once they do.
                  </p>
                </section>
              )}

              {selectedClient.accountStatus === 'active' && selectedClient.profile && (
                <>
                  <div className="detail-stats">
                    <div className="stat-card">
                      <div className="stat-value">{fmt(s.latestWeight, 1)}<span className="stat-unit"> kg</span></div>
                      <div className="stat-label">Current weight</div>
                    </div>
                    <div className="stat-card">
                      <div className="stat-value">{fmt(s.target, 1)}<span className="stat-unit"> kg</span></div>
                      <div className="stat-label">Target weight</div>
                    </div>
                    <div className="stat-card">
                      <div className="stat-value">{s.toGo == null ? '-' : fmt(Math.abs(s.toGo), 1)}<span className="stat-unit"> kg</span></div>
                      <div className="stat-label">
                        {s.toGo == null ? 'To target' : s.toGo > 0.05 ? 'Left to lose' : s.toGo < -0.05 ? 'Left to gain' : 'Target reached'}
                      </div>
                    </div>
                    <div className="stat-card">
                      <div className="stat-value">{fmt(s.bmi, 1)}</div>
                      <div className="stat-label">BMI</div>
                    </div>
                    <div className="stat-card">
                      <div className="stat-value">{selectedClient.checkIns.length}</div>
                      <div className="stat-label">Check-ins</div>
                    </div>
                    <div className="stat-card">
                      <div className="stat-value">{fmt(s.avgWater, 1)}<span className="stat-unit"> L</span></div>
                      <div className="stat-label">Avg daily water</div>
                    </div>
                  </div>

                  <section className="section">
                    <h3>Weight trend</h3>
                    <WeightChart points={s.points} target={s.target} />
                  </section>

                  <section className="section">
                    <h3>Profile</h3>
                    <dl className="profile-facts">
                      <div><dt>Age</dt><dd>{selectedClient.profile.age ?? '-'}</dd></div>
                      <div><dt>Sex</dt><dd>{sexLabel[selectedClient.profile.sex] || selectedClient.profile.sex || '-'}</dd></div>
                      <div><dt>Height</dt><dd>{fmt(selectedClient.profile.height, 0, ' cm')}</dd></div>
                      <div><dt>Starting weight</dt><dd>{fmt(selectedClient.profile.weight, 1, ' kg')}</dd></div>
                      <div><dt>Activity level</dt><dd className="capitalize">{selectedClient.profile.activityLevel || '-'}</dd></div>
                      <div><dt>Daily steps (average)</dt><dd>{selectedClient.profile.steps ?? '-'}</dd></div>
                      <div><dt>Daily water goal</dt><dd>{fmt(selectedClient.profile.water, 1, ' L')}</dd></div>
                    </dl>
                  </section>

                  <section className="section">
                    <h3>Check-in history</h3>
                    {selectedClient.checkIns.length === 0 ? (
                      <p className="empty-state">No check-ins yet. They will appear here as soon as the client logs one.</p>
                    ) : (
                      <div className="checkin-history">
                        {[...selectedClient.checkIns].reverse().map((ci) => {
                          const open = expandedCheckIn === ci.id;
                          const days = ci.days || [];
                          const logged = days.filter(
                            (d) => d.weight > 0 || d.water > 0 || Object.values(d.meals || {}).some(Boolean)
                          ).length;
                          return (
                            <div key={ci.id} className={`checkin-row ${open ? 'open' : ''}`}>
                              <button
                                className="checkin-row-head"
                                onClick={() => setExpandedCheckIn(open ? null : ci.id)}
                                aria-expanded={open}
                              >
                                <span className="checkin-row-title">Check-in on {formatDate(toDate(ci.createdAt))}</span>
                                <span className="checkin-row-meta">{logged} of {days.length || 7} days logged</span>
                              </button>
                              {open && (
                                <div className="table-scroll">
                                  <table className="data-table">
                                    <thead>
                                      <tr>
                                        <th>Day</th>
                                        <th>Weight</th>
                                        <th>Breakfast</th>
                                        <th>Lunch</th>
                                        <th>Dinner</th>
                                        <th>Snacks</th>
                                        <th>Water</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {days.map((d) => (
                                        <tr key={d.day}>
                                          <td>{d.day}</td>
                                          <td>{d.weight > 0 ? `${d.weight} kg` : '-'}</td>
                                          <td>{d.meals?.breakfast || '-'}</td>
                                          <td>{d.meals?.lunch || '-'}</td>
                                          <td>{d.meals?.dinner || '-'}</td>
                                          <td>{d.meals?.snacks || '-'}</td>
                                          <td>{d.water > 0 ? `${d.water} L` : '-'}</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </section>
                </>
              )}
            </div>
          )}
        </main>
      </div>
    );
  }

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
