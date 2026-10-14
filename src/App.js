import React, { useState, useEffect, useRef } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInWithPopup, reauthenticateWithPopup, GoogleAuthProvider, signOut, onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword, sendEmailVerification, sendPasswordResetEmail, updateProfile, deleteUser, applyActionCode, verifyPasswordResetCode, confirmPasswordReset } from 'firebase/auth';
import { getFirestore, collection, addDoc, query, where, getDocs, serverTimestamp, getDoc, doc, updateDoc, setDoc, deleteDoc } from 'firebase/firestore';
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
  pending: { label: 'Invite pending', rule: 'Waiting for the client to redeem their invite code' },
  completed: { label: 'Programme completed', rule: 'Programme marked as completed by you' }
};

const LEVEL_ORDER = { red: 0, yellow: 1, green: 2, pending: 3, completed: 4 };

const TOP_NAV = [
  { id: 'dashboard', label: 'Dashboard', icon: 'dashboard' },
  { id: 'clients', label: 'Client List', icon: 'users' },
  { id: 'analytics', label: 'Analytics', icon: 'analytics' },
  { id: 'calendar', label: 'Calendar', icon: 'calendar' },
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
  const times = checkIns.map((c) => checkInDate(c)).filter(Boolean).map((d) => d.getTime());
  return times.length ? new Date(Math.max(...times)) : null;
};

const getActivityLevel = (client, checkIns) => {
  if (client.programmeStatus === 'completed') return 'completed';
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
        points.push({ value: d.weight, label: formatDate(dayDateOf(ci, d)) });
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
      {ICONS[name] || ICONS_EXTRA[name]}
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

// ---------------------------------------------------------------------------
// Preferences (theme and language are remembered in this browser)
// ---------------------------------------------------------------------------
const readPref = (key, fallback) => {
  try {
    return window.localStorage.getItem(key) || fallback;
  } catch (err) {
    return fallback;
  }
};

// Apply the saved theme immediately so there is no flash of the wrong theme on load
if (typeof document !== 'undefined') {
  document.documentElement.setAttribute('data-theme', readPref('coachflow-theme', 'light'));
}

const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'et', label: 'Estonian' },
  { code: 'ru', label: 'Russian' }
];

// ---------------------------------------------------------------------------
// Subscription plans (placeholder prices - edit freely)
// ---------------------------------------------------------------------------
const PLANS = [
  {
    id: 'starter',
    name: 'Free',
    price: 0,
    tagline: 'Everything you need to get started',
    features: ['Up to 10 clients', 'Client profiles and weekly check-ins', 'Activity analytics']
  },
  {
    id: 'pro',
    name: 'Pro',
    price: 19.99,
    tagline: 'For a growing coaching practice',
    features: ['Unlimited clients', 'Everything in Free', 'Priority support', 'AI check-in analysis when released']
  }
];

const BRAND_LABEL = { visa: 'Visa', mastercard: 'Mastercard', amex: 'American Express', card: 'Card' };

const formatMoney = (amount, currency = 'EUR') =>
  new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount || 0);

const luhnValid = (num) => {
  let sum = 0;
  let alt = false;
  for (let i = num.length - 1; i >= 0; i--) {
    let n = parseInt(num[i], 10);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
};

const detectBrand = (num) => {
  if (/^4/.test(num)) return 'visa';
  if (/^(5[1-5]|2(2[2-9]|[3-6]\d|7[01]|720))/.test(num)) return 'mastercard';
  if (/^3[47]/.test(num)) return 'amex';
  return 'card';
};

const parseExpiry = (value) => {
  const match = /^(\d{2})\s*\/\s*(\d{2})$/.exec(value);
  if (!match) return null;
  const month = parseInt(match[1], 10);
  const year = 2000 + parseInt(match[2], 10);
  const now = new Date();
  if (month < 1 || month > 12) return null;
  if (year < now.getFullYear() || (year === now.getFullYear() && month < now.getMonth() + 1)) return null;
  return { month, year };
};

const makeInvoiceNumber = () => {
  const now = new Date();
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
  return `CF-${stamp}-${Math.floor(1000 + Math.random() * 9000)}`;
};

// ---------------------------------------------------------------------------
// Chart helpers
// ---------------------------------------------------------------------------
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

const bucketCheckIns = (dates, range) => {
  const now = new Date();
  const today = startOfDay(now).getTime();
  const buckets = [];

  if (range === 'daily') {
    for (let i = 13; i >= 0; i--) {
      const start = new Date(today - i * DAY_MS);
      buckets.push({
        label: start.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }),
        start: start.getTime(),
        end: start.getTime() + DAY_MS
      });
    }
  } else if (range === 'monthly') {
    for (let i = 5; i >= 0; i--) {
      const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const end = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
      buckets.push({
        label: start.toLocaleDateString(undefined, { month: 'short' }),
        start: start.getTime(),
        end: end.getTime()
      });
    }
  } else {
    for (let i = 7; i >= 0; i--) {
      const end = today + DAY_MS - i * 7 * DAY_MS;
      const start = end - 7 * DAY_MS;
      buckets.push({
        label: new Date(start).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }),
        start,
        end
      });
    }
  }

  return buckets.map((b) => ({
    label: b.label,
    value: dates.filter((d) => d.getTime() >= b.start && d.getTime() < b.end).length
  }));
};

// Running total at the end of each of the last N weeks
const cumulativeWeekly = (dates, weeks = 8) => {
  const endToday = startOfDay(new Date()).getTime() + DAY_MS;
  return Array.from({ length: weeks }, (_, i) => {
    const end = endToday - (weeks - 1 - i) * 7 * DAY_MS;
    return dates.filter((d) => d.getTime() < end).length;
  });
};

const smoothPath = (pts) => {
  if (pts.length < 2) return '';
  let d = `M${pts[0].x},${pts[0].y}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C${c1x},${c1y} ${c2x},${c2y} ${p2.x},${p2.y}`;
  }
  return d;
};

// ---------------------------------------------------------------------------
// More icons
// ---------------------------------------------------------------------------
const ICONS_EXTRA = {
  card: (
    <>
      <rect x="2" y="5" width="20" height="14" rx="2.5" />
      <path d="M2 10h20" />
      <path d="M6 15h4" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </>
  ),
  moon: <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </>
  ),
  grid: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </>
  ),
  list: (
    <>
      <path d="M8 6h13M8 12h13M8 18h13" />
      <path d="M3 6h.01M3 12h.01M3 18h.01" />
    </>
  ),
  segments: (
    <>
      <rect x="3" y="3" width="5" height="18" rx="1.5" />
      <rect x="10" y="3" width="5" height="12" rx="1.5" />
      <rect x="17" y="3" width="4" height="15" rx="1.5" />
    </>
  ),
  x: <path d="M18 6L6 18M6 6l12 12" />,
  chevronDown: <path d="M6 9l6 6 6-6" />,
  user: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4 3.6-7 8-7s8 3 8 7" />
    </>
  ),
  mail: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M3 7l9 6 9-6" />
    </>
  ),
  alert: (
    <>
      <path d="M12 3l10 18H2L12 3z" />
      <path d="M12 10v5M12 18h.01" />
    </>
  ),
  check: <path d="M5 12l5 5 9-10" />,
  tag: (
    <>
      <path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9-9-9z" />
      <circle cx="8" cy="8" r="1.5" />
    </>
  ),
  shield: <path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z" />,
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.5 3 2.5 15 0 18M12 3c-2.5 3-2.5 15 0 18" />
    </>
  ),
  palette: (
    <>
      <path d="M12 3a9 9 0 0 0 0 18c1.2 0 1.8-.8 1.8-1.7 0-1.2-.9-1.7-.9-2.7 0-1 .8-1.6 1.8-1.6H17a4 4 0 0 0 4-4c0-4.4-4-7-9-7z" />
      <circle cx="7.5" cy="11" r="1" />
      <circle cx="10" cy="7.5" r="1" />
      <circle cx="15" cy="7.5" r="1" />
    </>
  ),
  link: (
    <>
      <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
      <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
    </>
  ),
  mobile: (
    <>
      <rect x="6" y="2" width="12" height="20" rx="2.5" />
      <path d="M11 18h2" />
    </>
  ),
  calendar: (
    <>
      <rect x="3" y="4" width="18" height="17" rx="2.5" />
      <path d="M3 9h18M8 2v4M16 2v4" />
    </>
  ),
  video: (
    <>
      <rect x="2" y="6" width="14" height="12" rx="2.5" />
      <path d="M16 10l6-3v10l-6-3z" />
    </>
  ),
  pause: (
    <>
      <rect x="6" y="5" width="4" height="14" rx="1" />
      <rect x="14" y="5" width="4" height="14" rx="1" />
    </>
  ),
  trophy: (
    <>
      <path d="M8 21h8M12 17v4" />
      <path d="M7 4h10v5a5 5 0 0 1-10 0V4z" />
      <path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3" />
    </>
  ),
  gift: (
    <>
      <rect x="3" y="8" width="18" height="4" rx="1" />
      <path d="M12 8v13M5 12v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-8" />
      <path d="M12 8c-1-3-5-4-5-1.5S10 8 12 8zM12 8c1-3 5-4 5-1.5S14 8 12 8z" />
    </>
  ),
  star: <path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9L12 3z" />,
  book: (
    <>
      <path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2V5z" />
      <path d="M19 17H6a2 2 0 0 0-2 2" />
    </>
  ),
  cart: (
    <>
      <circle cx="9" cy="20" r="1.5" />
      <circle cx="18" cy="20" r="1.5" />
      <path d="M2 3h3l2.7 11.5a2 2 0 0 0 2 1.5h8.2a2 2 0 0 0 2-1.5L22 7H6" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  camera: (
    <>
      <path d="M4 8h3l2-3h6l2 3h3v11H4z" />
      <circle cx="12" cy="13" r="3.5" />
    </>
  ),
  minus: <path d="M5 12h14" />
};

// ---------------------------------------------------------------------------
// Flags (drawn as SVG so they render the same on every device)
// ---------------------------------------------------------------------------
function Flag({ code }) {
  return (
    <svg className="flag" width="24" height="16" viewBox="0 0 36 24" aria-hidden="true">
      {code === 'et' && (
        <>
          <rect width="36" height="8" fill="#0072CE" />
          <rect y="8" width="36" height="8" fill="#000000" />
          <rect y="16" width="36" height="8" fill="#FFFFFF" />
        </>
      )}
      {code === 'ru' && (
        <>
          <rect width="36" height="8" fill="#FFFFFF" />
          <rect y="8" width="36" height="8" fill="#0039A6" />
          <rect y="16" width="36" height="8" fill="#D52B1E" />
        </>
      )}
      {code === 'en' && (
        <>
          <rect width="36" height="24" fill="#012169" />
          <path d="M0 0L36 24M36 0L0 24" stroke="#FFFFFF" strokeWidth="4.8" />
          <path d="M0 0L36 24M36 0L0 24" stroke="#C8102E" strokeWidth="2" />
          <path d="M18 0v24M0 12h36" stroke="#FFFFFF" strokeWidth="8" />
          <path d="M18 0v24M0 12h36" stroke="#C8102E" strokeWidth="4.8" />
        </>
      )}
    </svg>
  );
}

function useClickAway(ref, onAway) {
  useEffect(() => {
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onAway();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [ref, onAway]);
}

function LanguageMenu({ language, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useClickAway(ref, () => setOpen(false));
  const current = LANGUAGES.find((l) => l.code === language) || LANGUAGES[0];

  return (
    <div className="menu-wrap" ref={ref}>
      <button
        className="lang-button"
        onClick={() => setOpen(!open)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Language: ${current.label}`}
      >
        <Flag code={current.code} />
        <span className="lang-code">{current.code.toUpperCase()}</span>
        <Icon name="chevronDown" size={14} />
      </button>
      {open && (
        <ul className="menu-popover lang-popover" role="listbox">
          {LANGUAGES.map((l) => (
            <li key={l.code} role="option" aria-selected={l.code === language}>
              <button
                className={`menu-item ${l.code === language ? 'selected' : ''}`}
                onClick={() => {
                  onChange(l.code);
                  setOpen(false);
                }}
              >
                <Flag code={l.code} />
                <span>{l.label}</span>
                {l.code === language && <Icon name="check" size={16} />}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SettingsMenu({ theme, onToggleTheme, onOpenModal }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useClickAway(ref, () => setOpen(false));
  const dark = theme === 'dark';

  const choose = (name) => {
    setOpen(false);
    onOpenModal(name);
  };

  return (
    <div className="menu-wrap" ref={ref}>
      <button
        className="btn-icon"
        onClick={() => setOpen(!open)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Settings"
        aria-label="Settings"
      >
        <Icon name="settings" size={18} />
      </button>
      {open && (
        <div className="menu-popover settings-popover" role="menu">
          <div className="menu-row">
            <Icon name={dark ? 'moon' : 'sun'} size={18} />
            <div className="menu-row-text">
              <span>Dark mode</span>
              <small>{dark ? 'Dark theme is on' : 'Light theme is on'}</small>
            </div>
            <button
              className={`switch ${dark ? 'on' : ''}`}
              role="switch"
              aria-checked={dark}
              aria-label="Dark mode"
              onClick={onToggleTheme}
            >
              <span className="switch-knob" />
            </button>
          </div>
          <div className="menu-divider" />
          <button className="menu-item" role="menuitem" onClick={() => choose('profile')}>
            <Icon name="user" size={18} />
            <span>Update profile</span>
          </button>
          <button className="menu-item" role="menuitem" onClick={() => choose('install')}>
            <Icon name="mobile" size={18} />
            <span>Add to home screen</span>
          </button>
          <button className="menu-item" role="menuitem" onClick={() => choose('contact')}>
            <Icon name="mail" size={18} />
            <span>Contact admin</span>
          </button>
          <div className="menu-divider" />
          <button className="menu-item danger" role="menuitem" onClick={() => choose('close')}>
            <Icon name="alert" size={18} />
            <span>Close account</span>
          </button>
        </div>
      )}
    </div>
  );
}

function Modal({ title, onClose, children, wide }) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="modal-overlay"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="btn-icon" onClick={onClose} aria-label="Close">
            <Icon name="x" size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Sparkline({ values, tone = 'primary' }) {
  const W = 120;
  const H = 44;
  const pad = 5;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  const pts = values.map((v, i) => ({
    x: pad + (i * (W - 2 * pad)) / Math.max(values.length - 1, 1),
    y: span === 0 ? H / 2 : H - pad - ((v - min) / span) * (H - 2 * pad)
  }));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={`sparkline ${tone}`} aria-hidden="true">
      <path d={smoothPath(pts)} />
    </svg>
  );
}

function AreaChart({ points }) {
  const W = 720;
  const H = 240;
  const padL = 40;
  const padR = 16;
  const padT = 16;
  const padB = 34;
  const max = Math.max(...points.map((p) => p.value), 0);
  const top = Math.max(4, Math.ceil(max / 4) * 4);
  const x = (i) => padL + (i * (W - padL - padR)) / Math.max(points.length - 1, 1);
  const y = (v) => padT + (1 - v / top) * (H - padT - padB);
  const pts = points.map((p, i) => ({ x: x(i), y: y(p.value) }));
  const line = smoothPath(pts);
  const area = `${line} L${pts[pts.length - 1].x},${H - padB} L${pts[0].x},${H - padB} Z`;
  const step = points.length > 8 ? 2 : 1;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="area-chart" role="img" aria-label="Check-ins logged over time">
      <defs>
        <linearGradient id="areaFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" style={{ stopColor: 'var(--primary)', stopOpacity: 0.28 }} />
          <stop offset="100%" style={{ stopColor: 'var(--primary)', stopOpacity: 0 }} />
        </linearGradient>
      </defs>
      {[0, 1, 2, 3, 4].map((i) => {
        const v = (top / 4) * i;
        return (
          <g key={i}>
            <line x1={padL} x2={W - padR} y1={y(v)} y2={y(v)} className="chart-grid" />
            <text x={padL - 10} y={y(v) + 4} textAnchor="end" className="chart-label">{v}</text>
          </g>
        );
      })}
      <path d={area} fill="url(#areaFill)" />
      <path d={line} className="area-line" />
      {pts.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r="4" className="chart-dot">
          <title>{`${points[i].label}: ${points[i].value}`}</title>
        </circle>
      ))}
      {points.map((p, i) =>
        i % step === 0 ? (
          <text key={i} x={x(i)} y={H - 10} textAnchor="middle" className="chart-label">{p.label}</text>
        ) : null
      )}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Calendar, automated messages and client lifecycle
// ---------------------------------------------------------------------------
const INACTIVE_DAYS = 30;
const GOOGLE_CAL_SCOPE = 'https://www.googleapis.com/auth/calendar.events';

// Replace the urls with your own referral links when you have them
const PARTNERS = [
  { id: 'smartfood', name: 'SmartFOOD.ee', url: 'https://smartfood.ee' },
  { id: 'fitfood', name: 'FitFoodEstonia.ee', url: 'https://fitfoodestonia.ee' },
  { id: 'perfectprotein', name: 'PerfectProtein.ee', url: 'https://perfectprotein.ee' }
];

const CLIENT_VIEWS = [
  { id: 'overview', label: 'Overview', icon: 'grid' },
  { id: 'list', label: 'List', icon: 'list' },
  { id: 'segments', label: 'Segments', icon: 'segments' },
  { id: 'inactive', label: 'Inactive', icon: 'pause' },
  { id: 'completed', label: 'Completed', icon: 'trophy' }
];

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// ---- Date keys (YYYY-MM-DD in the coach's local time) ----
const toDateKey = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const parseDateKey = (key) => {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
};

const addDaysKey = (key, days) => {
  const d = parseDateKey(key);
  d.setDate(d.getDate() + days);
  return toDateKey(d);
};

// Next occurrence of a month/day on or after today (29 Feb falls back to 28 Feb)
const nextAnnualKey = (month, day) => {
  const today = startOfDay(new Date());
  const make = (year) => {
    let d = new Date(year, month - 1, day);
    if (d.getMonth() !== month - 1) d = new Date(year, month - 1, day - 1);
    return d;
  };
  let d = make(today.getFullYear());
  if (d.getTime() < today.getTime()) d = make(today.getFullYear() + 1);
  return toDateKey(d);
};

const nextBirthdayKey = (dob) => {
  const [, m, d] = dob.split('-').map(Number);
  return nextAnnualKey(m, d);
};

const nextChristmasKey = () => nextAnnualKey(12, 24);

const formatWhen = (dateKey, time) => {
  const day = parseDateKey(dateKey).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  return time ? `${day} at ${time}` : day;
};

const formatTime = (date) => (date ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');

const firstName = (name) => (name || '').trim().split(/\s+/)[0] || 'there';

// ---- Client decoration (shared by the dashboard and the handlers) ----
const getInactiveDays = (client, checkIns) => {
  if (getAccountStatus(client) === 'pending' || client.programmeStatus === 'completed') return null;
  const last = getLastCheckInDate(checkIns);
  const since = last || toDate(client.acceptedAt) || toDate(client.createdAt);
  if (!since) return null;
  const days = Math.floor((Date.now() - since.getTime()) / DAY_MS);
  return days >= INACTIVE_DAYS ? days : null;
};

const decorateClient = (c, clientData) => {
  const data = clientData[c.id] || { profile: null, checkIns: [], email: '' };
  return {
    ...c,
    email: data.email || c.email || '',
    dateOfBirth: data.profile?.dateOfBirth || c.dateOfBirth || null,
    accountStatus: getAccountStatus(c),
    profile: data.profile,
    checkIns: data.checkIns,
    lastCheckIn: getLastCheckInDate(data.checkIns),
    level: getActivityLevel(c, data.checkIns),
    stats: buildClientStats(data.profile, data.checkIns),
    inactiveDays: getInactiveDays(c, data.checkIns)
  };
};

// ---- Message templates (what you see in the preview is exactly what is sent) ----
const clientFooter = (coachName) =>
  `\n\n--\nYou are receiving this because your coach ${coachName} set it up for you in BodUp. ` +
  `If you would rather not get these messages, reply and ask ${firstName(coachName)} to switch them off.`;

const progressLines = (client) => {
  const st = client.stats;
  const lines = [];
  const n = client.checkIns.length;
  if (n > 0) {
    const latest = client.lastCheckIn ? `, the latest on ${formatDate(client.lastCheckIn)}` : '';
    lines.push(`You have logged ${n} weekly check-in${n === 1 ? '' : 's'} so far${latest}.`);
  } else {
    lines.push('I have not seen a weekly check-in from you yet - logging one gives us much more to work with.');
  }
  const start = client.profile?.weight;
  if (st.latestWeight != null && start != null && st.points.length) {
    const diff = st.latestWeight - start;
    if (Math.abs(diff) < 0.05) {
      lines.push(`Your weight has held steady at ${fmt(st.latestWeight, 1)} kg.`);
    } else {
      lines.push(
        `Your weight has moved from ${fmt(start, 1)} kg to ${fmt(st.latestWeight, 1)} kg ` +
          `(${diff < 0 ? 'down' : 'up'} ${fmt(Math.abs(diff), 1)} kg).`
      );
    }
  }
  if (st.toGo != null && st.target != null) {
    lines.push(
      Math.abs(st.toGo) <= 0.05
        ? 'You have reached your target weight.'
        : `Your target is ${fmt(st.target, 1)} kg, so ${fmt(Math.abs(st.toGo), 1)} kg to go.`
    );
  }
  if (st.avgWater != null) {
    lines.push(`You are averaging ${fmt(st.avgWater, 1)} L of water on the days you log it.`);
  }
  return lines;
};

const buildFeedbackEmail = ({ coachName, client, whenText, type, meetToken }) => {
  const cf = firstName(client.name);
  const coachF = firstName(coachName);
  const intro =
    type === 'meet'
      ? `It is time for our feedback session - we are meeting on ${whenText}.\n\nJoin me on Google Meet here: ${meetToken}`
      : 'It is time for our feedback session, and this time I am giving you my feedback by email.';
  const outro =
    type === 'meet'
      ? 'Have a think about what has gone well and where you want my help, and bring any questions along.'
      : 'If you would like to talk any of this through, just reply to this email and we will find a time.';
  const body =
    `Hey ${cf}, Coach ${coachF} here!\n\n${intro}\n\n` +
    `Here is a quick look at your progress so far:\n${progressLines(client).map((l) => `- ${l}`).join('\n')}\n\n` +
    `${outro}\n\nKeep it up - every logged day makes our conversations better.\n\nCoach ${coachF}` +
    clientFooter(coachName);
  return {
    subject: type === 'meet' ? `Our feedback session: ${whenText}` : `Your feedback from Coach ${coachF}`,
    body
  };
};

const buildCoachReminder = ({ coachName, client, whenText, type, meetToken }) => {
  const coachF = firstName(coachName);
  const how = type === 'meet' ? 'a Google Meet 1-on-1' : 'feedback by email';
  const meetLine = type === 'meet' ? `\nMeeting link: ${meetToken}\n` : '\n';
  return {
    subject: `Reminder: feedback for ${client.name} - ${whenText}`,
    body:
      `Hi ${coachF},\n\nThis is your reminder to give ${client.name} feedback (${how}) on ${whenText}.${meetLine}\n` +
      `Where ${firstName(client.name)} stands right now:\n${progressLines(client).map((l) => `- ${l}`).join('\n')}\n\n` +
      `Open BodUp and look at ${firstName(client.name)}'s page before you start.`
  };
};

const buildBirthdayEmail = ({ coachName, client }) => {
  const cf = firstName(client.name);
  const coachF = firstName(coachName);
  return {
    subject: `Happy birthday, ${cf}!`,
    body:
      `Hey ${cf}, Coach ${coachF} here!\n\nHappy birthday! Today is all about you, so enjoy it and celebrate in style. ` +
      `Thank you for the effort you put in - it has been great working with you.\n\n` +
      `Enjoy your day, and we will pick things up again tomorrow.\n\nCoach ${coachF}` +
      clientFooter(coachName)
  };
};

const buildChristmasEmail = ({ coachName, client }) => {
  const cf = firstName(client.name);
  const coachF = firstName(coachName);
  return {
    subject: `Merry Christmas, ${cf}!`,
    body:
      `Hey ${cf}, Coach ${coachF} here!\n\nWishing you a warm and relaxed Christmas with the people you love. ` +
      `Enjoy the good food and the time off - one holiday does not undo the progress you have made.\n\n` +
      `Thank you for your hard work this year. I am looking forward to what we do next.\n\nCoach ${coachF}` +
      clientFooter(coachName)
  };
};

const buildPartnerEmail = ({ coachName, client, partner }) => {
  const cf = firstName(client.name);
  const coachF = firstName(coachName);
  return {
    subject: `A tip from Coach ${coachF}: ${partner.name}`,
    body:
      `Hey ${cf}, Coach ${coachF} here!\n\nI work with ${partner.name} and thought it could make eating well easier ` +
      `when life gets busy. Have a look: ${partner.url}\n\n` +
      `There is no obligation at all - it is simply something I think can help you stay on track. ` +
      `If you have questions, reply to this email.\n\nCoach ${coachF}` +
      clientFooter(coachName)
  };
};

const describeEmailStatus = (mail) => {
  if (!mail) return 'Not scheduled';
  if (mail.status === 'sent') return `Sent ${formatDate(toDate(mail.sentAt))}`;
  if (mail.status === 'failed') return `Failed: ${mail.error || 'unknown error'}`;
  if (mail.status === 'cancelled') return 'Cancelled';
  if (mail.status === 'expired') return 'Expired before it could be sent';
  return `Scheduled for ${formatDate(parseDateKey(mail.sendOn))}`;
};

// ---- Month grid (weeks start on Monday) ----
const buildMonthGrid = (monthStart) => {
  const offset = (monthStart.getDay() + 6) % 7;
  const first = new Date(monthStart.getFullYear(), monthStart.getMonth(), 1 - offset);
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(first.getFullYear(), first.getMonth(), first.getDate() + i);
    return { date: d, key: toDateKey(d), inMonth: d.getMonth() === monthStart.getMonth() };
  });
};

// ---- Google Calendar (the access token comes from the coach's Google sign-in) ----
const createGoogleMeetEvent = async ({ token, summary, description, start, end, attendeeEmail }) => {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const res = await fetch(
    'https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1&sendUpdates=all',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        summary,
        description,
        start: { dateTime: start.toISOString(), timeZone },
        end: { dateTime: end.toISOString(), timeZone },
        attendees: attendeeEmail ? [{ email: attendeeEmail }] : [],
        conferenceData: {
          createRequest: {
            requestId: `cf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            conferenceSolutionKey: { type: 'hangoutsMeet' }
          }
        }
      })
    }
  );
  if (res.status === 401) throw new Error('GOOGLE_AUTH_EXPIRED');
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `Google Calendar error ${res.status}`);
  }
  const data = await res.json();
  const video = (data.conferenceData?.entryPoints || []).find((e) => e.entryPointType === 'video');
  return { eventId: data.id, meetLink: data.hangoutLink || video?.uri || '', htmlLink: data.htmlLink || '' };
};

const deleteGoogleEvent = async ({ token, eventId }) => {
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}?sendUpdates=all`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }
  );
  if (res.status === 401) throw new Error('GOOGLE_AUTH_EXPIRED');
  if (!res.ok && res.status !== 404 && res.status !== 410) throw new Error(`Google Calendar error ${res.status}`);
};

function EmailPreview({ from, to, replyTo, sendOn, subject, body }) {
  return (
    <div className="email-preview">
      <dl className="email-meta">
        <div><dt>From</dt><dd>{from}</dd></div>
        <div><dt>To</dt><dd>{to}</dd></div>
        {replyTo && <div><dt>Reply-to</dt><dd>{replyTo}</dd></div>}
        {sendOn && <div><dt>Sends</dt><dd>{sendOn}</dd></div>}
        <div><dt>Subject</dt><dd className="email-subject">{subject}</dd></div>
      </dl>
      <div className="email-body">{body}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Client portal: check-ins, profile fields, invite reminder, Learning
// ---------------------------------------------------------------------------
const GYMS = ['MyFitness', 'Gym!', 'Sparta', 'Reval-Sport', 'HC Gym', 'Lemon Gym', '24-7 Fitness'];

const CLIENT_NAV = [
  { id: 'dashboard', label: 'Dashboard', icon: 'dashboard' },
  { id: 'checkin', label: 'Check-in', icon: 'check' },
  { id: 'calendar', label: 'Calendar', icon: 'calendar' },
  { id: 'learning', label: 'Learning', icon: 'book' },
  { id: 'chat', label: 'Chat', icon: 'chat' }
];

// The moment a check-in was last worked on (days can now be saved one at a time)
const checkInDate = (ci) => toDate(ci.updatedAt) || toDate(ci.createdAt);

// Monday of the week containing the date, as YYYY-MM-DD
const getWeekKey = (date) => {
  const d = startOfDay(date);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return toDateKey(d);
};

const isoWeekNumber = (date) => {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d - yearStart) / DAY_MS + 1) / 7);
};

const blankDay = (day) => ({ day, weight: 0, meals: { breakfast: '', lunch: '', dinner: '', snacks: '' }, water: 0 });

// Combines already-saved days with newly saved ones (always 7 entries, Monday to Sunday)
const mergeDays = (existingDays, changes, savedAt) => {
  const days = Array.from({ length: 7 }, (_, i) => (existingDays || []).find((d) => d.day === i + 1) || blankDay(i + 1));
  changes.forEach((change) => {
    days[change.day - 1] = { ...change, savedAt };
  });
  return days;
};

const dayHasData = (d) =>
  !!d && (d.weight > 0 || d.water > 0 || Object.values(d.meals || {}).some((v) => v && String(v).trim()));

// Finds this week's check-in, including older check-ins saved before weeks were tracked
const findWeekDoc = (list, weekKey) =>
  list.find((ci) => ci.weekKey === weekKey) ||
  list.find((ci) => !ci.weekKey && toDate(ci.createdAt) && getWeekKey(toDate(ci.createdAt)) === weekKey) ||
  null;

// The calendar date a logged day belongs to
const dayDateOf = (ci, d) =>
  ci.weekKey ? parseDateKey(addDaysKey(ci.weekKey, (d.day || 1) - 1)) : checkInDate(ci);

const dayLabel = (ci, d) => (ci.weekKey ? WEEKDAYS[(d.day || 1) - 1] : `Day ${d.day}`);

const ageFromDob = (dob) => {
  if (!dob) return null;
  const birth = parseDateKey(dob);
  const now = new Date();
  let age = now.getFullYear() - birth.getFullYear();
  if (now.getMonth() < birth.getMonth() || (now.getMonth() === birth.getMonth() && now.getDate() < birth.getDate())) {
    age -= 1;
  }
  return age;
};

const buildInviteEmail = ({ coachName, clientName, code, appUrl }) => {
  const cf = firstName(clientName);
  const coachF = firstName(coachName);
  return {
    subject: `Coach ${coachF} is waiting for you on BodUp`,
    body:
      `Hey ${cf}, Coach ${coachF} here!\n\n` +
      `A little while ago I invited you to BodUp, where we will track your progress and keep our feedback sessions on schedule. ` +
      `It looks like you have not joined yet - it only takes a minute.\n\n` +
      `How to join:\n` +
      `1. Open ${appUrl}\n` +
      `2. Click "I have an invite code" and enter your code\n` +
      `3. Continue with Google and fill in your profile\n\n` +
      `Your invite code: ${code}\n\n` +
      `If anything is unclear, just reply to this email and I will help.\n\n` +
      `Coach ${coachF}\n\n--\n` +
      `You are receiving this because your coach ${coachName} invited you to BodUp.`
  };
};

// ---- Profile form fields (used on first sign-up and when editing) ----
function ProfileFields({ profile }) {
  const savedGym = profile?.gym || '';
  const initialChoice = profile?.gymChoice || (GYMS.includes(savedGym) ? savedGym : savedGym ? 'Other' : '');
  const [gymChoice, setGymChoice] = useState(initialChoice);
  const maxDob = (() => {
    const d = new Date();
    d.setFullYear(d.getFullYear() - 18);
    return toDateKey(d);
  })();

  return (
    <>
      <div className="form-row">
        <div className="form-group">
          <label>Date of birth</label>
          <input type="date" name="dateOfBirth" defaultValue={profile?.dateOfBirth || ''} max={maxDob} required />
        </div>
        <div className="form-group">
          <label>Sex</label>
          <select name="sex" defaultValue={profile?.sex || ''} required>
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

      <div className="form-group">
        <label>Activity Level</label>
        <select name="activityLevel" defaultValue={profile?.activityLevel || ''} required>
          <option value="">Select...</option>
          <option value="sedentary">Sedentary (little exercise)</option>
          <option value="light">Light (1-3 days/week)</option>
          <option value="moderate">Moderate (3-5 days/week)</option>
          <option value="active">Active (6-7 days/week)</option>
          <option value="very active">Very Active (twice a day)</option>
        </select>
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

      <div className="form-row">
        <div className="form-group">
          <label>Your gym (optional)</label>
          <select name="gym" value={gymChoice} onChange={(e) => setGymChoice(e.target.value)}>
            <option value="">Select your gym...</option>
            {GYMS.map((g) => (
              <option key={g} value={g}>{g}</option>
            ))}
            <option value="Other">Other</option>
          </select>
        </div>
        {gymChoice === 'Other' && (
          <div className="form-group">
            <label>Gym name</label>
            <input
              type="text"
              name="gymOther"
              defaultValue={initialChoice === 'Other' ? savedGym : ''}
              maxLength={60}
              placeholder="Type the name of your gym"
              required
            />
          </div>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Learning page
// ---------------------------------------------------------------------------
const SHOP_CATEGORIES = ['Protein', 'Carbs', 'Vegetables and fruit', 'Dairy and fats', 'Pantry and other'];

const SHOP_SUGGESTIONS = {
  Protein: ['Chicken breast', 'Eggs', 'Salmon', 'Lean mince', 'Tofu', 'Quark'],
  Carbs: ['Oats', 'Rice', 'Quinoa', 'Potatoes', 'Wholegrain bread', 'Sweet potatoes'],
  'Vegetables and fruit': ['Spinach', 'Broccoli', 'Peppers', 'Tomatoes', 'Berries', 'Bananas'],
  'Dairy and fats': ['Skyr', 'Greek yoghurt', 'Olive oil', 'Nuts', 'Avocado', 'Feta'],
  'Pantry and other': ['Canned beans', 'Canned tomatoes', 'Spices', 'Lemons', 'Garlic', 'Frozen veg']
};

const STARTER_LIST = [
  ['Protein', 'Chicken breast'],
  ['Protein', 'Eggs'],
  ['Carbs', 'Oats'],
  ['Carbs', 'Rice'],
  ['Vegetables and fruit', 'Mixed vegetables'],
  ['Vegetables and fruit', 'Berries'],
  ['Dairy and fats', 'Skyr'],
  ['Dairy and fats', 'Olive oil'],
  ['Pantry and other', 'Canned beans']
];

const BATCH_STEPS = [
  { title: 'Plan 3 to 4 meals', text: 'Pick two proteins, two carbs and three or four vegetables you like. Write the meals down before you shop so nothing is bought "just in case".' },
  { title: 'Shop with a list', text: 'Use the shopping list above, grouped by category, so one trip covers the whole week.' },
  { title: 'Start the slow things first', text: 'Put trays in the oven and grains on the hob first. While they cook, wash and chop vegetables and make sauces. Two hours on a quiet day is usually enough.' },
  { title: 'Cook in parallel', text: 'Roast vegetables and chicken on separate trays, cook rice or quinoa on the hob, and use the waiting time to assemble breakfasts such as overnight oats.' },
  { title: 'Cool quickly', text: 'Spread food in shallow containers so it cools fast. Aim to get it into the fridge or freezer within 2 hours of cooking.' },
  { title: 'Portion and label', text: 'Divide into single meals and write the date on each box or bag. Eat the fresh ones first and freeze the rest straight away.' },
  { title: 'Reheat until steaming hot', text: 'Heat food all the way through until it is steaming hot (about 75 degrees C). Only reheat leftovers once.' }
];

const FREEZES_WELL = [
  'Cooked chicken and other cooked meat',
  'Bolognese, chili, curries and meatballs',
  'Soups and stews',
  'Cooked beans and lentils',
  'Cooked rice and quinoa, in single portions',
  'Burger patties and marinated raw chicken',
  'Pancakes, muffins and protein oat bars',
  'Berries and peeled, sliced bananas',
  'Blanched vegetables such as broccoli and green beans'
];

const FREEZES_BADLY = [
  'Raw salad leaves, cucumber and radishes',
  'Raw tomatoes (fine for sauces, not for slicing)',
  'Boiled eggs (the white turns rubbery)',
  'Mayonnaise or cream-based sauces (they can separate)',
  'Potatoes inside soups and stews (they turn grainy)',
  'Crispy or fried foods (they lose their crunch)'
];

const FRIDGE_LIFE = [
  ['Cooked chicken, meat and mince dishes', '3 to 4 days'],
  ['Cooked fish and seafood', 'up to 2 days'],
  ['Soups, stews and chili', '3 to 4 days'],
  ['Cooked beans and lentils', '3 to 4 days'],
  ['Cooked rice (cool within 1 hour)', 'up to 1 day, or freeze'],
  ['Hard-boiled eggs in the shell', 'up to 7 days'],
  ['Overnight oats', 'up to 3 days'],
  ['Washed, cut raw vegetables', '3 to 5 days']
];

const BASE_INGREDIENTS = {
  chicken: {
    label: 'Chicken',
    prep: 'Roast or poach 1 kg of chicken breast or thighs with simple seasoning (salt, pepper, paprika, garlic). Slice or shred it and keep it plain so it can go in any direction.',
    meals: [
      { name: 'Burrito bowl', text: 'Chicken, rice, black beans, sweetcorn, salsa and a spoon of skyr instead of sour cream.' },
      { name: 'Chicken wrap', text: 'Shredded chicken, crunchy salad, cucumber and a Greek yoghurt and mustard dressing in a wholegrain wrap.' },
      { name: 'Chicken and vegetable soup', text: 'Simmer stock with carrots, celery, onion and lots of greens, then add the chicken at the end to warm through.' }
    ]
  },
  quinoa: {
    label: 'Quinoa',
    prep: 'Rinse 400 g of dry quinoa and cook it in twice the volume of water for about 15 minutes, then fluff and spread it out to cool fast. Portion and freeze what you will not eat within a day.',
    meals: [
      { name: 'Mediterranean bowl', text: 'Quinoa, chickpeas, cucumber, tomato, olives, feta and lemon with olive oil.' },
      { name: 'Breakfast porridge', text: 'Warm quinoa with milk, cinnamon and berries, topped with a spoon of nut butter.' },
      { name: 'Stuffed peppers', text: 'Quinoa mixed with tomato, beans and spices, baked inside halved peppers with a little cheese on top.' }
    ]
  }
};

const MYTHS = [
  {
    myth: 'No carbs after 6 PM',
    verdict: 'Myth',
    science:
      'Body weight follows your total intake over days and weeks, not the clock. When calories and food quality are the same, the time of day you eat carbohydrates has little independent effect for most people. Some people sleep better or train better with an evening carb source.',
    action:
      'Build dinner around protein, vegetables and a sensible portion of carbs. If late-evening snacking is the real habit, plan a satisfying dinner instead of banning a nutrient.'
  },
  {
    myth: 'All fats are bad',
    verdict: 'Myth',
    science:
      'Your body needs fat for hormones, for absorbing vitamins A, D, E and K, and for essential fatty acids. Swapping some saturated fat for unsaturated fat (olive and rapeseed oil, nuts, seeds, oily fish) is linked with better cholesterol levels. Industrially produced trans fats are the ones to avoid. Fat is also energy dense, so portions still matter.',
    action: 'Cook with olive or rapeseed oil, add a handful of nuts or a few slices of avocado, and eat fish a couple of times a week.'
  },
  {
    myth: 'Gluten-free is always healthier',
    verdict: 'Myth',
    science:
      'Gluten-free food is essential for people with coeliac disease or a diagnosed gluten problem. For everyone else it is not healthier by default. Many gluten-free breads, biscuits and snacks contain less fibre and more sugar or fat to make up for the texture, and they cost more.',
    action: 'Judge the product by its ingredients and fibre, not the label. Naturally gluten-free foods like potatoes, rice, vegetables, meat, fish and legumes are great.'
  },
  {
    myth: 'Eating small meals often speeds up your metabolism',
    verdict: 'Myth',
    science:
      'The energy your body uses to digest food depends on how much you eat in total, not on how many times you eat. Studies do not show a clear metabolic advantage of many small meals over fewer larger ones.',
    action: 'Choose the pattern that keeps you full and fits your day, whether that is three meals or five.'
  },
  {
    myth: 'Detox teas and juice cleanses flush out toxins',
    verdict: 'Myth',
    science:
      'Your liver and kidneys already do this job around the clock. Cleanses usually mean very little food, and the quick drop on the scale is mostly water and gut contents that come straight back.',
    action: 'Support your body with enough water, fibre-rich food, sleep and movement instead.'
  }
];

const SUBSTITUTIONS = [
  { type: 'Savoury', from: 'Creamy pasta sauce', to: 'Greek yoghurt or quark with parmesan, garlic and lemon zest', why: 'Creamy and tangy. Stir the yoghurt in off the heat so it does not split.' },
  { type: 'Savoury', from: 'Sour cream on tacos or soup', to: 'Skyr or Greek yoghurt with a squeeze of lime', why: 'Same cool, tangy bite with more protein.' },
  { type: 'Savoury', from: 'Mayo-heavy dressing or coleslaw', to: 'Greek yoghurt, mustard and lemon', why: 'Mustard and lemon bring the flavour that mayo usually carries.' },
  { type: 'Savoury', from: 'Mashed potatoes', to: 'Half potato, half cauliflower or celeriac, with olive oil and skyr', why: 'Still smooth and buttery, with more vegetables in every spoon.' },
  { type: 'Savoury', from: 'Burger and fries', to: 'Lean beef or turkey patty, wholegrain bun and oven wedges with smoked paprika', why: 'Smoky paprika and a good sauce keep it a proper burger night.' },
  { type: 'Savoury', from: 'White pasta', to: 'Wholegrain or chickpea pasta, or half pasta and half courgetti', why: 'More fibre and protein, and a rich sauce keeps it comforting.' },
  { type: 'Savoury', from: 'Takeaway pizza', to: 'Thin base, tomato sauce, plenty of vegetables, lean protein and a little strong cheese', why: 'A small amount of parmesan or chilli goes a long way.' },
  { type: 'Savoury', from: 'Fried chicken', to: 'Oven-baked chicken in crushed oats or cornflakes with spices', why: 'The crunchy coating is still there, without the deep fryer.' },
  { type: 'Sweet', from: 'Ice cream', to: 'Frozen banana and berries blended with yoghurt, or skyr with cocoa', why: 'Cold, creamy and sweet from the fruit.' },
  { type: 'Sweet', from: 'Chocolate brownie', to: 'Black bean or sweet potato brownie with dark chocolate', why: 'Beans and sweet potato make it fudgy, dark chocolate keeps it rich.' },
  { type: 'Sweet', from: 'Sugary cereal or granola', to: 'Plain oats or muesli with fruit, cinnamon and a little honey', why: 'You control the sweetness, and cinnamon makes it taste sweeter.' },
  { type: 'Sweet', from: 'Fruit-flavoured yoghurt', to: 'Plain skyr or yoghurt with fresh or frozen fruit', why: 'Real fruit tastes brighter than flavouring.' },
  { type: 'Snacks', from: 'Milk chocolate bar', to: 'A few squares of dark chocolate with nuts', why: 'Intense flavour means a small amount satisfies.' },
  { type: 'Snacks', from: 'Crisps', to: 'Air-popped popcorn or oven-roasted chickpeas with paprika', why: 'Crunchy and salty with more fibre.' }
];

const SUB_FILTERS = ['All', 'Savoury', 'Sweet', 'Snacks'];

const jumpTo = (id) => {
  const el = document.getElementById(id);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
};

function LearningPage() {
  const [items, setItems] = useState(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem('coachflow-shopping-list') || '[]');
      return Array.isArray(saved) ? saved : [];
    } catch (err) {
      return [];
    }
  });
  const [text, setText] = useState('');
  const [category, setCategory] = useState(SHOP_CATEGORIES[0]);
  const [copied, setCopied] = useState(false);
  const [base, setBase] = useState('chicken');
  const [subFilter, setSubFilter] = useState('All');

  useEffect(() => {
    try {
      window.localStorage.setItem('coachflow-shopping-list', JSON.stringify(items));
    } catch (err) {
      console.error('Could not save shopping list:', err);
    }
  }, [items]);

  const addItem = (name, cat) => {
    const clean = name.trim();
    if (!clean) return;
    setItems((prev) =>
      prev.some((i) => i.text.toLowerCase() === clean.toLowerCase())
        ? prev
        : [...prev, { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, text: clean, category: cat, done: false }]
    );
  };

  const handleAdd = (e) => {
    e.preventDefault();
    addItem(text, category);
    setText('');
  };

  const loadStarter = () => STARTER_LIST.forEach(([cat, name]) => addItem(name, cat));

  const buildNote = () => {
    const open = items.filter((i) => !i.done);
    const lines = ['Shopping list'];
    SHOP_CATEGORIES.forEach((cat) => {
      const group = open.filter((i) => i.category === cat);
      if (group.length) {
        lines.push('', cat);
        group.forEach((i) => lines.push(`[ ] ${i.text}`));
      }
    });
    return lines.join('\n');
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(buildNote());
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch (err) {
      console.error('Copy failed:', err);
    }
  };

  const baseData = BASE_INGREDIENTS[base];
  const subs = SUBSTITUTIONS.filter((s) => subFilter === 'All' || s.type === subFilter);
  const openCount = items.filter((i) => !i.done).length;

  return (
    <div className="learning-page">
      <div className="page-header">
        <h2>Learning</h2>
        <p>Short, practical guides from your coach to make eating well easier.</p>
      </div>

      <div className="learn-nav" role="navigation" aria-label="Learning topics">
        <button onClick={() => jumpTo('learn-shopping')}><Icon name="cart" size={16} /> Shopping list</button>
        <button onClick={() => jumpTo('learn-batch')}><Icon name="clock" size={16} /> Time-saving guide</button>
        <button onClick={() => jumpTo('learn-myths')}><Icon name="star" size={16} /> Myth buster</button>
        <button onClick={() => jumpTo('learn-swaps')}><Icon name="grid" size={16} /> Substitution chart</button>
      </div>

      {/* ---- Block 1: shopping list and template ---- */}
      <section className="section learn-block" id="learn-shopping">
        <div className="learn-head">
          <span className="learn-icon"><Icon name="cart" size={22} /></span>
          <div>
            <h3>Shopping List and Template</h3>
            <p className="section-subtitle section-subtitle-tight">A simple plan for the week, and a list you can copy to your phone.</p>
          </div>
        </div>

        <div className="template-grid">
          <div className="template-card">
            <strong>1. Plan</strong>
            <span>Choose 3 to 4 meals for the week and check what you already have.</span>
          </div>
          <div className="template-card">
            <strong>2. Build a plate</strong>
            <span>Each main meal: a palm of protein, a fist of carbs, two fists of vegetables and a thumb of fat.</span>
          </div>
          <div className="template-card">
            <strong>3. List by category</strong>
            <span>Group items by section of the shop so one pass covers everything.</span>
          </div>
        </div>

        <form className="shop-add" onSubmit={handleAdd}>
          <input
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Add an item, for example chicken breast"
            maxLength={60}
            aria-label="Shopping item"
          />
          <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category">
            {SHOP_CATEGORIES.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
          <button type="submit" className="btn-primary">Add</button>
        </form>

        <div className="shop-suggest">
          <span className="shop-suggest-label">Quick add to {category}:</span>
          {SHOP_SUGGESTIONS[category].map((s) => (
            <button key={s} type="button" className="chip" onClick={() => addItem(s, category)}>+ {s}</button>
          ))}
        </div>

        {items.length === 0 ? (
          <div className="empty-state">
            Your list is empty.
            <div><button className="btn-secondary" onClick={loadStarter}>Load a starter list</button></div>
          </div>
        ) : (
          <>
            <div className="shop-groups">
              {SHOP_CATEGORIES.map((cat) => {
                const group = items.filter((i) => i.category === cat);
                if (group.length === 0) return null;
                return (
                  <div key={cat} className="shop-group">
                    <h4>{cat}</h4>
                    <ul>
                      {group.map((i) => (
                        <li key={i.id} className={i.done ? 'done' : ''}>
                          <label>
                            <input
                              type="checkbox"
                              checked={i.done}
                              onChange={() =>
                                setItems((prev) => prev.map((p) => (p.id === i.id ? { ...p, done: !p.done } : p)))
                              }
                            />
                            <span>{i.text}</span>
                          </label>
                          <button
                            type="button"
                            className="shop-remove"
                            aria-label={`Remove ${i.text}`}
                            onClick={() => setItems((prev) => prev.filter((p) => p.id !== i.id))}
                          >
                            <Icon name="x" size={14} />
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}
            </div>

            <div className="shop-actions">
              <button className="btn-primary" onClick={handleCopy} disabled={openCount === 0}>
                {copied ? 'Copied - paste it into your notes' : 'Copy to phone notes'}
              </button>
              <button className="btn-secondary" onClick={() => setItems((prev) => prev.filter((p) => !p.done))}>
                Clear ticked items
              </button>
              <button
                className="btn-secondary"
                onClick={() => {
                  if (window.confirm('Clear the whole list?')) setItems([]);
                }}
              >
                Clear all
              </button>
            </div>
            <p className="field-hint">{openCount} item{openCount === 1 ? '' : 's'} left to buy. Your list is saved on this device.</p>
          </>
        )}
      </section>

      {/* ---- Block 2: batch cooking ---- */}
      <section className="section learn-block" id="learn-batch">
        <div className="learn-head">
          <span className="learn-icon"><Icon name="clock" size={22} /></span>
          <div>
            <h3>Time-Saving Guide: batch cooking</h3>
            <p className="section-subtitle section-subtitle-tight">Cook once, eat well for days. A typical session takes about two hours.</p>
          </div>
        </div>

        <ol className="step-list">
          {BATCH_STEPS.map((s, i) => (
            <li key={s.title}>
              <span className="step-num">{i + 1}</span>
              <div>
                <strong>{s.title}</strong>
                <p>{s.text}</p>
              </div>
            </li>
          ))}
        </ol>

        <h4 className="learn-sub">What freezes well, and what does not</h4>
        <div className="two-col">
          <div className="list-card good">
            <strong>Freezes well</strong>
            <ul>{FREEZES_WELL.map((f) => <li key={f}>{f}</li>)}</ul>
          </div>
          <div className="list-card bad">
            <strong>Better not to freeze</strong>
            <ul>{FREEZES_BADLY.map((f) => <li key={f}>{f}</li>)}</ul>
          </div>
        </div>

        <h4 className="learn-sub">How long things keep in the fridge</h4>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr><th>Food</th><th>Keeps for</th></tr>
            </thead>
            <tbody>
              {FRIDGE_LIFE.map(([food, life]) => (
                <tr key={food}><td>{food}</td><td>{life}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="field-hint">
          Keep your fridge at 5 degrees C or colder. Most cooked meals keep for 3 to 4 days in the fridge and about 2 to 3
          months in the freezer at good quality. Thaw in the fridge, not on the counter. When in doubt, throw it out.
        </p>

        <h4 className="learn-sub">One base, three meals</h4>
        <div className="seg">
          {Object.entries(BASE_INGREDIENTS).map(([key, b]) => (
            <button key={key} className={`seg-btn ${base === key ? 'active' : ''}`} onClick={() => setBase(key)}>
              <span>{b.label}</span>
            </button>
          ))}
        </div>
        <p className="base-prep"><strong>Base:</strong> {baseData.prep}</p>
        <div className="meal-grid">
          {baseData.meals.map((m, i) => (
            <div key={m.name} className="meal-card">
              <span className="meal-num">Meal {i + 1}</span>
              <strong>{m.name}</strong>
              <p>{m.text}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ---- Block 3: myth buster ---- */}
      <section className="section learn-block" id="learn-myths">
        <div className="learn-head">
          <span className="learn-icon"><Icon name="star" size={22} /></span>
          <div>
            <h3>Myth Buster</h3>
            <p className="section-subtitle section-subtitle-tight">What the evidence says about advice you hear all the time.</p>
          </div>
        </div>
        <div className="myth-list">
          {MYTHS.map((m) => (
            <article key={m.myth} className="myth-card">
              <div className="myth-top">
                <span className="myth-tag">{m.verdict}</span>
                <h4>"{m.myth}"</h4>
              </div>
              <p><strong>What the science says.</strong> {m.science}</p>
              <p className="myth-action"><strong>What to do instead.</strong> {m.action}</p>
            </article>
          ))}
        </div>
        <p className="field-hint">
          General education, not medical advice. If you have a medical condition or special dietary needs, talk to your doctor or a dietitian.
        </p>
      </section>

      {/* ---- Block 4: substitution chart ---- */}
      <section className="section learn-block" id="learn-swaps">
        <div className="learn-head">
          <span className="learn-icon"><Icon name="grid" size={22} /></span>
          <div>
            <h3>The Substitution Chart</h3>
            <p className="section-subtitle section-subtitle-tight">Upgrade your comfort food without losing the flavour.</p>
          </div>
        </div>
        <div className="chip-row">
          {SUB_FILTERS.map((f) => (
            <button key={f} className={`chip ${subFilter === f ? 'active' : ''}`} onClick={() => setSubFilter(f)}>{f}</button>
          ))}
        </div>
        <div className="swap-table">
          <div className="swap-row swap-head">
            <span>Comfort favourite</span>
            <span />
            <span>Smart upgrade</span>
            <span>Why it still tastes great</span>
          </div>
          {subs.map((s) => (
            <div key={s.from} className="swap-row">
              <span className="swap-from">{s.from}</span>
              <span className="swap-arrow" aria-hidden="true"><Icon name="expand" size={18} /></span>
              <span className="swap-to">{s.to}</span>
              <span className="swap-why">{s.why}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Admin area (the server decides who is an admin, see api/admin.js)
// ---------------------------------------------------------------------------
const adminCall = async (action, payload = {}) => {
  const current = auth.currentUser;
  if (!current) throw new Error('Please sign in again.');
  const token = await current.getIdToken();
  const res = await fetch('/api/admin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ action, ...payload })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
};

// Asks the server whether this signed-in person is the admin. Any failure means "no".
const checkIsAdmin = async () => {
  try {
    const data = await adminCall('whoami');
    return data.admin === true;
  } catch (err) {
    return false;
  }
};

const ADMIN_NAV = [
  { id: 'overview', label: 'Overview', icon: 'dashboard', action: 'overview' },
  { id: 'customers', label: 'Customers', icon: 'users', action: 'customers' },
  { id: 'users', label: 'Accounts', icon: 'shield', action: 'users' },
  { id: 'inbox', label: 'Inbox', icon: 'mail', action: 'messages' },
  { id: 'chat', label: 'Chat', icon: 'chat', action: 'chatList' },
  { id: 'coupons', label: 'Coupons', icon: 'tag', action: 'couponsList' },
  { id: 'pricing', label: 'Pricing', icon: 'card', action: 'plansGet' },
  { id: 'partners', label: 'Partners', icon: 'link', action: 'partnersGet' },
  { id: 'visits', label: 'Visits', icon: 'globe', action: 'visitsStats' },
  { id: 'site', label: 'Site and seasons', icon: 'palette', action: 'siteGet' },
  { id: 'admins', label: 'Admins', icon: 'shield', action: 'adminsList' },
  { id: 'billing', label: 'Billing', icon: 'card', action: 'billing' },
  { id: 'emails', label: 'Email log', icon: 'clock', action: 'emailLog' }
];

const MAIL_KIND_LABEL = {
  feedback: 'Feedback',
  'coach-reminder': 'Coach reminder',
  birthday: 'Birthday',
  christmas: 'Christmas',
  partner: 'Partner intro'
};

const adminDate = (value) => (value ? formatDate(new Date(value)) : '-');

function AdminPanel({ user, theme, onToggleTheme, onSignOut, embedded = false }) {
  const [page, setPage] = useState('overview');
  const [collapsed, setCollapsed] = useState(() => window.innerWidth < 768);
  const [cache, setCache] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState(null);
  const [msgFilter, setMsgFilter] = useState('new');
  const [userQuery, setUserQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState('all');
  const [mailFilter, setMailFilter] = useState('all');

  const load = async (target) => {
    const entry = ADMIN_NAV.find((n) => n.id === target);
    setLoading(true);
    setError('');
    try {
      const data = await adminCall(entry.action);
      setCache((prev) => ({ ...prev, [target]: { ...data, fetchedAt: Date.now() } }));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setNotice(null);
    load(page);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  const act = async (action, payload, okText) => {
    try {
      setLoading(true);
      await adminCall(action, payload);
      setNotice({ type: 'success', text: okText });
      await load(page);
    } catch (err) {
      setNotice({ type: 'error', text: err.message });
      setLoading(false);
    }
  };

  const changeStatus = (u, status, verb) => {
    if (!window.confirm(`${verb} ${u.displayName || u.email}?`)) return;
    act('setUserStatus', { uid: u.uid, status }, `${u.displayName || u.email}: ${verb.toLowerCase()} done.`);
  };

  const data = cache[page];
  const adminName = user.displayName || user.email;

  const messagesList = data && page === 'inbox' ? data.messages : [];
  const shownMessages = messagesList.filter((m) => msgFilter === 'all' || m.status === msgFilter);

  const usersList = data && page === 'users' ? data.users : [];
  const needle = userQuery.trim().toLowerCase();
  const shownUsers = usersList.filter(
    (u) =>
      (roleFilter === 'all' || u.role === roleFilter) &&
      (!needle || `${u.displayName} ${u.email}`.toLowerCase().includes(needle))
  );

  const mailList = data && page === 'emails' ? data.emails : [];
  const shownMail = mailList.filter((m) => mailFilter === 'all' || m.status === mailFilter);

  return (
    <div className={embedded ? 'admin-embed' : `dashboard-container ${collapsed ? 'collapsed' : ''}`}>
      {!embedded && <aside className="sidebar">
        <div className="sidebar-header">
          {!collapsed && <h1><BrandMark size={30} /></h1>}
          <button
            className="sidebar-toggle"
            onClick={() => setCollapsed(!collapsed)}
            aria-label={collapsed ? 'Expand menu' : 'Collapse menu'}
            title={collapsed ? 'Expand menu' : 'Collapse menu'}
          >
            <Icon name={collapsed ? 'expand' : 'collapse'} />
          </button>
        </div>

        <div className="coach-chip" title={adminName}>
          <span className="client-avatar coach-avatar">{initialOf(adminName)}</span>
          <span className="nav-label coach-chip-text">
            <span className="coach-chip-name">{adminName}</span>
            <span className="coach-chip-role">Administrator</span>
          </span>
        </div>

        <nav className="sidebar-nav">
          {ADMIN_NAV.map((item) => (
            <button
              key={item.id}
              className={`nav-item ${page === item.id ? 'active' : ''}`}
              onClick={() => setPage(item.id)}
              title={item.label}
            >
              <Icon name={item.icon} />
              <span className="nav-label">{item.label}</span>
            </button>
          ))}
        </nav>

        <div className="sidebar-footer">
          <button className="nav-item logout" onClick={onSignOut} title="Log out">
            <Icon name="logout" />
            <span className="nav-label">Log out</span>
          </button>
        </div>
      </aside>}

      <div className={embedded ? 'admin-embed-body' : 'workspace'}>
        {!embedded && <header className="topbar">
          <div className="topbar-left" />
          <nav className="topnav" aria-label="Admin">
            {ADMIN_NAV.map((item) => (
              <button
                key={item.id}
                className={`topnav-item ${page === item.id ? 'active' : ''}`}
                onClick={() => setPage(item.id)}
              >
                <Icon name={item.icon} size={18} />
                <span className="topnav-label">{item.label}</span>
              </button>
            ))}
          </nav>
          <div className="topbar-right">
            <button className="btn-icon" onClick={() => load(page)} disabled={loading} title="Reload" aria-label="Reload">
              <Icon name="refresh" size={18} />
            </button>
            <button
              className="btn-icon"
              onClick={onToggleTheme}
              aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
              title={theme === 'dark' ? 'Light mode' : 'Dark mode'}
            >
              <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={18} />
            </button>
          </div>
        </header>}

        {embedded && (
          <nav className="admin-tabs" aria-label="Admin sections">
            {ADMIN_NAV.map((item) => (
              <button key={item.id} className={`admin-tab ${page === item.id ? 'active' : ''}`} onClick={() => setPage(item.id)}>
                <Icon name={item.icon} size={16} />
                <span>{item.label}</span>
              </button>
            ))}
          </nav>
        )}
        <main className={embedded ? 'admin-embed-main' : 'main-content'}>
          {notice && <p className={`form-message ${notice.type}`}>{notice.text}</p>}
          {error && <p className="form-message error">{error}</p>}
          {loading && !data && <p className="empty-state">Loading...</p>}

          {page === 'overview' && data && (
            <div className="dashboard-view">
              <div className="page-header">
                <h2>Overview</h2>
                <p>How BodUp is doing right now.</p>
              </div>
              <div className="stats-grid">
                <div className="stat-card"><div className="stat-value">{data.coaches}</div><div className="stat-label">Coaches</div></div>
                <div className="stat-card"><div className="stat-value">{data.clientAccounts}</div><div className="stat-label">Client accounts</div></div>
                <div className="stat-card"><div className="stat-value">{data.joinedClients}</div><div className="stat-label">Clients linked to a coach</div></div>
                <div className="stat-card"><div className="stat-value">{data.pendingInvites}</div><div className="stat-label">Pending invites</div></div>
                <div className="stat-card"><div className="stat-value">{data.signUpsLast30Days}</div><div className="stat-label">Sign-ups, last 30 days</div></div>
                <div className="stat-card"><div className="stat-value">{data.suspendedCoaches}</div><div className="stat-label">Suspended coaches</div></div>
                <div className="stat-card"><div className="stat-value">{data.closedAccounts}</div><div className="stat-label">Closed accounts</div></div>
              </div>

              <div className="two-col">
                <button className="section attention-card" onClick={() => setPage('inbox')}>
                  <span className={`attention-count ${data.newMessages > 0 ? 'alert' : ''}`}>{data.newMessages}</span>
                  <span>
                    <strong>New messages</strong>
                    <small>People who used Contact admin</small>
                  </span>
                </button>
                <button className="section attention-card" onClick={() => setPage('emails')}>
                  <span className={`attention-count ${data.failedEmails > 0 ? 'alert' : ''}`}>{data.failedEmails}</span>
                  <span>
                    <strong>Failed emails</strong>
                    <small>{data.scheduledEmails} more are waiting to be sent</small>
                  </span>
                </button>
              </div>
            </div>
          )}

          {page === 'inbox' && data && (
            <div className="dashboard-view">
              <div className="page-header page-header-row">
                <div>
                  <h2>Inbox</h2>
                  <p>Messages from coaches and clients.</p>
                </div>
                <div className="chip-row">
                  {[
                    ['new', 'New'],
                    ['handled', 'Handled'],
                    ['all', 'All']
                  ].map(([id, label]) => (
                    <button key={id} className={`chip ${msgFilter === id ? 'active' : ''}`} onClick={() => setMsgFilter(id)}>
                      {label}
                      {id !== 'all' && ` (${messagesList.filter((m) => m.status === id).length})`}
                    </button>
                  ))}
                </div>
              </div>

              {shownMessages.length === 0 ? (
                <section className="section"><p className="empty-state">No messages here.</p></section>
              ) : (
                <div className="msg-list">
                  {shownMessages.map((m) => (
                    <article key={m.id} className={`msg-card ${m.status}`}>
                      <div className="msg-top">
                        <h4>{m.subject || '(no subject)'}</h4>
                        <span className={`status-pill ${m.status === 'new' ? 'scheduled' : 'sent'}`}>{m.status}</span>
                      </div>
                      <p className="msg-meta">
                        {m.name || 'Unknown'} ({m.role}) - {m.email} - {adminDate(m.createdAt)}
                      </p>
                      <p className="msg-body">{m.message}</p>
                      <div className="msg-actions">
                        <a
                          className="btn-secondary btn-small btn-link"
                          href={`mailto:${m.email}?subject=${encodeURIComponent(`Re: ${m.subject}`)}`}
                        >
                          Reply by email
                        </a>
                        <button
                          className="btn-secondary btn-small"
                          disabled={loading}
                          onClick={() =>
                            act('setMessageStatus', { id: m.id, status: m.status === 'new' ? 'handled' : 'new' }, 'Message updated.')
                          }
                        >
                          {m.status === 'new' ? 'Mark as handled' : 'Reopen'}
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </div>
          )}

          {page === 'users' && data && (
            <div className="dashboard-view">
              <div className="page-header page-header-row">
                <div>
                  <h2>Users</h2>
                  <p>{usersList.length} accounts. Close or suspend access here.</p>
                </div>
                <div className="admin-toolbar">
                  <input
                    className="admin-search"
                    type="search"
                    placeholder="Search name or email"
                    value={userQuery}
                    onChange={(e) => setUserQuery(e.target.value)}
                    aria-label="Search users"
                  />
                  <div className="chip-row">
                    {['all', 'coach', 'client'].map((r) => (
                      <button key={r} className={`chip ${roleFilter === r ? 'active' : ''}`} onClick={() => setRoleFilter(r)}>
                        {r === 'all' ? 'All' : r === 'coach' ? 'Coaches' : 'Clients'}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <section className="section">
                {shownUsers.length === 0 ? (
                  <p className="empty-state">No users match.</p>
                ) : (
                  <div className="table-scroll">
                    <table className="data-table admin-table">
                      <thead>
                        <tr>
                          <th>User</th>
                          <th>Role</th>
                          <th>Details</th>
                          <th>Joined</th>
                          <th>Status</th>
                          <th>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {shownUsers.map((u) => (
                          <tr key={u.uid}>
                            <td>
                              <strong>{u.displayName || '-'}</strong>
                              <div className="cell-sub">{u.email}</div>
                            </td>
                            <td className="capitalize">{u.role}</td>
                            <td>
                              {u.role === 'coach'
                                ? `${u.clientCount} clients${u.plan ? `, ${u.plan}` : ''}`
                                : u.coachName
                                ? `Coach: ${u.coachName}`
                                : '-'}
                            </td>
                            <td>{adminDate(u.createdAt)}</td>
                            <td><span className={`status-pill ${u.status}`}>{u.status}</span></td>
                            <td>
                              <div className="row-actions">
                                {u.role !== 'admin' && (
                                  <button
                                    className="btn-secondary btn-small"
                                    disabled={loading}
                                    onClick={() =>
                                      act(
                                        'setAdminForUser',
                                        { uid: u.uid, admin: !u.isAdmin },
                                        u.isAdmin ? 'Admin rights removed.' : `${u.displayName || u.email} is now an admin.`
                                      )
                                    }
                                  >
                                    {u.isAdmin ? 'Remove admin' : 'Make admin'}
                                  </button>
                                )}
                                {u.status === 'active' && u.role === 'coach' && (
                                  <button className="btn-secondary btn-small" disabled={loading} onClick={() => changeStatus(u, 'suspended', 'Suspend')}>
                                    Suspend
                                  </button>
                                )}
                                {u.status === 'suspended' && (
                                  <button className="btn-secondary btn-small" disabled={loading} onClick={() => changeStatus(u, 'active', 'Reactivate')}>
                                    Reactivate
                                  </button>
                                )}
                                {u.status !== 'closed' && (
                                  <button className="btn-danger btn-small" disabled={loading} onClick={() => changeStatus(u, 'closed', 'Close')}>
                                    Close
                                  </button>
                                )}
                                {u.status === 'closed' && (
                                  <button className="btn-secondary btn-small" disabled={loading} onClick={() => changeStatus(u, 'active', 'Reopen')}>
                                    Reopen
                                  </button>
                                )}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
              <p className="field-hint">
                Suspended coaches can sign in and contact you, but cannot use the app, and their automated emails wait.
                Closed accounts cannot sign in at all.
              </p>
            </div>
          )}

          {page === 'emails' && data && (
            <div className="dashboard-view">
              <div className="page-header page-header-row">
                <div>
                  <h2>Email log</h2>
                  <p>Every email BodUp has scheduled or sent (latest 300).</p>
                </div>
                <div className="chip-row">
                  {['all', 'scheduled', 'sent', 'failed', 'expired', 'cancelled'].map((s) => (
                    <button key={s} className={`chip ${mailFilter === s ? 'active' : ''}`} onClick={() => setMailFilter(s)}>
                      {s === 'all' ? 'All' : s[0].toUpperCase() + s.slice(1)}
                      {s !== 'all' && ` (${mailList.filter((m) => m.status === s).length})`}
                    </button>
                  ))}
                </div>
              </div>

              <section className="section">
                {shownMail.length === 0 ? (
                  <p className="empty-state">No emails in this view.</p>
                ) : (
                  <div className="table-scroll">
                    <table className="data-table admin-table">
                      <thead>
                        <tr>
                          <th>Send date</th>
                          <th>Type</th>
                          <th>Coach</th>
                          <th>To</th>
                          <th>Subject</th>
                          <th>Status</th>
                          <th>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {shownMail.map((m) => (
                          <tr key={m.id}>
                            <td>{m.sendOn || '-'}</td>
                            <td>{MAIL_KIND_LABEL[m.kind] || m.kind}</td>
                            <td>{m.coachName || '-'}</td>
                            <td>{m.to || '-'}</td>
                            <td className="cell-wide">{m.subject}</td>
                            <td>
                              <span className={`status-pill ${m.status}`}>{m.status}</span>
                              {m.error && <div className="cell-sub error-text">{m.error}</div>}
                              {m.sentAt && <div className="cell-sub">{adminDate(m.sentAt)}</div>}
                            </td>
                            <td>
                              <div className="row-actions">
                                {(m.status === 'failed' || m.status === 'expired') && (
                                  <button
                                    className="btn-secondary btn-small"
                                    disabled={loading}
                                    onClick={() => act('retryEmail', { id: m.id }, 'Email will be sent in the next daily run.')}
                                  >
                                    Retry
                                  </button>
                                )}
                                {m.status === 'scheduled' && (
                                  <button
                                    className="btn-secondary btn-small"
                                    disabled={loading}
                                    onClick={() => act('cancelEmail', { id: m.id }, 'Email cancelled.')}
                                  >
                                    Cancel
                                  </button>
                                )}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            </div>
          )}

          {page === 'customers' && data && <CustomersPage data={data} />}
          {page === 'coupons' && data && <CouponsPage data={data} act={act} loading={loading} />}
          {page === 'pricing' && data && <PricingPage key={data.fetchedAt} data={data} act={act} loading={loading} />}
          {page === 'partners' && data && <PartnersPage key={data.fetchedAt} data={data} act={act} loading={loading} />}
          {page === 'visits' && data && <VisitsPage data={data} />}
          {page === 'site' && data && <SitePage key={data.fetchedAt} data={data} act={act} loading={loading} />}
          {page === 'admins' && data && <AdminsPage data={data} act={act} loading={loading} />}
          {page === 'chat' && data && <ChatAdminPage key={data.fetchedAt} data={data} loading={loading} />}
          {page === 'billing' && data && (
            <div className="dashboard-view">
              <div className="page-header">
                <h2>Billing</h2>
                <p>Plans and invoices across all coaches.</p>
              </div>
              <div className="notice-banner">
                <Icon name="alert" size={18} />
                <span>Demo mode. These figures come from demo subscriptions and invoices, not real payments.</span>
              </div>

              <div className="stats-grid">
                <div className="stat-card"><div className="stat-value">{formatMoney(data.totals.monthlyRecurring)}</div><div className="stat-label">Monthly recurring</div></div>
                <div className="stat-card"><div className="stat-value">{formatMoney(data.totals.invoicedThisMonth)}</div><div className="stat-label">Invoiced this month</div></div>
                <div className="stat-card"><div className="stat-value">{formatMoney(data.totals.invoicedAllTime)}</div><div className="stat-label">Invoiced, all time</div></div>
                <div className="stat-card"><div className="stat-value">{data.totals.payingCoaches}</div><div className="stat-label">Paying coaches</div></div>
                <div className="stat-card"><div className="stat-value">{data.totals.coachesWithoutPlan}</div><div className="stat-label">Coaches without a plan</div></div>
              </div>

              <section className="section">
                <h3>Subscriptions</h3>
                {data.subscriptions.length === 0 ? (
                  <p className="empty-state">No subscriptions yet.</p>
                ) : (
                  <div className="table-scroll">
                    <table className="data-table admin-table">
                      <thead>
                        <tr><th>Coach</th><th>Plan</th><th>Price</th><th>Status</th><th>Next payment</th></tr>
                      </thead>
                      <tbody>
                        {data.subscriptions.map((s) => (
                          <tr key={s.coachId}>
                            <td><strong>{s.coachName}</strong><div className="cell-sub">{s.email}</div></td>
                            <td>{s.planName}</td>
                            <td>{s.price === 0 ? 'Free' : formatMoney(s.price, s.currency)}</td>
                            <td><span className={`status-pill ${s.status === 'active' ? 'active' : 'closed'}`}>{s.status}</span></td>
                            <td>{adminDate(s.nextBillingDate)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              <section className="section">
                <h3>Latest invoices</h3>
                {data.invoices.length === 0 ? (
                  <p className="empty-state">No invoices yet.</p>
                ) : (
                  <div className="table-scroll">
                    <table className="data-table admin-table">
                      <thead>
                        <tr><th>Invoice</th><th>Date</th><th>Coach</th><th>Plan</th><th>Amount</th><th>Method</th><th>Status</th></tr>
                      </thead>
                      <tbody>
                        {data.invoices.map((inv) => (
                          <tr key={inv.id}>
                            <td>{inv.invoiceNumber}</td>
                            <td>{adminDate(inv.createdAt)}</td>
                            <td>{inv.coachName}</td>
                            <td>{inv.planName}</td>
                            <td>{formatMoney(inv.amount, inv.currency)}</td>
                            <td>{inv.methodLabel}</td>
                            <td>
                              <span className="status-pill active">{inv.status}</span>
                              {inv.mode === 'demo' && <span className="demo-tag">demo</span>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

// Shown to a coach whose account has been suspended by the admin
function SuspendedPage({ user, onSignOut, onSend, message, loading }) {
  return (
    <div className="login-container">
      <div className="login-card suspended-card">
        <h1>Account suspended</h1>
        <p className="subtitle">
          Your BodUp account is suspended for now. Your clients and their data are kept safe. Write to the admin to sort it out.
        </p>
        <form className="form" onSubmit={onSend}>
          <div className="form-group">
            <label>Subject</label>
            <input type="text" name="subject" defaultValue="My suspended account" required />
          </div>
          <div className="form-group">
            <label>Message</label>
            <textarea name="message" rows="4" required />
          </div>
          {message && <p className={`form-message ${message.type}`}>{message.text}</p>}
          <button type="submit" className="btn-primary" disabled={loading}>
            {loading ? 'Sending...' : 'Contact admin'}
          </button>
        </form>
        <p className="suspended-signed-in">Signed in as {user.email}</p>
        <button className="btn-secondary" onClick={onSignOut}>Log out</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// BodUp brand and public landing page (shown before anyone signs in)
// ---------------------------------------------------------------------------
function BrandMark({ size = 30, showText = true, className = '' }) {
  return (
    <span className={`brand-mark ${className}`}>
      <img src="/bodup-mark.png" alt="" height={size} style={{ height: size, width: 'auto' }} />
      {showText && <span className="brand-name">BodUp</span>}
    </span>
  );
}

const LANDING_SOLUTIONS = [
  {
    icon: 'users',
    title: 'For coaches',
    text: 'See every client at a glance, from who needs attention today to who has reached their goal. Run feedback sessions and reminders from one calendar.',
    points: ['Client activity overview', 'Feedback sessions with Google Meet or email', 'Invite clients with a single code']
  },
  {
    icon: 'check',
    title: 'For clients',
    text: 'A simple place to log each day, keep your profile up to date and see your coach\u2019s sessions. Logging a single day is enough to stay on track.',
    points: ['Day-by-day or whole-week check-ins', 'Your progress and weight trend', 'Learning library and shopping lists']
  },
  {
    icon: 'gift',
    title: 'For a healthy routine',
    text: 'Keep the habits going between sessions with friendly messages and practical guides, sent only to clients who have chosen to receive them.',
    points: ['Birthday and Christmas wishes', 'Batch-cooking and substitution guides', 'Myth-busting, science-backed tips']
  }
];

const LANDING_FEATURES = [
  { icon: 'dashboard', title: 'Client activity at a glance', text: 'Green, yellow and red groups show who is on track and who needs a message today.' },
  { icon: 'check', title: 'Weekly check-ins', text: 'Clients log weight, meals and water for one day or the whole week, and see their progress.' },
  { icon: 'calendar', title: 'Calendar and sessions', text: 'Schedule a Google Meet 1-on-1 or an email feedback. Reminders go to your inbox ahead of time.' },
  { icon: 'mail', title: 'Automated messages', text: 'Preview every email before it goes out. Birthday and Christmas messages are switched on per client with consent.' },
  { icon: 'book', title: 'Learning library', text: 'A shopping list, a batch-cooking guide, a myth buster and a healthier substitution chart.' },
  { icon: 'trophy', title: 'Programme tracking', text: 'Mark programmes as completed, see inactive clients, and reopen them whenever you need.' }
];

function LandingPage({ language, onLanguage, onLogin, onRegister, plans }) {
  const scrollTo = (id) => (e) => {
    e.preventDefault();
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className="landing">
      <header className="landing-nav">
        <a href="#top" className="landing-brand" onClick={scrollTo('top')} aria-label="BodUp home">
          <BrandMark size={34} />
        </a>
        <nav className="landing-links" aria-label="Page sections">
          <a href="#solutions" onClick={scrollTo('solutions')}>Solutions</a>
          <a href="#features" onClick={scrollTo('features')}>Features</a>
          <a href="#pricing" onClick={scrollTo('pricing')}>Pricing</a>
        </nav>
        <div className="landing-actions">
          <LanguageMenu language={language} onChange={onLanguage} />
          <button className="btn-secondary landing-login" onClick={onLogin}>Log in</button>
          <button className="btn-primary landing-register" onClick={onRegister}>Register</button>
        </div>
      </header>

      <section id="top" className="landing-hero">
        <div className="landing-hero-text">
          <span className="landing-kicker">Coaching, simplified</span>
          <h1>Keep every client on track, without the spreadsheets.</h1>
          <p className="landing-lead">
            BodUp brings client check-ins, feedback sessions, reminders and learning together in one place, so coaches
            spend time coaching and clients always know what comes next.
          </p>
          <div className="landing-cta">
            <button className="btn-primary btn-large" onClick={onRegister}>Register as a coach</button>
            <button className="btn-secondary btn-large" onClick={scrollTo('pricing')}>See pricing</button>
          </div>
          <p className="landing-note">Free to start. Clients join with an invite code from their coach.</p>
        </div>

        <div className="landing-hero-art" aria-hidden="true">
          <div className="hero-card hero-card-main">
            <div className="hero-card-head">
              <span className="client-avatar large">A</span>
              <div>
                <strong>Sample client</strong>
                <small>Checked in today</small>
              </div>
              <span className="level-pill green">Running good</span>
            </div>
            <div className="hero-metrics">
              <div><span className="metric-value">78.4 kg</span><span className="metric-label">Current weight</span></div>
              <div><span className="metric-value">-4.2 kg</span><span className="metric-label">Since start</span></div>
              <div><span className="metric-value">6 / 7</span><span className="metric-label">Days logged</span></div>
            </div>
          </div>
          <div className="hero-card hero-card-float">
            <Icon name="calendar" size={18} />
            <div>
              <strong>Feedback session</strong>
              <small>Thu 10:00, Google Meet</small>
            </div>
          </div>
          <div className="hero-card hero-card-float-2">
            <span className="level-dot yellow" />
            <div>
              <strong>Keep watch</strong>
              <small>No check-in for 9 days</small>
            </div>
          </div>
        </div>
      </section>

      <section id="solutions" className="landing-section">
        <div className="landing-heading">
          <span className="landing-kicker">Solutions</span>
          <h2>One platform for coach, client and routine</h2>
          <p>Whether you coach one client or a whole practice, BodUp gives you the same clear picture.</p>
        </div>
        <div className="solution-grid">
          {LANDING_SOLUTIONS.map((s) => (
            <article key={s.title} className="solution-card">
              <span className="solution-icon"><Icon name={s.icon} size={22} /></span>
              <h3>{s.title}</h3>
              <p>{s.text}</p>
              <ul>
                {s.points.map((p) => (
                  <li key={p}><Icon name="check" size={14} /><span>{p}</span></li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </section>

      <section id="features" className="landing-section">
        <div className="landing-heading">
          <span className="landing-kicker">Features</span>
          <h2>Everything you need, and nothing you don't</h2>
          <p>Built around the daily work of coaching, from first invite to finished programme.</p>
        </div>
        <div className="feature-grid">
          {LANDING_FEATURES.map((f) => (
            <div key={f.title} className="feature-card">
              <span className="feature-icon"><Icon name={f.icon} size={20} /></span>
              <h3>{f.title}</h3>
              <p>{f.text}</p>
            </div>
          ))}
        </div>
      </section>

      <section id="pricing" className="landing-section">
        <div className="landing-heading">
          <span className="landing-kicker">Pricing</span>
          <h2>Start free, grow when you're ready</h2>
          <p>Prices in euros, billed monthly. Change or cancel your plan at any time.</p>
        </div>
        <div className="pricing-grid">
          {(plans || PLANS).map((plan) => (
            <article key={plan.id} className={`pricing-card ${plan.price > 0 ? 'featured' : ''}`}>
              {plan.price > 0 && <span className="pricing-badge">Most popular</span>}
              <h3>{plan.name}</h3>
              <p className="pricing-tagline">{plan.tagline}</p>
              <div className="pricing-price">
                {plan.price === 0 ? '0 EUR' : `${plan.price.toFixed(2)} EUR`}
                <span>{plan.price === 0 ? ' forever' : ' / month'}</span>
              </div>
              <ul>
                {plan.features.map((f) => (
                  <li key={f}><Icon name="check" size={16} /><span>{f}</span></li>
                ))}
              </ul>
              <button className={plan.price > 0 ? 'btn-primary' : 'btn-secondary'} onClick={onRegister}>
                {plan.price === 0 ? 'Start free' : `Choose ${plan.name}`}
              </button>
            </article>
          ))}
        </div>
      </section>

      <section className="landing-cta-band">
        <h2>Ready to coach with a clearer view?</h2>
        <p>Create your coach account in a minute and invite your first client.</p>
        <button className="btn-primary btn-large" onClick={onRegister}>Register</button>
      </section>

      <footer className="landing-footer">
        <BrandMark size={26} />
        <span>&copy; {new Date().getFullYear()} BodUp. All rights reserved.</span>
        <div className="landing-footer-links">
          <button className="link-btn" onClick={onLogin}>Log in</button>
          <button className="link-btn" onClick={onRegister}>Register</button>
        </div>
      </footer>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Registration and onboarding for coaches (BodUp)
// Steps: 1 create account, 2 welcome, 3 confirm email, 4 profile photo (skippable),
// 5 coaching type, 6 niche, 7 six-month goals, 8 current tools, 9 client base, 10 workspace name
// ---------------------------------------------------------------------------
const ONB_TOTAL = 10;
const OTHER = 'Other';
const COACH_TYPES = [
  'Online Fitness Coach',
  'In person personal trainer',
  'Hybrid (online and in person)',
  'Nutritionist / dietitian',
  OTHER
];
const GOAL_OPTIONS = [
  'Get my first paying clients',
  'Grow the business (clients and income)',
  'Increase what I charge',
  'Save time on admin',
  'Provide a better quality of service',
  'Improve my retention',
  OTHER
];
// "Coaching platforms" was removed on purpose. Each "Other" is its own choice, so picking one
// does not select the others.
const TOOL_GROUPS = [
  { label: 'Admin and documents', items: ['Google Sheets / Excel', 'Notion', 'Google Drive', OTHER] },
  { label: 'Comms, scheduling and marketing', items: ['WhatsApp', 'Calendly', 'Mailchimp', 'ActiveCampaign', 'Kit', OTHER] },
  { label: 'Payments', items: ['PayPal', 'GoCardless', 'Stripe', OTHER] }
];
const toolValue = (group, item) => (item === OTHER ? `Other (${group.label})` : item);
const isOtherTool = (value) => value.startsWith('Other (');
const CLIENT_BASE_OPTIONS = ['0-5', '5-15', '15-30', '30-50', '50-100', '100+'];
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;
const LETTERS = 'ABCDEFGHIJ';

const slugify = (text) =>
  String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);

const authErrorText = (err) => {
  const code = (err && err.code) || '';
  if (code === 'auth/email-already-in-use') return 'An account with this email already exists. Try signing in instead.';
  if (code === 'auth/invalid-email') return 'Enter a valid email address.';
  if (code === 'auth/weak-password') return 'Choose a stronger password (at least 8 characters).';
  if (code === 'auth/invalid-credential' || code === 'auth/wrong-password' || code === 'auth/user-not-found') {
    return 'Email or password is not right.';
  }
  if (code === 'auth/too-many-requests') return 'Too many attempts. Wait a few minutes and try again.';
  if (code === 'auth/network-request-failed') return 'No connection. Check your internet and try again.';
  if (code === 'auth/operation-not-allowed') {
    return 'Email sign-up is not switched on yet. In Firebase, open Authentication > Sign-in method and enable Email/Password.';
  }
  if (code === 'auth/unauthorized-domain') {
    return 'This website address is not allowed to sign in yet. In Firebase, add it under Authentication > Settings > Authorized domains.';
  }
  if (code === 'auth/invalid-api-key' || code === 'auth/api-key-not-valid.-please-pass-a-valid-api-key.') {
    return 'The Firebase API key in the app is not valid. Check the firebaseConfig in App.js.';
  }
  return `Something went wrong (${code || 'no error code'}). Please try again.`;
};

// Shared frame for the registration screens: a centred card, not a full-screen page
function OnbFrame({ step, children, footer, wide = false }) {
  return (
    <div className="onb">
      <div className={`onb-card ${wide ? 'wide' : ''}`}>
        <header className="onb-top">
          <BrandMark size={26} />
          {step && <span className="onb-step">Step {step} of {ONB_TOTAL}</span>}
        </header>
        {step && (
          <div className="onb-progress" aria-hidden="true">
            <span style={{ width: `${(step / ONB_TOTAL) * 100}%` }} />
          </div>
        )}
        <main className="onb-body">{children}</main>
        {footer && <footer className="onb-footer">{footer}</footer>}
      </div>
    </div>
  );
}

function OnbOption({ letter, label, selected, onClick }) {
  return (
    <button type="button" className={`onb-option ${selected ? 'selected' : ''}`} aria-pressed={selected} onClick={onClick}>
      <span>{label}</span>
      {letter && <span className="onb-letter">{letter}</span>}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Profile photo: drag to position, zoom, saved as a 256 px square
// ---------------------------------------------------------------------------
function PhotoPicker({ onUse, onCancel, busy = false, saveLabel = 'Use this photo' }) {
  const VIEW = 300;
  const OUT = 256;
  const [src, setSrc] = useState('');
  const [dims, setDims] = useState(null);
  const [zoom, setZoom] = useState(1);
  const [off, setOff] = useState({ x: 0, y: 0 });
  const [error, setError] = useState('');
  const drag = useRef(null);
  const imgRef = useRef(null);

  const base = dims ? Math.max(VIEW / dims.w, VIEW / dims.h) : 1;

  // Keeps the photo covering the whole circle as the user drags or zooms
  const clampOffset = (o, z) => {
    if (!dims) return o;
    const s = base * z;
    const maxX = Math.max(0, (dims.w * s - VIEW) / 2);
    const maxY = Math.max(0, (dims.h * s - VIEW) / 2);
    return {
      x: Math.min(maxX, Math.max(-maxX, o.x)),
      y: Math.min(maxY, Math.max(-maxY, o.y))
    };
  };

  const pickFile = (e) => {
    const file = e.target.files && e.target.files[0];
    setError('');
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setError('Choose an image file (JPG, PNG or similar).');
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setError('That image is larger than 10 MB. Choose a smaller one.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setDims(null);
      setZoom(1);
      setOff({ x: 0, y: 0 });
      setSrc(reader.result);
    };
    reader.readAsDataURL(file);
  };

  const onImgLoad = (e) => {
    setDims({ w: e.target.naturalWidth, h: e.target.naturalHeight });
  };

  const changeZoom = (value) => {
    const z = Number(value);
    setZoom(z);
    setOff((prev) => clampOffset(prev, z));
  };

  const onPointerDown = (e) => {
    drag.current = { x: e.clientX, y: e.clientY, o: off };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e) => {
    if (!drag.current) return;
    const dx = e.clientX - drag.current.x;
    const dy = e.clientY - drag.current.y;
    setOff(clampOffset({ x: drag.current.o.x + dx, y: drag.current.o.y + dy }, zoom));
  };

  const endDrag = () => {
    drag.current = null;
  };

  const crop = () => {
    const s = base * zoom;
    const size = VIEW / s;
    const cx = dims.w / 2 - off.x / s;
    const cy = dims.h / 2 - off.y / s;
    const sx = Math.min(Math.max(0, cx - size / 2), dims.w - size);
    const sy = Math.min(Math.max(0, cy - size / 2), dims.h - size);
    const canvas = document.createElement('canvas');
    canvas.width = OUT;
    canvas.height = OUT;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, OUT, OUT);
    ctx.drawImage(imgRef.current, sx, sy, size, size, 0, 0, OUT, OUT);
    return canvas.toDataURL('image/jpeg', 0.85);
  };

  const use = () => {
    if (!src || !dims) return;
    onUse(crop());
  };

  const s = base * zoom;
  return (
    <div className="photo-picker">
      {!src ? (
        <label className="photo-drop">
          <Icon name="camera" size={26} />
          <strong>Choose a photo</strong>
          <span>A clear photo of your face works best. JPG or PNG, up to 10 MB.</span>
          <input type="file" accept="image/*" onChange={pickFile} />
        </label>
      ) : (
        <>
          <div
            className="photo-view"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          >
            <img
              ref={imgRef}
              src={src}
              alt=""
              draggable={false}
              onLoad={onImgLoad}
              className="photo-img"
              style={
                dims
                  ? {
                      width: dims.w * s,
                      height: dims.h * s,
                      transform: `translate(calc(-50% + ${off.x}px), calc(-50% + ${off.y}px))`
                    }
                  : { visibility: 'hidden' }
              }
            />
            <div className="photo-mask" />
          </div>
          <div className="photo-zoom">
            <Icon name="minus" size={16} />
            <input
              type="range"
              min="1"
              max="3"
              step="0.01"
              value={zoom}
              onChange={(e) => changeZoom(e.target.value)}
              aria-label="Zoom"
            />
            <Icon name="plus" size={16} />
          </div>
          <p className="field-hint">Drag to put your face in the circle, and zoom to fit.</p>
          <div className="photo-actions">
            <button type="button" className="btn-primary" disabled={!dims || busy} onClick={use}>
              <Icon name="check" size={16} /> {busy ? 'Saving...' : saveLabel}
            </button>
            <label className="btn-secondary photo-change">
              <Icon name="camera" size={16} /> Choose another
              <input type="file" accept="image/*" onChange={pickFile} />
            </label>
          </div>
        </>
      )}
      {error && <p className="form-message error">{error}</p>}
      {onCancel && (
        <button type="button" className="link-btn photo-cancel" onClick={onCancel}>Cancel</button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 1: create account (split card, as in the reference)
// ---------------------------------------------------------------------------
function AccountStep({ onBack, onSignIn, onGoogle, onCreated, onInviteCode }) {
  const [form, setForm] = useState({ name: '', email: '', password: '', confirm: '', terms: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [show, setShow] = useState(false);

  const set = (key) => (e) => setForm({ ...form, [key]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    const name = form.name.trim();
    const email = form.email.trim();
    if (!name) return setError('Enter your full name.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return setError('Enter a valid email address.');
    if (form.password.length < 8) return setError('Use at least 8 characters for your password.');
    if (form.password !== form.confirm) return setError('The two passwords do not match.');
    if (!form.terms) return setError('Please accept the terms to continue.');
    setError('');
    setBusy(true);
    try {
      const created = await createUserWithEmailAndPassword(auth, email, form.password);
      await updateProfile(created.user, { displayName: name });
      await setDoc(doc(db, 'users', created.user.uid), {
        email,
        displayName: name,
        role: 'coach',
        status: 'active',
        onboardingComplete: false,
        onboardingStep: 2,
        onboarding: {},
        createdAt: serverTimestamp()
      });
      await setDoc(
        doc(db, 'coaches', created.user.uid),
        { userId: created.user.uid, name, email, createdAt: serverTimestamp() },
        { merge: true }
      );
      await sendEmailVerification(created.user);
      onCreated({ name });
    } catch (err) {
      setError(authErrorText(err));
      setBusy(false);
    }
  };

  return (
    <div className="onb">
      <div className="onb-card onb-card-split">
        <aside className="onb-side">
          <BrandMark size={28} className="onb-side-brand" />
          <span className="onb-pill">Start free</span>
          <h1>Coaching, all in one place.</h1>
          <p>Clients, check-ins, feedback sessions and learning, with your reminders handled for you.</p>
          <ul>
            <li><Icon name="check" size={15} /> Manage every client in one workspace</li>
            <li><Icon name="check" size={15} /> Check-ins, feedback and learning</li>
            <li><Icon name="check" size={15} /> Sessions and reminders in one calendar</li>
          </ul>
        </aside>

        <main className="onb-form-side">
          <button className="btn-back icon-text" onClick={onBack}>
            <Icon name="back" size={16} /> Back to home
          </button>
          <h2>Create your account</h2>
          <p className="onb-sub">Sign up free and we will bring you straight in.</p>

          <form className="onb-form" onSubmit={submit}>
            <input type="text" placeholder="Full name" autoComplete="name" value={form.name} onChange={set('name')} />
            <input type="email" placeholder="Email address" autoComplete="email" value={form.email} onChange={set('email')} />
            <div className="onb-password">
              <input
                type={show ? 'text' : 'password'}
                placeholder="Create a password (8+ characters)"
                autoComplete="new-password"
                value={form.password}
                onChange={set('password')}
              />
              <button type="button" className="link-btn" onClick={() => setShow(!show)}>{show ? 'Hide' : 'Show'}</button>
            </div>
            <input
              type={show ? 'text' : 'password'}
              placeholder="Confirm password"
              autoComplete="new-password"
              value={form.confirm}
              onChange={set('confirm')}
            />
            <label className="check-row onb-terms">
              <input type="checkbox" checked={form.terms} onChange={set('terms')} />
              <span>I agree to the Terms of Service and Privacy Policy.</span>
            </label>
            {error && <p className="form-message error">{error}</p>}
            <button type="submit" className="btn-primary onb-submit" disabled={busy}>
              {busy ? 'Creating your account...' : 'Create account'}
            </button>
          </form>

          <div className="onb-or"><span>or</span></div>
          <button type="button" className="btn-secondary onb-google" onClick={onGoogle}>Register with Google</button>
          <p className="onb-switch">
            Already have an account? <button type="button" className="link-btn" onClick={onSignIn}>Sign in</button>
          </p>
          <p className="onb-switch">
            Are you a client with an invite code? <button type="button" className="link-btn" onClick={onInviteCode}>Join here</button>
          </p>
        </main>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 2: welcome
// ---------------------------------------------------------------------------
function WelcomeStep({ name, onNext }) {
  return (
    <OnbFrame
      step={2}
      footer={<button className="btn-primary onb-next" onClick={onNext}>Start your setup <Icon name="expand" size={16} /></button>}
    >
      <div className="onb-welcome">
        <p className="onb-hello">{firstName(name)}, you made it.</p>
        <h1>Welcome to <span className="grad-text">BodUp.</span></h1>
        <p className="onb-sub">
          A few short steps to set up your coaching space. Everything can be changed later.
        </p>
      </div>
    </OnbFrame>
  );
}

// ---------------------------------------------------------------------------
// Step 3: confirm email (checks automatically)
// ---------------------------------------------------------------------------
function VerifyStep({ user, onVerified, onStartOver }) {
  const [sent, setSent] = useState('');
  const [cooldown, setCooldown] = useState(0);
  const [checking, setChecking] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [error, setError] = useState('');

  const check = async () => {
    const current = auth.currentUser;
    if (!current) return false;
    setChecking(true);
    try {
      await current.reload();
      if (current.emailVerified) {
        onVerified();
        return true;
      }
      return false;
    } catch (err) {
      setError('Could not check right now. We will try again.');
      return false;
    } finally {
      setChecking(false);
    }
  };

  // Watch for the confirmation every few seconds, so the user does not have to press anything
  useEffect(() => {
    const timer = setInterval(() => {
      if (auth.currentUser) check();
    }, 3000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (cooldown <= 0) return undefined;
    const t = setTimeout(() => setCooldown(cooldown - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const resend = async () => {
    setError('');
    try {
      await sendEmailVerification(auth.currentUser);
      setSent('A new confirmation email is on its way.');
      setCooldown(30);
    } catch (err) {
      setError('Please wait a little before asking for another email.');
    }
  };

  const startAgain = () => {
    if (!window.confirm('Start again with a different email? This removes the account you just created.')) return;
    onStartOver();
  };

  const email = user.email || 'your email';
  return (
    <OnbFrame
      step={3}
      footer={
        <button className="btn-secondary" onClick={check} disabled={checking}>
          {checking ? 'Checking...' : 'Already confirmed? Check now'}
        </button>
      }
    >
      <div className="onb-split">
        <div className="onb-split-text">
          <span className="onb-eyebrow">One quick check</span>
          <h1>Confirm your <span className="grad-text">email.</span></h1>
          <p className="onb-sub">
            We have sent a confirmation link to <strong>{email}</strong>. Open it on this device or on your phone. This page
            moves on automatically the moment you confirm.
          </p>
          <div className="onb-status"><span className="onb-dot" /> Checking automatically for your confirmation</div>
          <div className="onb-inline-actions">
            <button className="btn-primary" onClick={resend} disabled={cooldown > 0}>
              {cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend confirmation email'}
            </button>
            <button className="link-btn" onClick={() => setShowHelp(!showHelp)}>Didn't get it?</button>
            <button className="link-btn" onClick={startAgain}>Wrong email? Start again</button>
          </div>
          {showHelp && (
            <p className="field-hint">
              Check your spam or junk folder, and make sure the address above is right. The email comes from Firebase, the
              sign-in service behind BodUp.
            </p>
          )}
          {sent && <p className="form-message success">{sent}</p>}
          {error && <p className="form-message error">{error}</p>}
        </div>
        <div className="onb-split-art" aria-hidden="true">
          <div className="inbox-card">
            <div className="inbox-head">
              <span>Inbox</span>
              <span className="inbox-badge">1</span>
            </div>
            <div className="inbox-mail">
              <span className="inbox-avatar">B</span>
              <div>
                <strong>BodUp</strong>
                <small>to {email}</small>
              </div>
            </div>
            <h3>Confirm your email address</h3>
            <div className="inbox-lines"><span /><span /><span /></div>
            <div className="inbox-button">Confirm email address</div>
          </div>
        </div>
      </div>
    </OnbFrame>
  );
}

// ---------------------------------------------------------------------------
// Steps 4 to 10
// ---------------------------------------------------------------------------
function OnboardingFlow({ user, startStep, startAnswers, onFinished, onStartOver }) {
  const [step, setStep] = useState(startStep || 2);
  const [a, setA] = useState({
    coachType: '',
    coachTypeOther: '',
    niche: '',
    goals: [],
    goalOther: '',
    tools: [],
    toolsOther: '',
    clientBase: '',
    workspaceName: '',
    slug: '',
    photoUrl: '',
    ...(startAnswers || {})
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [photoMode, setPhotoMode] = useState(false);
  const name = user.displayName || '';

  // Saves progress, so the setup can be resumed after a refresh or a new visit
  const save = async (nextStep, patch = {}) => {
    setBusy(true);
    setError('');
    try {
      const next = { ...a, ...patch };
      await setDoc(
        doc(db, 'users', user.uid),
        { onboardingStep: nextStep, onboarding: next, lastUpdated: serverTimestamp() },
        { merge: true }
      );
      setA(next);
      setStep(nextStep);
      setPhotoMode(false);
      return true;
    } catch (err) {
      setError('Could not save. Check your connection and try again.');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const back = () => setStep(Math.max(4, step - 1));

  const toggle = (list, value) => (list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);

  const hasOtherTool = a.tools.some(isOtherTool);

  const finish = async () => {
    const workspaceName = a.workspaceName.trim();
    const slug = slugify(a.slug);
    if (workspaceName.length < 2) return setError('Name your workspace (at least 2 characters).');
    if (!a.slug.trim()) return setError('Choose your invite link. Clients use it to find you.');
    if (!SLUG_PATTERN.test(slug)) return setError('Your link needs 3 to 30 letters or numbers, for example "your-name".');
    setBusy(true);
    setError('');
    try {
      const taken = await getDoc(doc(db, 'inviteLinks', slug));
      if (taken.exists() && taken.data().coachId !== user.uid) {
        setError('That link is already taken. Try another one.');
        setBusy(false);
        return;
      }
      await setDoc(doc(db, 'inviteLinks', slug), { coachId: user.uid, createdAt: serverTimestamp() }, { merge: true });
      await setDoc(
        doc(db, 'users', user.uid),
        {
          workspaceName,
          inviteSlug: slug,
          onboarding: { ...a, workspaceName, slug },
          onboardingStep: ONB_TOTAL,
          onboardingComplete: true,
          completedAt: serverTimestamp()
        },
        { merge: true }
      );
      // Lets the home screen prompt appear once the coach reaches the dashboard
      window.dispatchEvent(new Event('bodup-onboarding-complete'));
      onFinished();
    } catch (err) {
      setError('Could not finish setup. Try again.');
      setBusy(false);
    }
  };

  if (step === 2) {
    return <WelcomeStep name={name} onNext={() => save(3)} />;
  }

  if (step === 3) {
    return <VerifyStep user={user} onVerified={() => save(4)} onStartOver={onStartOver} />;
  }

  const footerNav = (onNext, nextLabel, nextDisabled, backAllowed = true) => (
    <div className="onb-nav">
      {backAllowed ? (
        <button className="btn-back icon-text" onClick={back} disabled={busy}>
          <Icon name="back" size={16} /> Back
        </button>
      ) : <span />}
      <button className="btn-primary onb-next" onClick={onNext} disabled={busy || nextDisabled}>
        {busy ? 'Saving...' : nextLabel} <Icon name="expand" size={16} />
      </button>
    </div>
  );

  if (step === 4) {
    if (photoMode) {
      return (
        <OnbFrame step={4} footer={null}>
          <div className="onb-center">
            <h1 className="onb-title">Upload a <span className="grad-text">profile</span> picture of yourself</h1>
            <PhotoPicker
              busy={busy}
              onUse={(dataUrl) => save(5, { photoUrl: dataUrl })}
              onCancel={() => setPhotoMode(false)}
            />
          </div>
        </OnbFrame>
      );
    }
    return (
      <OnbFrame step={4} footer={null}>
        <div className="onb-center">
          <h1 className="onb-title">Add a <span className="grad-text">profile</span> picture</h1>
          <p className="onb-sub">Clients see your photo when they open BodUp with your invite. You can skip this and add one later under My profile.</p>
          <div className="onb-photo-choice">
            <button className="btn-primary" onClick={() => setPhotoMode(true)}>
              <Icon name="camera" size={16} /> Add a photo
            </button>
            <button className="btn-secondary" onClick={() => save(5)} disabled={busy}>Skip for now</button>
          </div>
          {error && <p className="form-message error">{error}</p>}
          <div className="onb-nav">
            <button className="btn-back icon-text" disabled>
              <Icon name="back" size={16} /> Back
            </button>
            <span />
          </div>
        </div>
      </OnbFrame>
    );
  }

  if (step === 5) {
    const typeOk = a.coachType && (a.coachType !== OTHER || a.coachTypeOther.trim());
    return (
      <OnbFrame
        step={5}
        footer={footerNav(() => save(6, { coachType: a.coachType, coachTypeOther: a.coachType === OTHER ? a.coachTypeOther.trim() : '' }), 'Next', !typeOk)}
      >
        <div className="onb-center">
          <span className="onb-eyebrow">Question 1 of 6</span>
          <h1 className="onb-title">What type of coach are <span className="grad-text">you?</span></h1>
          <p className="onb-sub">Pick the option which best describes you.</p>
          <div className="onb-options">
            {COACH_TYPES.map((t, i) => (
              <OnbOption key={t} letter={LETTERS[i]} label={t} selected={a.coachType === t} onClick={() => setA({ ...a, coachType: t })} />
            ))}
          </div>
          {a.coachType === OTHER && (
            <input
              className="onb-input onb-other"
              type="text"
              maxLength={80}
              autoFocus
              placeholder="Tell us what kind of coach you are"
              value={a.coachTypeOther}
              onChange={(e) => setA({ ...a, coachTypeOther: e.target.value })}
            />
          )}
          {error && <p className="form-message error">{error}</p>}
        </div>
      </OnbFrame>
    );
  }

  if (step === 6) {
    return (
      <OnbFrame step={6} footer={footerNav(() => save(7, { niche: a.niche.trim() }), 'Next', !a.niche.trim())}>
        <div className="onb-center narrow">
          <span className="onb-eyebrow">Question 2 of 6</span>
          <h1 className="onb-title">What is your <span className="grad-text">coaching niche?</span></h1>
          <p className="onb-sub">Who do you typically coach?</p>
          <input
            className="onb-input"
            type="text"
            maxLength={80}
            placeholder="Type your answer..."
            value={a.niche}
            onChange={(e) => setA({ ...a, niche: e.target.value })}
          />
          {error && <p className="form-message error">{error}</p>}
        </div>
      </OnbFrame>
    );
  }

  if (step === 7) {
    const goalsOk = a.goals.length > 0 && (!a.goals.includes(OTHER) || a.goalOther.trim());
    return (
      <OnbFrame
        step={7}
        footer={footerNav(
          () => save(8, { goals: a.goals, goalOther: a.goals.includes(OTHER) ? a.goalOther.trim() : '' }),
          'Next',
          !goalsOk
        )}
      >
        <div className="onb-center narrow">
          <span className="onb-eyebrow">Question 3 of 6</span>
          <h1 className="onb-title">What is your main goal <span className="grad-text">for the next 6 months?</span></h1>
          <p className="onb-sub">Choose all which apply to you.</p>
          <div className="onb-options">
            {GOAL_OPTIONS.map((g) => (
              <OnbOption key={g} label={g} selected={a.goals.includes(g)} onClick={() => setA({ ...a, goals: toggle(a.goals, g) })} />
            ))}
          </div>
          {a.goals.includes(OTHER) && (
            <input
              className="onb-input onb-other"
              type="text"
              maxLength={120}
              autoFocus
              placeholder="Tell us your goal"
              value={a.goalOther}
              onChange={(e) => setA({ ...a, goalOther: e.target.value })}
            />
          )}
          {error && <p className="form-message error">{error}</p>}
        </div>
      </OnbFrame>
    );
  }

  if (step === 8) {
    const toolsOk = a.tools.length > 0 && (!hasOtherTool || a.toolsOther.trim());
    return (
      <OnbFrame
        step={8}
        footer={footerNav(
          () => save(9, { tools: a.tools, toolsOther: hasOtherTool ? a.toolsOther.trim() : '' }),
          'Next',
          !toolsOk
        )}
        wide
      >
        <div className="onb-center">
          <span className="onb-eyebrow">Question 4 of 6</span>
          <h1 className="onb-title">How are you currently running <span className="grad-text">your coaching business?</span></h1>
          <p className="onb-sub">Let us know what tools you are using at the moment.</p>
          {TOOL_GROUPS.map((group) => (
            <div key={group.label} className="onb-tool-group">
              <span className="onb-group-label">{group.label}</span>
              <div className="onb-chips">
                {group.items.map((item) => {
                  const value = toolValue(group, item);
                  const on = a.tools.includes(value);
                  return (
                    <button
                      key={value}
                      type="button"
                      className={`onb-chip-pill ${on ? 'selected' : ''}`}
                      aria-pressed={on}
                      onClick={() => setA({ ...a, tools: toggle(a.tools, value) })}
                    >
                      {item}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
          {hasOtherTool && (
            <input
              className="onb-input onb-other"
              type="text"
              maxLength={80}
              autoFocus
              placeholder="Which tool do you use?"
              value={a.toolsOther}
              onChange={(e) => setA({ ...a, toolsOther: e.target.value })}
            />
          )}
          {error && <p className="form-message error">{error}</p>}
        </div>
      </OnbFrame>
    );
  }

  if (step === 9) {
    return (
      <OnbFrame step={9} footer={footerNav(() => save(10, { clientBase: a.clientBase }), 'Continue', !a.clientBase)}>
        <div className="onb-center narrow">
          <span className="onb-eyebrow">Question 5 of 6</span>
          <h1 className="onb-title">How many active clients <span className="grad-text">do you have?</span></h1>
          <p className="onb-sub">This helps us set up your dashboard best for you.</p>
          <div className="onb-options">
            {CLIENT_BASE_OPTIONS.map((c, i) => (
              <OnbOption key={c} letter={LETTERS[i]} label={c} selected={a.clientBase === c} onClick={() => setA({ ...a, clientBase: c })} />
            ))}
          </div>
          {error && <p className="form-message error">{error}</p>}
        </div>
      </OnbFrame>
    );
  }

  // Step 10: name the workspace and choose the invite link (required, never filled in for the coach)
  const host = window.location.host;
  const linkValue = slugify(a.slug);
  const linkReady = SLUG_PATTERN.test(linkValue);
  const nameReady = a.workspaceName.trim().length >= 2;
  const displayName = a.workspaceName.trim() || 'Your business name';
  const sampleLink = `${host}/@${linkReady ? linkValue : 'your-link'}`;
  return (
    <OnbFrame
      step={10}
      footer={
        <div className="onb-nav">
          <button className="btn-back icon-text" onClick={back} disabled={busy}>
            <Icon name="back" size={16} /> Back
          </button>
          <button className="btn-primary onb-next" onClick={finish} disabled={busy || !nameReady || !linkReady}>
            {busy ? 'Finishing...' : 'Finish setup'} <Icon name="expand" size={16} />
          </button>
        </div>
      }
    >
      <div className="onb-split">
        <div className="onb-split-text">
          <span className="onb-eyebrow">Workspace setup</span>
          <h1>Name your <span className="grad-text">workspace.</span></h1>
          <p className="onb-sub">This is your home on BodUp. Clients use your invite link to find you.</p>

          <div className="onb-field">
            <label>Workspace name</label>
            <input
              type="text"
              placeholder="Your business name"
              maxLength={60}
              value={a.workspaceName}
              onChange={(e) => setA({ ...a, workspaceName: e.target.value })}
            />
          </div>

          <div className="onb-field onb-key">
            <label>Your invite link <span className="required-tag">Required</span></label>
            <div className="onb-link">
              <span className="onb-link-prefix">{host}/@</span>
              <input
                type="text"
                placeholder="your-name"
                maxLength={30}
                value={a.slug}
                onChange={(e) => setA({ ...a, slug: slugify(e.target.value) })}
              />
            </div>
            {nameReady && !a.slug && (
              <button type="button" className="link-btn onb-suggest" onClick={() => setA({ ...a, slug: slugify(a.workspaceName) })}>
                Use "{slugify(a.workspaceName)}"
              </button>
            )}
            <small className="field-hint">Letters, numbers and dashes. Pick one you can share with clients.</small>
          </div>

          {error && <p className="form-message error">{error}</p>}
        </div>

        <div className="onb-split-art" aria-hidden="true">
          <div className="share-mock">
            <div className="chat-card">
              <div className="chat-head">
                <span className="workspace-avatar sm">{initialOf(displayName)}</span>
                <div>
                  <strong>{displayName}</strong>
                  <small>online</small>
                </div>
              </div>
              <div className="chat-body">
                <div className="bubble in">
                  Hi Anna, I have set up my coaching space. Join me here: <span className="bubble-link">{sampleLink}</span>
                </div>
                <div className="bubble out">Thank you, joining now!</div>
              </div>
            </div>

            <div className="mail-card">
              <div className="mail-top">
                <span className="mail-logo">M</span>
                <div>
                  <strong>{displayName}</strong>
                  <small>to me</small>
                </div>
              </div>
              <p className="mail-subject">Your invite to {displayName}</p>
              <p className="mail-snippet">
                Welcome aboard. Open <span className="bubble-link">{sampleLink}</span> to join your coaching space.
              </p>
            </div>
          </div>
        </div>
      </div>
    </OnbFrame>
  );
}

// Shown to a signed-in person whose account data is still loading
function LoadingScreen({ onSignOut }) {
  return (
    <div className="login-container">
      <div className="login-card">
        <p className="empty-state">Loading your account...</p>
        <button className="btn-secondary" onClick={onSignOut}>Sign out</button>
      </div>
    </div>
  );
}

// Email and password sign-in, with password reset
function EmailSignIn() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    if (!email.trim() || !password) return setMessage({ type: 'error', text: 'Enter your email and password.' });
    setBusy(true);
    setMessage(null);
    try {
      await signInWithEmailAndPassword(auth, email.trim(), password);
    } catch (err) {
      setMessage({ type: 'error', text: authErrorText(err) });
      setBusy(false);
    }
  };

  const reset = async () => {
    if (!email.trim()) return setMessage({ type: 'error', text: 'Type your email above first, then press Forgot password.' });
    try {
      await sendPasswordResetEmail(auth, email.trim());
      setMessage({ type: 'success', text: 'If an account exists for that email, a reset link is on its way.' });
    } catch (err) {
      setMessage({ type: 'error', text: authErrorText(err) });
    }
  };

  return (
    <form className="form email-sign-in" onSubmit={submit}>
      <div className="form-group">
        <label>Email</label>
        <input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      <div className="form-group">
        <label>Password</label>
        <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </div>
      {message && <p className={`form-message ${message.type}`}>{message.text}</p>}
      <button type="submit" className="btn-primary" disabled={busy}>{busy ? 'Signing in...' : 'Sign in'}</button>
      <button type="button" className="link-btn email-reset" onClick={reset}>Forgot password?</button>
    </form>
  );
}

// ---------------------------------------------------------------------------
function InstallModal({ onClose }) {
  const installed = isInstalledApp();
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const canInstall = !!window.__bodupInstallEvent;

  const install = async () => {
    const ev = window.__bodupInstallEvent;
    if (!ev) return;
    ev.prompt();
    await ev.userChoice;
    window.__bodupInstallEvent = null;
    onClose();
  };

  return (
    <Modal title="Add BodUp to your home screen" onClose={onClose}>
      {installed ? (
        <p className="section-subtitle">BodUp is already on this device. Open it from your home screen or desktop.</p>
      ) : canInstall ? (
        <>
          <p className="section-subtitle">Install BodUp as an app. It opens full screen, straight from your home screen or desktop.</p>
          <div className="modal-actions">
            <button type="button" className="btn-secondary" onClick={onClose}>Not now</button>
            <button type="button" className="btn-primary" onClick={install}>Install BodUp</button>
          </div>
        </>
      ) : (
        <>
          <p className="section-subtitle">
            {ios ? 'On iPhone, add BodUp from Safari:' : 'Add BodUp from your browser menu:'}
          </p>
          <ol className="install-steps">
            {ios ? (
              <>
                <li>Tap the Share button in Safari.</li>
                <li>Choose "Add to Home Screen".</li>
                <li>Tap Add.</li>
              </>
            ) : (
              <>
                <li>Open the browser menu (the three dots, or the install icon in the address bar).</li>
                <li>Choose "Install BodUp" or "Add to Home screen".</li>
              </>
            )}
          </ol>
          <div className="modal-actions">
            <button type="button" className="btn-primary" onClick={onClose}>Got it</button>
          </div>
        </>
      )}
    </Modal>
  );
}

// Email confirmation and password reset links land here (set as the action URL in Firebase)
function AuthActionPage() {
  const params = new URLSearchParams(window.location.search);
  const mode = params.get('mode') || '';
  const code = params.get('oobCode') || '';
  const [phase, setPhase] = useState('working');
  const [message, setMessage] = useState('');
  const [resetEmail, setResetEmail] = useState('');
  const [pw, setPw] = useState({ a: '', b: '' });

  useEffect(() => {
    (async () => {
      try {
        if (mode === 'verifyEmail') {
          await applyActionCode(auth, code);
          setPhase('verified');
        } else if (mode === 'resetPassword') {
          const email = await verifyPasswordResetCode(auth, code);
          setResetEmail(email);
          setPhase('reset');
        } else {
          setMessage('This link is not valid for BodUp.');
          setPhase('error');
        }
      } catch (err) {
        setMessage('This link has expired or was already used. Ask BodUp for a new one from the sign-in page.');
        setPhase('error');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const goHome = () => {
    window.location.href = '/';
  };

  const submitReset = async (e) => {
    e.preventDefault();
    if (pw.a.length < 8) return setMessage('Use at least 8 characters.');
    if (pw.a !== pw.b) return setMessage('The two passwords do not match.');
    try {
      await confirmPasswordReset(auth, code, pw.a);
      setPhase('reset-done');
    } catch (err) {
      setMessage('This link has expired or was already used. Ask for a new one.');
      setPhase('error');
    }
  };

  return (
    <div className="confirm-page">
      <div className="confirm-card">
        <div className="gradient-bar" />
        <div className="confirm-body">
          <BrandMark size={34} />
          {phase === 'working' && <p>Checking your link...</p>}

          {phase === 'verified' && (
            <>
              <span className="confirm-ok"><Icon name="check" size={26} /></span>
              <h1>Your email is confirmed</h1>
              <p>Thank you. Your BodUp account is now fully set up. Go back to BodUp to finish your setup.</p>
              <button className="btn-primary" onClick={goHome}>Continue to BodUp</button>
            </>
          )}

          {phase === 'reset' && (
            <>
              <h1>Choose a new password</h1>
              <p>For {resetEmail}. Use at least 8 characters.</p>
              <form onSubmit={submitReset}>
                <input type="password" placeholder="New password" value={pw.a} onChange={(e) => setPw({ ...pw, a: e.target.value })} />
                <input type="password" placeholder="Confirm new password" value={pw.b} onChange={(e) => setPw({ ...pw, b: e.target.value })} />
                {message && <p className="form-message error">{message}</p>}
                <button className="btn-primary" type="submit">Save new password</button>
              </form>
            </>
          )}

          {phase === 'reset-done' && (
            <>
              <span className="confirm-ok"><Icon name="check" size={26} /></span>
              <h1>Password changed</h1>
              <p>You can now sign in to BodUp with your new password.</p>
              <button className="btn-primary" onClick={goHome}>Go to BodUp</button>
            </>
          )}

          {phase === 'error' && (
            <>
              <h1>This link cannot be used</h1>
              <p>{message}</p>
              <button className="btn-primary" onClick={goHome}>Back to BodUp</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// Home screen install prompt (a progressive web app: works like an app once added)
// ---------------------------------------------------------------------------
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    window.__bodupInstallEvent = e;
  });
}

const INSTALL_KEY = 'bodup-install-dismissed';

const isInstalledApp = () =>
  (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
  (typeof navigator !== 'undefined' && navigator.standalone === true);

function InstallPromptHost() {
  const [open, setOpen] = useState(false);
  const [deferred, setDeferred] = useState(null);
  const [showSteps, setShowSteps] = useState(false);
  const [ios, setIos] = useState(false);

  useEffect(() => {
    if (window.__bodupInstallEvent) setDeferred(window.__bodupInstallEvent);
    const onBefore = (e) => {
      e.preventDefault();
      setDeferred(e);
    };
    const onDone = () => {
      let dismissed = false;
      try {
        dismissed = !!window.localStorage.getItem(INSTALL_KEY);
      } catch (err) {
        dismissed = false;
      }
      if (!dismissed && !isInstalledApp()) setOpen(true);
    };
    setIos(/iphone|ipad|ipod/i.test(navigator.userAgent));
    window.addEventListener('beforeinstallprompt', onBefore);
    window.addEventListener('bodup-onboarding-complete', onDone);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBefore);
      window.removeEventListener('bodup-onboarding-complete', onDone);
    };
  }, []);

  const close = (remember) => {
    setOpen(false);
    setShowSteps(false);
    if (remember) {
      try {
        window.localStorage.setItem(INSTALL_KEY, '1');
      } catch (err) {
        console.error('Could not save preference:', err);
      }
    }
  };

  const doInstall = async () => {
    if (deferred) {
      deferred.prompt();
      await deferred.userChoice;
      setDeferred(null);
      close(true);
      return;
    }
    // iPhone and browsers without the install button: show the steps instead
    setShowSteps(true);
  };

  if (!open) return null;

  return (
    <div className="install-prompt" role="dialog" aria-label="Add BodUp to your home screen">
      <button className="install-close" onClick={() => close(true)} aria-label="Close">
        <Icon name="x" size={14} />
      </button>
      <BrandMark size={34} showText={false} className="install-mark" />
      {!showSteps ? (
        <>
          <h3>Want to add this app to your home screen?</h3>
          <p>It is the best way to use BodUp on the go: full screen, one tap away, always ready.</p>
          <button className="install-yes" onClick={doInstall}>Yes, do it now</button>
          <button className="link-btn install-later" onClick={() => close(true)}>Do it later</button>
        </>
      ) : (
        <>
          <h3>Add BodUp to your home screen</h3>
          {ios ? (
            <ol>
              <li>Tap the Share button in Safari.</li>
              <li>Choose "Add to Home Screen".</li>
              <li>Tap Add.</li>
            </ol>
          ) : (
            <ol>
              <li>Open the browser menu (the three dots, or the install icon in the address bar).</li>
              <li>Choose "Install BodUp" or "Add to Home screen".</li>
            </ol>
          )}
          <button className="install-yes" onClick={() => close(true)}>Got it</button>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Admin tools, shown inside the coach dashboard for admins (round 7)
// Every change goes through /api/admin, which checks the admin on the server.
// ---------------------------------------------------------------------------
const ADMIN_CONTACT = 'gregorsedrik@gmail.com';


// Christmas hat, snowflake and tree, drawn as icons so they look the same on every device
const FESTIVE_ICONS = {
  hat: (
    <>
      <path d="M4 17c2-1 4-1.5 8-1.5S18 16 20 17" />
      <path d="M6 15.5c0-5 2.5-9 7-10.5 1 2.5 1 5 0 8" />
      <circle cx="13" cy="4.5" r="1.8" />
      <path d="M5 17.5h14" />
    </>
  ),
  snowflake: (
    <>
      <path d="M12 2v20M3.3 7l17.4 10M3.3 17l17.4-10" />
      <path d="M9 4l3 2 3-2M9 20l3-2 3 2" />
    </>
  ),
  tree: (
    <>
      <path d="M12 2l5 7h-2.5L18 14h-3l3.5 6h-13L12 14H9l3.5-5H10z" />
      <path d="M12 20v2" />
    </>
  )
};

function FestiveIcon({ name, size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="festive-icon">
      {FESTIVE_ICONS[name]}
    </svg>
  );
}

const SNOW = Array.from({ length: 34 }, (_, i) => ({
  left: `${(i * 37) % 100}%`,
  size: 9 + ((i * 7) % 10),
  duration: `${26 + ((i * 11) % 16)}s`,
  delay: `${-((i * 5) % 28)}s`
}));

// Snow falls slowly over every page at Christmas. Summer adds a warm glow.
function FestiveLayer() {
  const [season, setSeason] = useState('default');

  useEffect(() => {
    let alive = true;
    const pull = async () => {
      try {
        const res = await fetch('/api/public-config');
        const data = await res.json();
        if (alive && data.season) setSeason(data.season);
      } catch (err) {
        // Keep the default look if the settings cannot be reached
      }
    };
    pull();
    const timer = setInterval(pull, 5 * 60 * 1000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('data-season', season);
  }, [season]);

  if (season === 'christmas') {
    return (
      <div className="snow-layer" aria-hidden="true">
        {SNOW.map((f, i) => (
          <span key={i} className="snowflake" style={{ left: f.left, animationDuration: f.duration, animationDelay: f.delay }}>
            <FestiveIcon name="snowflake" size={f.size} />
          </span>
        ))}
      </div>
    );
  }
  if (season === 'summer') return <div className="summer-glow" aria-hidden="true" />;
  return null;
}

// Small festive icons near the dashboard heading, shown only at Christmas
function FestiveBadge({ season }) {
  if (season !== 'christmas') return null;
  return (
    <span className="festive-badge" aria-label="Season greeting">
      <FestiveIcon name="hat" size={20} />
      <FestiveIcon name="snowflake" size={18} />
      <FestiveIcon name="tree" size={20} />
    </span>
  );
}

function MaintenancePage({ message, onAdminSignIn }) {
  return (
    <div className="confirm-page">
      <div className="confirm-card">
        <div className="gradient-bar" />
        <div className="confirm-body">
          <BrandMark size={34} />
          <span className="confirm-ok maint"><Icon name="shield" size={26} /></span>
          <h1>BodUp is undergoing maintenance</h1>
          <p>{message || 'We are making improvements. Please try again shortly.'}</p>
          <p className="field-hint">Your data is safe. Thank you for your patience.</p>
          <button className="btn-secondary" onClick={onAdminSignIn}>Admin sign in</button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Coach chat with the admin (replaces the coming-soon page)
// ---------------------------------------------------------------------------
function CoachChat() {
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const endRef = useRef(null);

  const load = async () => {
    try {
      const data = await adminCall('chatGet');
      setMessages(data.messages || []);
    } catch (err) {
      setError(err.message);
    }
  };

  useEffect(() => {
    load();
    const timer = setInterval(load, 20000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (endRef.current) endRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length]);

  const send = async (e) => {
    e.preventDefault();
    const value = text.trim();
    if (!value) return;
    setBusy(true);
    setError('');
    try {
      const data = await adminCall('chatSend', { text: value });
      setMessages(data.messages || []);
      setText('');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dashboard-view">
      <div className="page-header">
        <h2>Chat with BodUp</h2>
        <p>Ask a question or report a problem. The BodUp admin replies here. You can also write by email.</p>
      </div>
      <section className="section chat-thread-card">
        <div className="thread">
          {messages.length === 0 && <p className="empty-state">No messages yet. Write below to start the conversation.</p>}
          {messages.map((m, i) => (
            <div key={i} className={`thread-msg ${m.from === 'admin' ? 'from-admin' : 'from-me'}`}>
              <span className="thread-text">{m.text}</span>
              <small>{m.from === 'admin' ? 'BodUp admin' : 'You'} - {m.at ? new Date(m.at).toLocaleString() : ''}</small>
            </div>
          ))}
          <div ref={endRef} />
        </div>
        <form className="thread-form" onSubmit={send}>
          <input
            type="text"
            value={text}
            maxLength={2000}
            placeholder="Write a message..."
            onChange={(e) => setText(e.target.value)}
            aria-label="Message"
          />
          <button type="submit" className="btn-primary" disabled={busy || !text.trim()}>
            {busy ? 'Sending...' : 'Send'}
          </button>
        </form>
        {error && <p className="form-message error">{error}</p>}
        <p className="field-hint">
          Prefer email? Write to <a href={`mailto:${ADMIN_CONTACT}`}>{ADMIN_CONTACT}</a>.
        </p>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Admin pages
// ---------------------------------------------------------------------------
function CustomersPage({ data }) {
  const t = data.totals;
  return (
    <div className="dashboard-view">
      <div className="page-header">
        <h2>Customers</h2>
        <p>Coaches, the clients they bring, the gyms those clients train at, and plans.</p>
      </div>
      <div className="stats-grid">
        <div className="stat-card"><div className="stat-value">{t.coaches}</div><div className="stat-label">Coaches</div></div>
        <div className="stat-card"><div className="stat-value">{t.clients}</div><div className="stat-label">Clients</div></div>
        <div className="stat-card"><div className="stat-value">{t.joinedClients}</div><div className="stat-label">Clients who joined</div></div>
        <div className="stat-card"><div className="stat-value">{t.payingCoaches}</div><div className="stat-label">Paying coaches</div></div>
        <div className="stat-card"><div className="stat-value">{t.gyms}</div><div className="stat-label">Gyms named by clients</div></div>
      </div>

      <section className="section">
        <h3>Coaches and their plans</h3>
        {data.coaches.length === 0 ? <p className="empty-state">No coaches yet.</p> : (
          <div className="table-scroll">
            <table className="data-table admin-table">
              <thead><tr><th>Coach</th><th>Plan</th><th>Price</th><th>Clients</th><th>Joined</th><th>Gyms</th><th>Status</th></tr></thead>
              <tbody>
                {data.coaches.map((c) => (
                  <tr key={c.uid}>
                    <td><strong>{c.name || '-'}</strong><div className="cell-sub">{c.email}</div></td>
                    <td>{c.plan}</td>
                    <td>{c.price ? formatMoney(c.price) : 'Free'}</td>
                    <td>{c.clients}</td>
                    <td>{c.joined}</td>
                    <td>{c.gyms.length ? c.gyms.map((g) => `${g.name} (${g.count})`).join(', ') : '-'}</td>
                    <td><span className={`status-pill ${c.status}`}>{c.status}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="two-col">
        <section className="section">
          <h3>Gyms</h3>
          {data.gyms.length === 0 ? <p className="empty-state">No gyms named yet. Clients add theirs in their profile.</p> : (
            <ul className="analytics-list">
              {data.gyms.map((g) => (
                <li key={g.name} className="gym-row"><span>{g.name}</span><strong>{g.count}</strong></li>
              ))}
            </ul>
          )}
        </section>
        <section className="section">
          <h3>Companies</h3>
          <p className="empty-state">Companies appear here once enterprise accounts are set up.</p>
        </section>
      </div>

      <section className="section">
        <h3>All clients</h3>
        {data.clients.length === 0 ? <p className="empty-state">No clients yet.</p> : (
          <div className="table-scroll">
            <table className="data-table admin-table">
              <thead><tr><th>Client</th><th>Coach</th><th>Gym</th><th>Status</th></tr></thead>
              <tbody>
                {data.clients.map((c) => (
                  <tr key={c.id}>
                    <td>{c.name || '-'}</td>
                    <td>{c.coachName || '-'}</td>
                    <td>{c.gym || '-'}</td>
                    <td><span className={`status-pill ${c.status}`}>{c.status}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function CouponsPage({ data, act, loading }) {
  const blank = { code: '', type: 'percent', value: '', validUntil: '', maxUses: '0' };
  const [form, setForm] = useState(blank);
  const save = () =>
    act('couponSave', {
      code: form.code,
      type: form.type,
      value: Number(form.value),
      validUntil: form.validUntil || null,
      maxUses: Number(form.maxUses) || 0,
      active: true
    }, 'Coupon saved.').then(() => setForm(blank));

  return (
    <div className="dashboard-view">
      <div className="page-header">
        <h2>Coupons</h2>
        <p>Discount codes coaches can enter at checkout. Each code can have an end date and a limit on uses.</p>
      </div>
      <section className="section">
        <h3>Create a coupon</h3>
        <div className="form-row three">
          <div className="form-group">
            <label>Code</label>
            <input type="text" value={form.code} placeholder="XMAS20" maxLength={20} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} />
          </div>
          <div className="form-group">
            <label>Discount</label>
            <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
              <option value="percent">Percent off</option>
              <option value="amount">Amount off (EUR)</option>
            </select>
          </div>
          <div className="form-group">
            <label>{form.type === 'percent' ? 'Percent' : 'EUR'}</label>
            <input type="number" min="0" step="0.01" value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} />
          </div>
        </div>
        <div className="form-row">
          <div className="form-group">
            <label>Valid until (optional)</label>
            <input type="date" value={form.validUntil} onChange={(e) => setForm({ ...form, validUntil: e.target.value })} />
          </div>
          <div className="form-group">
            <label>Maximum uses (0 = no limit)</label>
            <input type="number" min="0" value={form.maxUses} onChange={(e) => setForm({ ...form, maxUses: e.target.value })} />
          </div>
        </div>
        <button className="btn-primary" disabled={loading || !form.code || !form.value} onClick={save}>Save coupon</button>
      </section>

      <section className="section">
        <h3>All coupons</h3>
        {data.coupons.length === 0 ? <p className="empty-state">No coupons yet.</p> : (
          <div className="table-scroll">
            <table className="data-table admin-table">
              <thead><tr><th>Code</th><th>Discount</th><th>Valid until</th><th>Uses</th><th>Status</th><th>Actions</th></tr></thead>
              <tbody>
                {data.coupons.map((c) => (
                  <tr key={c.code}>
                    <td><strong>{c.code}</strong></td>
                    <td>{c.type === 'percent' ? `${c.value}% off` : `${c.value} EUR off`}</td>
                    <td>{c.validUntil || 'No end date'}</td>
                    <td>{c.uses}{c.maxUses ? ` of ${c.maxUses}` : ''}</td>
                    <td><span className={`status-pill ${c.active ? 'active' : 'closed'}`}>{c.active ? 'active' : 'off'}</span></td>
                    <td>
                      <button className="btn-secondary btn-small" disabled={loading} onClick={() => act('couponToggle', { code: c.code, active: !c.active }, c.active ? 'Coupon switched off.' : 'Coupon switched on.')}>
                        {c.active ? 'Switch off' : 'Switch on'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function PricingPage({ data, act, loading }) {
  const source = data.plans && data.plans.length ? data.plans : PLANS;
  const [draft, setDraft] = useState(() => source.map((p) => ({ ...p, featuresText: (p.features || []).join('\n') })));
  const update = (i, patch) => setDraft(draft.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const save = () =>
    act(
      'plansSave',
      {
        plans: draft.map(({ featuresText, ...p }) => ({
          ...p,
          price: Number(p.price),
          features: featuresText.split('\n').map((x) => x.trim()).filter(Boolean)
        }))
      },
      'Prices saved. The website and checkout use them now.'
    );

  return (
    <div className="dashboard-view">
      <div className="page-header">
        <h2>Pricing</h2>
        <p>Changes show on the landing page and at checkout straight away.</p>
      </div>
      {draft.map((p, i) => (
        <section key={p.id} className="section plan-edit">
          <h3>{p.name}</h3>
          <div className="form-row three">
            <div className="form-group">
              <label>Plan name</label>
              <input type="text" value={p.name} onChange={(e) => update(i, { name: e.target.value })} />
            </div>
            <div className="form-group">
              <label>Price (EUR per month)</label>
              <input type="number" min="0" step="0.01" value={p.price} onChange={(e) => update(i, { price: e.target.value })} />
            </div>
            <div className="form-group">
              <label>Shown to visitors</label>
              <label className="check-row"><input type="checkbox" checked={p.active !== false} onChange={(e) => update(i, { active: e.target.checked })} /><span>Show this plan</span></label>
            </div>
          </div>
          <div className="form-group">
            <label>One line under the name</label>
            <input type="text" value={p.tagline || ''} maxLength={120} onChange={(e) => update(i, { tagline: e.target.value })} />
          </div>
          <div className="form-group">
            <label>Features (one per line)</label>
            <textarea rows="5" value={p.featuresText} onChange={(e) => update(i, { featuresText: e.target.value })} />
          </div>
        </section>
      ))}
      <button className="btn-primary" disabled={loading} onClick={save}>Save all prices</button>
    </div>
  );
}

function PartnersPage({ data, act, loading }) {
  const source = data.partners && data.partners.length ? data.partners : PARTNERS;
  const [list, setList] = useState(() => source.map((p) => ({ ...p })));
  const [adding, setAdding] = useState({ name: '', url: '', description: '' });
  const save = () => act('partnersSave', { partners: list }, 'Partners saved.');
  const add = () => {
    if (!adding.name.trim() || !adding.url.trim()) return;
    setList([...list, { ...adding, active: true }]);
    setAdding({ name: '', url: '', description: '' });
  };

  return (
    <div className="dashboard-view">
      <div className="page-header">
        <h2>Partners</h2>
        <p>Partners you collaborate with. Coaches can introduce them to clients, and they appear on the Automated messages list.</p>
      </div>
      <section className="section">
        <h3>Add a partner</h3>
        <div className="form-row three">
          <div className="form-group">
            <label>Name</label>
            <input type="text" value={adding.name} maxLength={60} onChange={(e) => setAdding({ ...adding, name: e.target.value })} />
          </div>
          <div className="form-group">
            <label>Website (https)</label>
            <input type="url" value={adding.url} placeholder="https://" onChange={(e) => setAdding({ ...adding, url: e.target.value })} />
          </div>
          <div className="form-group">
            <label>Short description</label>
            <input type="text" value={adding.description} maxLength={200} onChange={(e) => setAdding({ ...adding, description: e.target.value })} />
          </div>
        </div>
        <button className="btn-secondary" onClick={add} disabled={!adding.name.trim() || !adding.url.trim()}>Add to list</button>
      </section>

      <section className="section">
        <h3>Current partners</h3>
        {list.length === 0 ? <p className="empty-state">No partners yet.</p> : (
          <ul className="partner-list">
            {list.map((p, i) => (
              <li key={`${p.id}-${i}`} className="partner-row">
                <div className="partner-main">
                  <strong>{p.name}</strong>
                  <small>{p.url}</small>
                  {p.description && <small>{p.description}</small>}
                </div>
                <label className="check-row"><input type="checkbox" checked={p.active !== false} onChange={(e) => setList(list.map((x, j) => (j === i ? { ...x, active: e.target.checked } : x)))} /><span>Active</span></label>
                <button className="btn-secondary btn-small" onClick={() => setList(list.filter((_, j) => j !== i))}>Remove</button>
              </li>
            ))}
          </ul>
        )}
        <button className="btn-primary" disabled={loading} onClick={save}>Save partners</button>
      </section>
    </div>
  );
}

function VisitsPage({ data }) {
  const max = Math.max(1, ...data.days.map((d) => d.count));
  return (
    <div className="dashboard-view">
      <div className="page-header">
        <h2>Visits</h2>
        <p>How many times the site was opened each day. Only totals are kept, nothing identifies a visitor.</p>
      </div>
      <div className="stats-grid">
        <div className="stat-card"><div className="stat-value">{data.today}</div><div className="stat-label">Today</div></div>
        <div className="stat-card"><div className="stat-value">{data.last7}</div><div className="stat-label">Last 7 days</div></div>
        <div className="stat-card"><div className="stat-value">{data.last30}</div><div className="stat-label">Last 30 days</div></div>
      </div>
      <section className="section">
        <h3>Last 30 days</h3>
        {data.days.length === 0 ? <p className="empty-state">No visits recorded yet.</p> : (
          <div className="bar-chart" role="img" aria-label="Visits per day">
            {data.days.map((d) => (
              <div key={d.date} className="bar-col" title={`${d.date}: ${d.count}`}>
                <span className="bar" style={{ height: `${Math.max(3, (d.count / max) * 100)}%` }} />
                <small>{d.date.slice(8)}</small>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function SitePage({ data, act, loading }) {
  const [season, setSeason] = useState(data.season || 'default');
  const [maint, setMaint] = useState({ enabled: !!data.maintenance?.enabled, message: data.maintenance?.message || '' });
  const seasons = [
    { id: 'default', label: 'Standard', icon: null },
    { id: 'christmas', label: 'Christmas', icon: 'hat' },
    { id: 'summer', label: 'Summer', icon: 'sun' }
  ];
  const save = () => act('siteSave', { season, maintenance: maint }, 'Site settings saved.');

  return (
    <div className="dashboard-view">
      <div className="page-header">
        <h2>Site and seasons</h2>
        <p>Choose the look for everyone, and switch the site into maintenance mode when needed.</p>
      </div>

      <section className="section">
        <h3>Season</h3>
        <p className="section-subtitle">Christmas adds falling snow and festive icons. Summer adds a warm glow. Visitors see the change on their next visit.</p>
        <div className="season-buttons">
          {seasons.map((s) => (
            <button key={s.id} className={`season-btn ${season === s.id ? 'active' : ''} ${s.id}`} aria-pressed={season === s.id} onClick={() => setSeason(s.id)}>
              {s.icon === 'hat' && <FestiveIcon name="hat" size={20} />}
              {s.icon === 'sun' && <Icon name="sun" size={20} />}
              <span>{s.label}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="section">
        <h3>Maintenance mode</h3>
        <p className="section-subtitle">When on, nobody can sign in, anyone signed in is signed out, and visitors see your message. Admins can still sign in.</p>
        <label className="check-row">
          <input type="checkbox" checked={maint.enabled} onChange={(e) => setMaint({ ...maint, enabled: e.target.checked })} />
          <span>Maintenance mode is on</span>
        </label>
        <div className="form-group">
          <label>Message to visitors</label>
          <textarea rows="3" maxLength={300} value={maint.message} onChange={(e) => setMaint({ ...maint, message: e.target.value })} />
        </div>
      </section>

      <button className="btn-primary" disabled={loading} onClick={save}>Save site settings</button>
    </div>
  );
}

function AdminsPage({ data, act, loading }) {
  const [email, setEmail] = useState('');
  const invite = () => act('adminInvite', { email: email.trim() }, 'Admin added. They get admin rights when they sign in with that email.').then(() => setEmail(''));
  return (
    <div className="dashboard-view">
      <div className="page-header">
        <h2>Admins</h2>
        <p>People with admin rights. They sign in normally, and the admin tools appear for them.</p>
      </div>
      <section className="section">
        <h3>Invite an admin</h3>
        <div className="admin-toolbar">
          <input className="admin-search" type="email" placeholder="name@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
          <button className="btn-primary" disabled={loading || !email.trim()} onClick={invite}>Add admin</button>
        </div>
      </section>
      <section className="section">
        <h3>Current admins</h3>
        <ul className="partner-list">
          {data.admins.map((a) => (
            <li key={a.email} className="partner-row">
              <div className="partner-main"><strong>{a.email}</strong><small>{a.source}</small></div>
              {!a.source.startsWith('Set in Vercel') && (
                <button className="btn-secondary btn-small" disabled={loading} onClick={() => act('adminRemove', { email: a.email }, 'Admin access removed.')}>Remove</button>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function ChatAdminPage({ data, loading }) {
  const [selected, setSelected] = useState(null);
  const [thread, setThread] = useState([]);
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const open = async (coachId) => {
    setSelected(coachId);
    setError('');
    try {
      const res = await adminCall('chatThread', { coachId });
      setThread(res.messages || []);
    } catch (err) {
      setError(err.message);
    }
  };

  const send = async () => {
    if (!reply.trim() || !selected) return;
    setBusy(true);
    setError('');
    try {
      const res = await adminCall('chatReply', { coachId: selected, text: reply.trim() });
      setThread(res.messages || []);
      setReply('');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dashboard-view">
      <div className="page-header">
        <h2>Chat</h2>
        <p>Conversations with coaches. Unread threads are marked.</p>
      </div>
      <div className="chat-admin">
        <section className="section chat-list-col">
          {data.threads.length === 0 ? <p className="empty-state">No conversations yet.</p> : (
            <ul className="analytics-list">
              {data.threads.map((t) => (
                <li key={t.coachId}>
                  <button className={`analytics-item ${selected === t.coachId ? 'selected' : ''}`} onClick={() => open(t.coachId)}>
                    <span className="analytics-item-text">
                      <span className="activity-name">{t.coachName}{t.unreadAdmin && <span className="unread-dot" />}</span>
                      <span className="activity-sub">{t.last ? t.last.text.slice(0, 60) : ''}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="section chat-thread-col">
          {!selected ? <p className="empty-state">Choose a conversation on the left.</p> : (
            <>
              <div className="thread">
                {thread.map((m, i) => (
                  <div key={i} className={`thread-msg ${m.from === 'admin' ? 'from-admin' : 'from-me'}`}>
                    <span className="thread-text">{m.text}</span>
                    <small>{m.from === 'admin' ? 'You (admin)' : 'Coach'} - {m.at ? new Date(m.at).toLocaleString() : ''}</small>
                  </div>
                ))}
              </div>
              <div className="thread-form">
                <input type="text" value={reply} maxLength={2000} placeholder="Write a reply..." onChange={(e) => setReply(e.target.value)} />
                <button className="btn-primary" disabled={busy || !reply.trim() || loading} onClick={send}>{busy ? 'Sending...' : 'Reply'}</button>
              </div>
              {error && <p className="form-message error">{error}</p>}
            </>
          )}
        </section>
      </div>
    </div>
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
  const [theme, setTheme] = useState(() => readPref('coachflow-theme', 'light'));
  const [language, setLanguage] = useState(() => readPref('coachflow-language', 'en'));
  const [clientView, setClientView] = useState('overview');
  const [chartRange, setChartRange] = useState('weekly');
  const [coachProfile, setCoachProfile] = useState(null);
  const [loginNotice, setLoginNotice] = useState('');
  const [activeModal, setActiveModal] = useState(null);
  const [modalMessage, setModalMessage] = useState(null);
  const [closeConfirm, setCloseConfirm] = useState('');
  const [billing, setBilling] = useState({ methods: [], invoices: [], subscription: null });
  const [checkoutPlanId, setCheckoutPlanId] = useState(null);
  const [selectedMethodId, setSelectedMethodId] = useState('');
  const [billingBusy, setBillingBusy] = useState(false);
  const [calendarEvents, setCalendarEvents] = useState([]);
  const [outbox, setOutbox] = useState([]);
  const [calendarMonth, setCalendarMonth] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const [googleAccess, setGoogleAccess] = useState(null);
  const [scheduleDraft, setScheduleDraft] = useState(null);
  const [emailTab, setEmailTab] = useState('client');
  const [emailEditing, setEmailEditing] = useState(false);
  const [selectedEventId, setSelectedEventId] = useState(null);
  const [optInDraft, setOptInDraft] = useState(null);
  const [calendarBusy, setCalendarBusy] = useState(false);
  const [calendarNotice, setCalendarNotice] = useState(null);
  const [clientRecord, setClientRecord] = useState(null);
  const [clientEvents, setClientEvents] = useState([]);
  const [checkinMode, setCheckinMode] = useState('day');
  const [checkinDay, setCheckinDay] = useState(() => ((new Date().getDay() + 6) % 7) + 1);
  const [clientNotice, setClientNotice] = useState(null);
  const [reminderDraft, setReminderDraft] = useState(null);
  const [accountStatus, setAccountStatus] = useState('active');
  
  // Invite code flow state
  const [showInviteCodeInput, setShowInviteCodeInput] = useState(false);
  const [authView, setAuthView] = useState('landing');
  const [onboardingComplete, setOnboardingComplete] = useState(null);
  const [onboardingStep, setOnboardingStep] = useState(2);
  const [onboardingData, setOnboardingData] = useState({});
  const [profilePhotoEditing, setProfilePhotoEditing] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [siteConfig, setSiteConfig] = useState({ season: 'default', maintenance: { enabled: false, message: '' } });
  const [livePlans, setLivePlans] = useState(PLANS);
  const [livePartners, setLivePartners] = useState(PARTNERS);
  const [maintenanceBypass, setMaintenanceBypass] = useState(false);
  const [couponInput, setCouponInput] = useState('');
  const [appliedCoupon, setAppliedCoupon] = useState(null);
  const [couponMsg, setCouponMsg] = useState(null);
  const [inviteCodeInput, setInviteCodeInput] = useState('');
  const [inviteCodeError, setInviteCodeError] = useState('');

  const loadUserData = async (userId) => {
    try {
      // The server decides who the admin is. An admin with no coach record gets the admin-only view.
      // An admin who is also a coach keeps the coach dashboard, with the admin tools added.
      const adminFlag = !!(auth.currentUser && auth.currentUser.uid === userId && (await checkIsAdmin()));
      setIsAdmin(adminFlag);
      const userDoc = await getDoc(doc(db, 'users', userId));
      if (adminFlag && !userDoc.exists()) {
        setLoginNotice('');
        setUserRole('admin');
        return;
      }
      if (userDoc.exists()) {
        if (userDoc.data().status === 'closed') {
          await signOut(auth);
          setUser(null);
          setUserRole(null);
          setLoginNotice('This account has been closed. Contact the BodUp admin if you think this is a mistake.');
          return;
        }
        setLoginNotice('');
        setAccountStatus(userDoc.data().status || 'active');
        // Accounts created before onboarding existed count as complete
        setOnboardingComplete(userDoc.data().onboardingComplete !== false);
        setOnboardingStep(userDoc.data().onboardingStep || 2);
        setOnboardingData(userDoc.data().onboarding || {});
        setUserRole(userDoc.data().role);
        setCoachProfile(userDoc.data());
        if (userDoc.data().role === 'coach') {
          fetchCoachData(userId);
          fetchBilling(userId);
          fetchCalendar(userId);
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
            const [profileSnap, checkInSnap, userSnap] = await Promise.all([
              getDoc(doc(db, 'profiles', c.userId)),
              getDocs(query(collection(db, 'weeklyCheckIns'), where('clientId', '==', c.userId))),
              getDoc(doc(db, 'users', c.userId))
            ]);
            const checkIns = checkInSnap.docs
              .map((d) => ({ id: d.id, ...d.data() }))
              .sort((a, b) => (checkInDate(a)?.getTime() || 0) - (checkInDate(b)?.getTime() || 0));
            return [
              c.id,
              {
                profile: profileSnap.exists() ? profileSnap.data() : null,
                checkIns,
                email: userSnap.exists() ? userSnap.data().email || '' : ''
              }
            ];
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
    setCalendarNotice(null);
    setCurrentPage(page);
    setSelectedClientId(null);
    setExpandedCheckIn(null);
  };

  const openClient = (clientId) => {
    setCalendarNotice(null);
    setReturnPage(['dashboard', 'clients', 'analytics'].includes(currentPage) ? currentPage : 'clients');
    setSelectedClientId(clientId);
    setExpandedCheckIn(null);
    setCurrentPage('client-detail');
  };

  const handleRefresh = async () => {
    if (!user) return;
    setRefreshing(true);
    await fetchCoachData(user.uid);
    await fetchCalendar(user.uid);
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
      setClientRecord(clientRecord);
      if (clientRecord) {
        const eventSnap = await getDocs(query(collection(db, 'calendarEvents'), where('clientId', '==', clientRecord.id)));
        setClientEvents(eventSnap.docs.map((d) => ({ id: d.id, ...d.data() })));
      }
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
        if (await checkIsAdmin()) {
          setIsAdmin(true);
          setUserRole('admin');
          return;
        }
        await setDoc(doc(db, 'users', googleUser.uid), {
          email: googleUser.email,
          displayName: googleUser.displayName,
          role: 'coach',
          status: 'active',
          onboardingComplete: false,
          onboardingStep: 4,
          onboarding: {},
          createdAt: serverTimestamp()
        });

        await setDoc(doc(db, 'coaches', googleUser.uid), {
          userId: googleUser.uid,
          name: googleUser.displayName,
          email: googleUser.email,
          createdAt: serverTimestamp()
        });

        setOnboardingComplete(false);
        setOnboardingStep(4);
        setOnboardingData({});
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
      setAccountStatus('active');
      setClients([]);
      setProfile(null);
      setClientData({});
      setSelectedClientId(null);
      setWeeklyCheckIns([]);
      setCoachInfo(null);
      setCoachProfile(null);
      setBilling({ methods: [], invoices: [], subscription: null });
      setCalendarEvents([]);
      setOutbox([]);
      setGoogleAccess(null);
      setScheduleDraft(null);
      setOptInDraft(null);
      setSelectedEventId(null);
      setCalendarNotice(null);
      setClientRecord(null);
      setClientEvents([]);
      setClientNotice(null);
      setReminderDraft(null);
      setActiveModal(null);
      setModalMessage(null);
      setCurrentPage('dashboard');
      setShowInviteCodeInput(false);
      setInviteCodeInput('');
      setAuthView('landing');
      setOnboardingComplete(null);
      setOnboardingStep(2);
      setOnboardingData({});
      setProfilePhotoEditing(false);
      setIsAdmin(false);
      setAppliedCoupon(null);
      setCouponInput('');
      setCouponMsg(null);
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
        inviteEmail: String(formData.get('clientEmail') || '').trim(),
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
    const dateOfBirth = String(formData.get('dateOfBirth') || '');
    const gymChoice = String(formData.get('gym') || '');
    const gymOther = String(formData.get('gymOther') || '').trim();

    try {
      setLoading(true);
      const profileData = {
        dateOfBirth,
        age: ageFromDob(dateOfBirth),
        sex: formData.get('sex'),
        height: parseFloat(formData.get('height')),
        weight: parseFloat(formData.get('weight')),
        targetWeight: parseFloat(formData.get('targetWeight')),
        activityLevel: formData.get('activityLevel'),
        steps: parseInt(formData.get('steps')),
        water: parseFloat(formData.get('water')),
        gymChoice,
        gym: gymChoice === 'Other' ? gymOther : gymChoice,
        lastUpdated: serverTimestamp(),
        ...(profile ? {} : { createdAt: serverTimestamp() })
      };

      await setDoc(doc(db, 'profiles', user.uid), profileData, { merge: true });
      setProfile({ ...(profile || {}), ...profileData });
      setClientNotice({ type: 'success', text: 'Your profile has been saved.' });
      setCurrentPage('dashboard');
    } catch (error) {
      console.error('Error saving profile:', error);
      setClientNotice({ type: 'error', text: 'Could not save your profile. Try again.' });
    } finally {
      setLoading(false);
    }
  };

  // ---- Client portal: navigation and check-ins ----
  const goClient = (page) => {
    setClientNotice(null);
    setSelectedEventId(null);
    setCurrentPage(page);
  };

  // Saves one or more days into this week's check-in (one document per week)
  const saveCheckInDays = async (changes) => {
    const weekKey = getWeekKey(new Date());
    const existing = findWeekDoc(weeklyCheckIns, weekKey);
    const days = mergeDays(existing?.days, changes, new Date());

    const record = clientRecord || (await getClientRecord(user.uid));
    const docId = existing ? existing.id : `${user.uid}_${weekKey}`;
    await setDoc(
      doc(db, 'weeklyCheckIns', docId),
      {
        clientId: user.uid,
        coachId: record?.coachId || null,
        weekKey,
        weekNumber: isoWeekNumber(parseDateKey(weekKey)),
        days,
        updatedAt: serverTimestamp(),
        ...(existing ? {} : { createdAt: serverTimestamp(), weekStart: parseDateKey(weekKey) })
      },
      { merge: true }
    );
    await fetchClientData(user.uid);
  };

  const readDay = (fd, day, suffix) => ({
    day,
    weight: parseFloat(fd.get(`weight${suffix}`)) || 0,
    meals: {
      breakfast: String(fd.get(`breakfast${suffix}`) || '').trim(),
      lunch: String(fd.get(`lunch${suffix}`) || '').trim(),
      dinner: String(fd.get(`dinner${suffix}`) || '').trim(),
      snacks: String(fd.get(`snacks${suffix}`) || '').trim()
    },
    water: parseFloat(fd.get(`water${suffix}`)) || 0
  });

  const handleSaveDay = async (e) => {
    e.preventDefault();
    const goNext = e.nativeEvent.submitter && e.nativeEvent.submitter.value === 'next';
    const entry = readDay(new FormData(e.target), checkinDay, '');
    if (!dayHasData(entry)) {
      setClientNotice({ type: 'error', text: 'Add at least your weight, a meal or your water to save this day.' });
      return;
    }
    try {
      setLoading(true);
      await saveCheckInDays([entry]);
      setClientNotice({ type: 'success', text: `${WEEKDAYS[checkinDay - 1]} saved.` });
      if (goNext && checkinDay < 7) setCheckinDay(checkinDay + 1);
    } catch (error) {
      console.error('Error saving day:', error);
      setClientNotice({ type: 'error', text: 'Could not save this day. Try again.' });
    } finally {
      setLoading(false);
    }
  };

  const handleSaveWeek = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const entries = [1, 2, 3, 4, 5, 6, 7].map((day) => readDay(fd, day, `-${day}`));
    if (!entries.some(dayHasData)) {
      setClientNotice({ type: 'error', text: 'Fill in at least one day before saving.' });
      return;
    }
    try {
      setLoading(true);
      await saveCheckInDays(entries);
      setClientNotice({ type: 'success', text: 'Your week has been saved.' });
    } catch (error) {
      console.error('Error saving week:', error);
      setClientNotice({ type: 'error', text: 'Could not save your week. Try again.' });
    } finally {
      setLoading(false);
    }
  };

  // ---- Coach: reminder for an invitation that has not been used ----
  const openInviteReminder = async (clientId) => {
    const c = getClientView(clientId);
    if (!c) return;
    const code = await getReferralCode(clientId);
    const texts = buildInviteEmail({
      coachName: currentCoachName(),
      clientName: c.name,
      code,
      appUrl: window.location.origin
    });
    setEmailEditing(false);
    setReminderDraft({
      clientId,
      email: c.inviteEmail || '',
      subject: texts.subject,
      body: texts.body,
      busy: false,
      copied: false,
      message: null
    });
  };

  const handleSendInviteReminder = async () => {
    const d = reminderDraft;
    if (!d) return;
    const email = d.email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setReminderDraft({ ...d, message: { type: 'error', text: 'Enter a valid email address for the client.' } });
      return;
    }
    try {
      setReminderDraft({ ...d, busy: true, message: null });
      const token = await auth.currentUser.getIdToken();
      const res = await fetch('/api/send-invite-reminder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ clientId: d.clientId, email, subject: d.subject, body: d.body })
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 404) {
        throw new Error('The email service is not available here. It works on your deployed site. You can use "Copy message" instead.');
      }
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      await fetchCoachData(user.uid);
      setReminderDraft((prev) =>
        prev ? { ...prev, busy: false, message: { type: 'success', text: `Reminder sent to ${email}.` } } : prev
      );
    } catch (error) {
      console.error('Error sending reminder:', error);
      setReminderDraft((prev) =>
        prev ? { ...prev, busy: false, message: { type: 'error', text: error.message } } : prev
      );
    }
  };

  const handleCopyReminder = async () => {
    if (!reminderDraft) return;
    try {
      await navigator.clipboard.writeText(`Subject: ${reminderDraft.subject}\n\n${reminderDraft.body}`);
      setReminderDraft((prev) => (prev ? { ...prev, copied: true } : prev));
      setTimeout(() => setReminderDraft((prev) => (prev ? { ...prev, copied: false } : prev)), 2500);
    } catch (error) {
      console.error('Copy failed:', error);
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

  // Apply and remember the theme and language
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try {
      window.localStorage.setItem('coachflow-theme', theme);
    } catch (err) {
      console.error('Could not save theme:', err);
    }
  }, [theme]);

  useEffect(() => {
    try {
      window.localStorage.setItem('coachflow-language', language);
    } catch (err) {
      console.error('Could not save language:', err);
    }
  }, [language]);

  useEffect(() => {
    document.title = 'BodUp';
  }, []);

  const handleAccountCreated = ({ name }) => {
    setCoachProfile({ displayName: name });
    setOnboardingComplete(false);
    setOnboardingStep(2);
    setOnboardingData({});
    setUserRole('coach');
  };

  // Removes an account that is being started again (for example a wrong email)
  const handleStartOver = async () => {
    const current = auth.currentUser;
    try {
      if (current) {
        await deleteDoc(doc(db, 'users', current.uid)).catch(() => {});
        await deleteDoc(doc(db, 'coaches', current.uid)).catch(() => {});
        await deleteUser(current);
      }
    } catch (err) {
      console.error('Could not remove the account:', err);
      setLoginNotice('We could not remove that account. Contact the BodUp admin.');
    }
    await handleSignOut();
    setAuthView('register');
  };

  const handleSaveCoachPhoto = async (dataUrl) => {
    try {
      setLoading(true);
      await setDoc(doc(db, 'users', user.uid), { photoUrl: dataUrl, lastUpdated: serverTimestamp() }, { merge: true });
      setCoachProfile((prev) => ({ ...(prev || {}), photoUrl: dataUrl }));
      setProfilePhotoEditing(false);
      setModalMessage({ type: 'success', text: 'Photo saved.' });
    } catch (error) {
      console.error('Error saving photo:', error);
      setModalMessage({ type: 'error', text: 'Could not save the photo. Try again.' });
    } finally {
      setLoading(false);
    }
  };

  // Site-wide settings (prices, partners, season, maintenance). Refreshed every minute.
  useEffect(() => {
    let alive = true;
    const pull = async () => {
      try {
        const res = await fetch('/api/public-config');
        const data = await res.json();
        if (!alive) return;
        setSiteConfig({ season: data.season || 'default', maintenance: data.maintenance || { enabled: false, message: '' } });
        if (Array.isArray(data.plans) && data.plans.length) setLivePlans(data.plans);
        if (Array.isArray(data.partners) && data.partners.length) setLivePartners(data.partners);
      } catch (err) {
        // Keep the built-in prices and settings if the server cannot be reached
      }
    };
    pull();
    const timer = setInterval(pull, 60 * 1000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  // Count one visit per browser session (totals only)
  useEffect(() => {
    try {
      if (window.sessionStorage.getItem('bodup-visit-counted')) return;
      window.sessionStorage.setItem('bodup-visit-counted', '1');
    } catch (err) {
      // Private browsing: count anyway
    }
    fetch('/api/public-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'visit' })
    }).catch(() => {});
  }, []);

  // During maintenance, anyone who is not an admin is signed out
  useEffect(() => {
    if (siteConfig.maintenance && siteConfig.maintenance.enabled && user && userRole && !isAdmin) {
      setMaintenanceBypass(false);
      handleSignOut();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteConfig.maintenance && siteConfig.maintenance.enabled, user, userRole, isAdmin]);

  // Season colours on the page
  useEffect(() => {
    document.documentElement.setAttribute('data-season', siteConfig.season || 'default');
  }, [siteConfig.season]);

  // ---- Billing (demo mode: nothing is charged) ----
  const fetchBilling = async (coachId) => {
    try {
      const [methodSnap, invoiceSnap, subSnap] = await Promise.all([
        getDocs(query(collection(db, 'paymentMethods'), where('coachId', '==', coachId))),
        getDocs(query(collection(db, 'payments'), where('coachId', '==', coachId))),
        getDoc(doc(db, 'subscriptions', coachId))
      ]);
      const newestFirst = (a, b) => (toDate(b.createdAt)?.getTime() || 0) - (toDate(a.createdAt)?.getTime() || 0);
      setBilling({
        methods: methodSnap.docs.map((d) => ({ id: d.id, ...d.data() })).sort(newestFirst),
        invoices: invoiceSnap.docs.map((d) => ({ id: d.id, ...d.data() })).sort(newestFirst),
        subscription: subSnap.exists() ? { id: subSnap.id, ...subSnap.data() } : null
      });
    } catch (error) {
      console.error('Error fetching billing data:', error);
    }
  };

  const openModal = (name) => {
    setModalMessage(null);
    setActiveModal(name);
  };

  const applyCoupon = async () => {
    setCouponMsg(null);
    try {
      const res = await adminCall('couponCheck', { code: couponInput.trim(), planId: checkoutPlanId });
      if (res.valid) {
        setAppliedCoupon(res);
        setCouponMsg({ type: 'success', text: `${res.label} applied.` });
      } else {
        setAppliedCoupon(null);
        setCouponMsg({ type: 'error', text: res.reason || 'This code cannot be used.' });
      }
    } catch (err) {
      setCouponMsg({ type: 'error', text: err.message });
    }
  };

  const closeModal = () => {
    setActiveModal(null);
    setModalMessage(null);
    setCheckoutPlanId(null);
    setCloseConfirm('');
    setCouponInput('');
    setAppliedCoupon(null);
    setCouponMsg(null);
  };

  const openCheckout = (planId) => {
    const preferred = billing.methods.find((m) => m.isDefault) || billing.methods[0];
    setCheckoutPlanId(planId);
    setSelectedMethodId(preferred ? preferred.id : '');
    openModal('checkout');
  };

  const handleAddCard = async (e) => {
    e.preventDefault();
    const form = e.target;
    const fd = new FormData(form);
    const holder = String(fd.get('holder') || '').trim();
    const number = String(fd.get('number') || '').replace(/\s+/g, '');
    const expiry = String(fd.get('expiry') || '').trim();
    const cvc = String(fd.get('cvc') || '').trim();
    const exp = parseExpiry(expiry);

    if (!holder) {
      setModalMessage({ type: 'error', text: 'Enter the name shown on the card.' });
      return;
    }
    if (!/^\d{13,19}$/.test(number) || !luhnValid(number)) {
      setModalMessage({ type: 'error', text: 'That card number does not look right. Check it and try again.' });
      return;
    }
    if (!exp) {
      setModalMessage({ type: 'error', text: 'Enter a valid expiry date that has not passed, as MM/YY.' });
      return;
    }
    if (!/^\d{3,4}$/.test(cvc)) {
      setModalMessage({ type: 'error', text: 'Enter the 3 or 4 digit security code.' });
      return;
    }

    try {
      setBillingBusy(true);
      // Only the brand, last four digits and expiry are stored. The full number and security code are never saved.
      const newMethod = await addDoc(collection(db, 'paymentMethods'), {
        coachId: user.uid,
        holder,
        brand: detectBrand(number),
        last4: number.slice(-4),
        expMonth: exp.month,
        expYear: exp.year,
        isDefault: billing.methods.length === 0,
        createdAt: serverTimestamp()
      });
      await fetchBilling(user.uid);
      if (checkoutPlanId) {
        setSelectedMethodId(newMethod.id);
        setModalMessage(null);
        setActiveModal('checkout');
      } else {
        closeModal();
      }
    } catch (error) {
      console.error('Error saving payment method:', error);
      setModalMessage({ type: 'error', text: 'Could not save the payment method. Try again.' });
    } finally {
      setBillingBusy(false);
    }
  };

  const handleSetDefaultMethod = async (methodId) => {
    try {
      setBillingBusy(true);
      await Promise.all(
        billing.methods.map((m) => updateDoc(doc(db, 'paymentMethods', m.id), { isDefault: m.id === methodId }))
      );
      await fetchBilling(user.uid);
    } catch (error) {
      console.error('Error updating default method:', error);
    } finally {
      setBillingBusy(false);
    }
  };

  const handleRemoveMethod = async (method) => {
    if (!window.confirm(`Remove the ${BRAND_LABEL[method.brand] || 'card'} ending ${method.last4}?`)) return;
    try {
      setBillingBusy(true);
      await deleteDoc(doc(db, 'paymentMethods', method.id));
      const remaining = billing.methods.filter((m) => m.id !== method.id);
      if (method.isDefault && remaining.length > 0) {
        await updateDoc(doc(db, 'paymentMethods', remaining[0].id), { isDefault: true });
      }
      await fetchBilling(user.uid);
    } catch (error) {
      console.error('Error removing payment method:', error);
    } finally {
      setBillingBusy(false);
    }
  };

  const handleSubscribe = async () => {
    const plan = livePlans.find((p) => p.id === checkoutPlanId);
    const method = billing.methods.find((m) => m.id === selectedMethodId);
    if (!plan || !method) {
      setModalMessage({ type: 'error', text: 'Choose a payment method to continue.' });
      return;
    }

    const methodLabel = `${BRAND_LABEL[method.brand] || 'Card'} ending ${method.last4}`;
    const amount = appliedCoupon ? appliedCoupon.discounted : plan.price;
    try {
      setBillingBusy(true);
      await setDoc(doc(db, 'subscriptions', user.uid), {
        coachId: user.uid,
        planId: plan.id,
        planName: plan.name,
        price: amount,
        couponCode: appliedCoupon ? appliedCoupon.code : null,
        currency: 'EUR',
        status: 'active',
        methodId: method.id,
        methodLabel,
        startedAt: serverTimestamp(),
        nextBillingDate: new Date(Date.now() + 30 * DAY_MS),
        mode: 'demo'
      });
      await addDoc(collection(db, 'payments'), {
        coachId: user.uid,
        invoiceNumber: makeInvoiceNumber(),
        planId: plan.id,
        planName: plan.name,
        amount,
        currency: 'EUR',
        status: 'paid',
        methodLabel,
        mode: 'demo',
        createdAt: serverTimestamp()
      });
      if (appliedCoupon) {
        try {
          await adminCall('couponRedeem', { code: appliedCoupon.code, planId: plan.id });
        } catch (err) {
          console.error('Coupon could not be counted:', err);
        }
      }
      await fetchBilling(user.uid);
      closeModal();
    } catch (error) {
      console.error('Error starting subscription:', error);
      setModalMessage({ type: 'error', text: 'Could not start the subscription. Try again.' });
    } finally {
      setBillingBusy(false);
    }
  };

  const handleCancelSubscription = async () => {
    if (!window.confirm('Cancel your subscription? It stays active until the end of the current billing period.')) return;
    try {
      setBillingBusy(true);
      await updateDoc(doc(db, 'subscriptions', user.uid), { status: 'cancelled', cancelledAt: serverTimestamp() });
      await fetchBilling(user.uid);
    } catch (error) {
      console.error('Error cancelling subscription:', error);
    } finally {
      setBillingBusy(false);
    }
  };

  // ---- Settings: profile, admin message, close account ----
  const handleSaveCoachProfile = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const displayName = String(fd.get('displayName') || '').trim();
    const phone = String(fd.get('phone') || '').trim();
    const businessName = String(fd.get('businessName') || '').trim();
    if (!displayName) {
      setModalMessage({ type: 'error', text: 'Your name cannot be empty.' });
      return;
    }
    try {
      setLoading(true);
      await setDoc(doc(db, 'users', user.uid), { displayName, phone, businessName }, { merge: true });
      await setDoc(doc(db, 'coaches', user.uid), { name: displayName, phone, businessName }, { merge: true });
      setCoachProfile((prev) => ({ ...(prev || {}), displayName, phone, businessName }));
      setModalMessage({ type: 'success', text: 'Profile updated.' });
    } catch (error) {
      console.error('Error updating profile:', error);
      setModalMessage({ type: 'error', text: 'Could not update your profile. Try again.' });
    } finally {
      setLoading(false);
    }
  };

  const handleSendAdminMessage = async (e) => {
    e.preventDefault();
    const form = e.target;
    const fd = new FormData(form);
    const subject = String(fd.get('subject') || '').trim();
    const message = String(fd.get('message') || '').trim();
    if (!subject || !message) {
      setModalMessage({ type: 'error', text: 'Add a subject and a message.' });
      return;
    }
    try {
      setLoading(true);
      await addDoc(collection(db, 'adminMessages'), {
        coachId: user.uid,
        role: userRole,
        name: coachProfile?.displayName || user.displayName || '',
        email: user.email || '',
        subject,
        message,
        status: 'new',
        createdAt: serverTimestamp()
      });
      form.reset();
      setModalMessage({ type: 'success', text: 'Message sent. The admin will reply to your account email.' });
    } catch (error) {
      console.error('Error sending admin message:', error);
      setModalMessage({ type: 'error', text: 'Could not send your message. Try again.' });
    } finally {
      setLoading(false);
    }
  };

  const handleCloseAccount = async () => {
    if (closeConfirm !== 'CLOSE') return;
    try {
      setLoading(true);
      await setDoc(doc(db, 'users', user.uid), { status: 'closed', closedAt: serverTimestamp() }, { merge: true });
      if (userRole === 'coach') {
        await setDoc(doc(db, 'coaches', user.uid), { status: 'closed', closedAt: serverTimestamp() }, { merge: true });
      } else {
        const record = clientRecord || (await getClientRecord(user.uid));
        if (record) {
          await updateDoc(doc(db, 'clients', record.id), {
            accountClosed: true,
            programmeStatus: 'completed',
            completedAt: serverTimestamp()
          });
        }
      }
      closeModal();
      await handleSignOut();
      setLoginNotice('Your account has been closed. Contact the BodUp admin if you need it reopened.');
    } catch (error) {
      console.error('Error closing account:', error);
      setModalMessage({ type: 'error', text: 'Could not close your account. Try again.' });
    } finally {
      setLoading(false);
    }
  };

  // ---- Calendar, feedback sessions and automated messages ----
  const fetchCalendar = async (coachId) => {
    try {
      const [eventSnap, outboxSnap] = await Promise.all([
        getDocs(query(collection(db, 'calendarEvents'), where('coachId', '==', coachId))),
        getDocs(query(collection(db, 'scheduledEmails'), where('coachId', '==', coachId)))
      ]);
      setCalendarEvents(eventSnap.docs.map((d) => ({ id: d.id, ...d.data() })));
      setOutbox(outboxSnap.docs.map((d) => ({ id: d.id, ...d.data() })));
    } catch (error) {
      console.error('Error fetching calendar data:', error);
    }
  };

  const currentCoachName = () => coachProfile?.displayName || user?.displayName || user?.email || 'Coach';
  const googleReady = () => !!googleAccess && googleAccess.expiresAt > Date.now();
  const getClientView = (clientId) => {
    const c = clients.find((x) => x.id === clientId);
    return c ? decorateClient(c, clientData) : null;
  };

  const handleConnectGoogle = async () => {
    try {
      const provider = new GoogleAuthProvider();
      provider.addScope(GOOGLE_CAL_SCOPE);
      provider.setCustomParameters({ login_hint: user.email || '' });
      const result = await reauthenticateWithPopup(auth.currentUser, provider);
      const credential = GoogleAuthProvider.credentialFromResult(result);
      if (!credential || !credential.accessToken) throw new Error('Google did not return an access token.');
      // The token lives in memory only and lasts about an hour
      setGoogleAccess({ token: credential.accessToken, expiresAt: Date.now() + 55 * 60 * 1000 });
      setCalendarNotice({ type: 'success', text: 'Google Calendar is connected for about an hour.' });
      setScheduleDraft((prev) => (prev ? { ...prev, message: null } : prev));
    } catch (error) {
      console.error('Google connect failed:', error);
      setCalendarNotice({
        type: 'error',
        text: 'Could not connect Google Calendar. Check that the Calendar API is enabled and your account is a test user (see SETUP.md).'
      });
    }
  };

  const buildScheduleTexts = (d) => {
    const c = getClientView(d.clientId);
    if (!c) return { clientSubject: '', clientBody: '', coachSubject: '', coachBody: '' };
    const whenText = formatWhen(d.date, d.time);
    const meetToken = d.type === 'meet' ? d.manualMeetLink.trim() || '{{MEET_LINK}}' : '';
    const coachName = currentCoachName();
    const client = buildFeedbackEmail({ coachName, client: c, whenText, type: d.type, meetToken });
    const coach = buildCoachReminder({ coachName, client: c, whenText, type: d.type, meetToken });
    return {
      clientSubject: client.subject,
      clientBody: client.body,
      coachSubject: coach.subject,
      coachBody: coach.body
    };
  };

  const openSchedule = (clientId = '') => {
    const base = {
      clientId,
      type: 'meet',
      date: toDateKey(new Date(Date.now() + DAY_MS)),
      time: '10:00',
      duration: 30,
      remindDays: 1,
      sendClientEmail: true,
      manualMeetLink: '',
      edited: { client: false, coach: false },
      message: null
    };
    setScheduleDraft({ ...base, ...buildScheduleTexts(base) });
    setEmailTab('client');
    setEmailEditing(false);
  };

  // Changing a field regenerates any message text the coach has not edited by hand
  const updateDraft = (patch) =>
    setScheduleDraft((prev) => {
      if (!prev) return prev;
      const next = { ...prev, ...patch, message: null };
      const texts = buildScheduleTexts(next);
      return {
        ...next,
        ...(next.edited.client ? {} : { clientSubject: texts.clientSubject, clientBody: texts.clientBody }),
        ...(next.edited.coach ? {} : { coachSubject: texts.coachSubject, coachBody: texts.coachBody })
      };
    });

  const editDraftText = (which, field, value) =>
    setScheduleDraft((prev) =>
      prev ? { ...prev, [field]: value, edited: { ...prev.edited, [which]: true }, message: null } : prev
    );

  const setDraftMessage = (message) => setScheduleDraft((prev) => (prev ? { ...prev, message } : prev));

  const handleScheduleSave = async () => {
    const d = scheduleDraft;
    if (!d) return;
    const c = getClientView(d.clientId);
    if (!c) {
      setDraftMessage({ type: 'error', text: 'Choose a client first.' });
      return;
    }
    const start = new Date(`${d.date}T${d.time}`);
    if (isNaN(start.getTime())) {
      setDraftMessage({ type: 'error', text: 'Enter a valid date and time.' });
      return;
    }
    if (d.date < toDateKey(new Date())) {
      setDraftMessage({ type: 'error', text: 'Pick today or a future date.' });
      return;
    }
    const connected = googleReady();
    if (d.type === 'meet' && !connected && !d.manualMeetLink.trim()) {
      setDraftMessage({
        type: 'error',
        text: 'Connect Google Calendar to create the Meet link automatically, or paste an existing Meet link.'
      });
      return;
    }

    const end = new Date(start.getTime() + (d.type === 'meet' ? d.duration : 30) * 60000);
    try {
      setCalendarBusy(true);
      let meetLink = d.manualMeetLink.trim();
      let googleEventId = null;
      let googleHtmlLink = '';

      if (d.type === 'meet' && connected) {
        const created = await createGoogleMeetEvent({
          token: googleAccess.token,
          summary: `Feedback session - ${c.name}`,
          description: 'Scheduled with BodUp.',
          start,
          end,
          attendeeEmail: c.email
        });
        meetLink = created.meetLink || meetLink;
        googleEventId = created.eventId;
        googleHtmlLink = created.htmlLink;
      }

      const fill = (text) => text.split('{{MEET_LINK}}').join(meetLink || '(Google Meet link to follow)');
      const eventRef = await addDoc(collection(db, 'calendarEvents'), {
        coachId: user.uid,
        clientId: c.id,
        clientName: c.name,
        type: d.type,
        title: `Feedback: ${c.name}`,
        startAt: start,
        endAt: end,
        dateKey: d.date,
        duration: d.type === 'meet' ? d.duration : null,
        meetLink,
        googleEventId,
        googleHtmlLink,
        status: 'scheduled',
        createdAt: serverTimestamp()
      });

      const base = {
        coachId: user.uid,
        clientId: c.id,
        calendarEventId: eventRef.id,
        fromName: currentCoachName(),
        replyTo: user.email || '',
        status: 'scheduled',
        recurring: false,
        createdAt: serverTimestamp()
      };

      let clientEmailId = null;
      if (d.sendClientEmail && c.email) {
        const ref = await addDoc(collection(db, 'scheduledEmails'), {
          ...base,
          kind: 'feedback',
          audience: 'client',
          toPreview: c.email,
          sendOn: d.date,
          subject: d.clientSubject,
          body: fill(d.clientBody)
        });
        clientEmailId = ref.id;
      }

      let remindOn = addDaysKey(d.date, -d.remindDays);
      const todayKey = toDateKey(new Date());
      if (remindOn < todayKey) remindOn = todayKey;
      const reminderRef = await addDoc(collection(db, 'scheduledEmails'), {
        ...base,
        kind: 'coach-reminder',
        audience: 'coach',
        toPreview: user.email || '',
        sendOn: remindOn,
        subject: d.coachSubject,
        body: fill(d.coachBody)
      });

      await updateDoc(eventRef, { clientEmailId, reminderEmailId: reminderRef.id });
      await fetchCalendar(user.uid);
      setScheduleDraft(null);
      setCalendarNotice({
        type: 'success',
        text: `Feedback with ${c.name} added for ${formatWhen(d.date, d.time)}.`
      });
    } catch (error) {
      console.error('Error scheduling feedback:', error);
      if (error.message === 'GOOGLE_AUTH_EXPIRED') {
        setGoogleAccess(null);
        setDraftMessage({ type: 'error', text: 'Your Google connection expired. Connect again and save.' });
      } else {
        setDraftMessage({ type: 'error', text: `Could not schedule this: ${error.message}` });
      }
    } finally {
      setCalendarBusy(false);
    }
  };

  const handleMarkEventDone = async (ev) => {
    try {
      setCalendarBusy(true);
      await updateDoc(doc(db, 'calendarEvents', ev.id), { status: 'done' });
      await fetchCalendar(user.uid);
      setSelectedEventId(null);
    } catch (error) {
      console.error('Error updating event:', error);
    } finally {
      setCalendarBusy(false);
    }
  };

  const handleDeleteEvent = async (ev) => {
    if (!window.confirm('Delete this calendar entry? Emails that have not been sent yet will be cancelled.')) return;
    try {
      setCalendarBusy(true);
      let googleNote = '';
      if (ev.googleEventId) {
        if (googleReady()) {
          try {
            await deleteGoogleEvent({ token: googleAccess.token, eventId: ev.googleEventId });
          } catch (err) {
            googleNote = ' The Google Calendar event could not be removed - delete it in Google Calendar.';
          }
        } else {
          googleNote = ' The Google Calendar event stays until you delete it in Google Calendar.';
        }
      }
      const linked = outbox.filter((m) => m.calendarEventId === ev.id && m.status === 'scheduled');
      await Promise.all(linked.map((m) => updateDoc(doc(db, 'scheduledEmails', m.id), { status: 'cancelled' })));
      await deleteDoc(doc(db, 'calendarEvents', ev.id));
      await fetchCalendar(user.uid);
      setSelectedEventId(null);
      setCalendarNotice({ type: 'success', text: `Calendar entry deleted.${googleNote}` });
    } catch (error) {
      console.error('Error deleting event:', error);
      setCalendarNotice({ type: 'error', text: 'Could not delete the entry. Try again.' });
    } finally {
      setCalendarBusy(false);
    }
  };

  // ---- Opt-in automations (switched on by the coach, with a consent confirmation) ----
  const optInSendOn = (kind, client) => {
    if (kind === 'birthday') return nextBirthdayKey(client.dateOfBirth);
    if (kind === 'christmas') return nextChristmasKey();
    return toDateKey(new Date());
  };

  const buildOptInTexts = (kind, c) => {
    const coachName = currentCoachName();
    if (kind === 'birthday') return buildBirthdayEmail({ coachName, client: c });
    if (kind === 'christmas') return buildChristmasEmail({ coachName, client: c });
    const partner = livePartners.find((p) => p.id === kind);
    return buildPartnerEmail({ coachName, client: c, partner });
  };

  const openOptIn = (clientId, kind, enable) => {
    const c = getClientView(clientId);
    if (!c) return;
    const texts = enable ? buildOptInTexts(kind, c) : { subject: '', body: '' };
    setOptInDraft({ clientId, kind, enable, subject: texts.subject, body: texts.body, confirmed: false, message: null });
    setEmailEditing(false);
  };

  const handleOptInSave = async () => {
    const d = optInDraft;
    if (!d) return;
    const c = getClientView(d.clientId);
    if (!c) return;
    const isPartner = d.kind !== 'birthday' && d.kind !== 'christmas';
    const mailKind = isPartner ? 'partner' : d.kind;
    const fail = (text) => setOptInDraft((prev) => (prev ? { ...prev, message: { type: 'error', text } } : prev));

    if (d.enable) {
      if (!d.confirmed) {
        fail('Please confirm that the client has agreed to receive this.');
        return;
      }
      if (!c.email) {
        fail('This client has no email address on file yet.');
        return;
      }
      if (d.kind === 'birthday' && !c.dateOfBirth) {
        fail('Add the client date of birth first.');
        return;
      }
    }

    try {
      setCalendarBusy(true);
      const pending = outbox.filter(
        (m) =>
          m.clientId === c.id &&
          m.kind === mailKind &&
          m.status === 'scheduled' &&
          (!isPartner || m.partnerId === d.kind)
      );

      if (!d.enable) {
        await Promise.all(pending.map((m) => updateDoc(doc(db, 'scheduledEmails', m.id), { status: 'cancelled' })));
        await updateDoc(doc(db, 'clients', c.id), {
          [`optIns.${d.kind}`]: { enabled: false, updatedAt: serverTimestamp() }
        });
      } else {
        await updateDoc(doc(db, 'clients', c.id), {
          [`optIns.${d.kind}`]: {
            enabled: true,
            confirmedByCoach: true,
            confirmedAt: serverTimestamp(),
            updatedAt: serverTimestamp()
          }
        });
        const alreadySent =
          isPartner &&
          outbox.some((m) => m.clientId === c.id && m.kind === 'partner' && m.partnerId === d.kind && m.status === 'sent');
        if (pending.length === 0 && !alreadySent) {
          await addDoc(collection(db, 'scheduledEmails'), {
            coachId: user.uid,
            clientId: c.id,
            kind: mailKind,
            partnerId: isPartner ? d.kind : null,
            audience: 'client',
            fromName: currentCoachName(),
            replyTo: user.email || '',
            toPreview: c.email,
            sendOn: optInSendOn(d.kind, c),
            recurring: d.kind === 'birthday' || d.kind === 'christmas',
            subject: d.subject,
            body: d.body,
            status: 'scheduled',
            createdAt: serverTimestamp()
          });
        }
      }

      await fetchCoachData(user.uid);
      await fetchCalendar(user.uid);
      setOptInDraft(null);
    } catch (error) {
      console.error('Error saving opt-in:', error);
      fail('Could not save this. Try again.');
    } finally {
      setCalendarBusy(false);
    }
  };

  const handleSaveDob = async (e, c) => {
    e.preventDefault();
    const dob = String(new FormData(e.target).get('dob') || '');
    try {
      setCalendarBusy(true);
      await updateDoc(doc(db, 'clients', c.id), { dateOfBirth: dob || null });
      const pending = outbox.filter((m) => m.clientId === c.id && m.kind === 'birthday' && m.status === 'scheduled');
      await Promise.all(
        pending.map((m) =>
          dob
            ? updateDoc(doc(db, 'scheduledEmails', m.id), { sendOn: nextBirthdayKey(dob) })
            : updateDoc(doc(db, 'scheduledEmails', m.id), { status: 'cancelled' })
        )
      );
      await fetchCoachData(user.uid);
      await fetchCalendar(user.uid);
      setCalendarNotice({ type: 'success', text: 'Date of birth saved.' });
    } catch (error) {
      console.error('Error saving date of birth:', error);
      setCalendarNotice({ type: 'error', text: 'Could not save the date of birth.' });
    } finally {
      setCalendarBusy(false);
    }
  };

  // ---- Programme status ----
  const handleSetProgramme = async (c, completed) => {
    const text = completed
      ? `Mark ${c.name}'s programme as completed? Their upcoming feedback sessions and reminders will be cancelled. Google Calendar events are not removed.`
      : `Reopen ${c.name}'s programme?`;
    if (!window.confirm(text)) return;
    try {
      setCalendarBusy(true);
      await updateDoc(
        doc(db, 'clients', c.id),
        completed
          ? { programmeStatus: 'completed', completedAt: serverTimestamp() }
          : { programmeStatus: 'active', completedAt: null }
      );
      if (completed) {
        const events = calendarEvents.filter((ev) => ev.clientId === c.id && ev.status === 'scheduled');
        const mails = outbox.filter(
          (m) => m.clientId === c.id && m.status === 'scheduled' && (m.kind === 'feedback' || m.kind === 'coach-reminder')
        );
        await Promise.all([
          ...events.map((ev) => updateDoc(doc(db, 'calendarEvents', ev.id), { status: 'cancelled' })),
          ...mails.map((m) => updateDoc(doc(db, 'scheduledEmails', m.id), { status: 'cancelled' }))
        ]);
      }
      await fetchCoachData(user.uid);
      await fetchCalendar(user.uid);
    } catch (error) {
      console.error('Error updating programme:', error);
    } finally {
      setCalendarBusy(false);
    }
  };

  // ---- Plans: the free plan needs no card, paid plans go through checkout ----
  const handleSelectPlan = async (plan) => {
    if (plan.price > 0) {
      openCheckout(plan.id);
      return;
    }
    if (!window.confirm(`Switch to the ${plan.name} plan?`)) return;
    try {
      setBillingBusy(true);
      await setDoc(doc(db, 'subscriptions', user.uid), {
        coachId: user.uid,
        planId: plan.id,
        planName: plan.name,
        price: 0,
        currency: 'EUR',
        status: 'active',
        methodId: null,
        methodLabel: 'No payment needed',
        startedAt: serverTimestamp(),
        nextBillingDate: null,
        mode: 'demo'
      });
      await fetchBilling(user.uid);
    } catch (error) {
      console.error('Error switching plan:', error);
    } finally {
      setBillingBusy(false);
    }
  };

  if (siteConfig.maintenance && siteConfig.maintenance.enabled && !isAdmin && !maintenanceBypass) {
    return (
      <MaintenancePage
        message={siteConfig.maintenance.message}
        onAdminSignIn={() => {
          setAuthView('login');
          setMaintenanceBypass(true);
        }}
      />
    );
  }

  if (!user) {
    // Visitors see the landing page first. Log in and Register open the sign-in card.
    // A notice (for example "account closed") always opens the card so the message is seen.
    if (authView === 'landing' && !loginNotice) {
      return (
        <LandingPage
          plans={livePlans}
          language={language}
          onLanguage={setLanguage}
          onLogin={() => setAuthView('login')}
          onRegister={() => setAuthView('register')}
        />
      );
    }
    if (authView === 'register' && !loginNotice) {
      return (
        <AccountStep
          onBack={() => setAuthView('landing')}
          onSignIn={() => setAuthView('login')}
          onGoogle={handleGoogleSignIn}
          onCreated={handleAccountCreated}
          onInviteCode={() => {
            setLoginNotice('');
            setShowInviteCodeInput(true);
            setAuthView('login');
          }}
        />
      );
    }
    return (
      <div className="login-container">
        <div className="login-card">
          <button
            className="btn-back icon-text"
            onClick={() => {
              setLoginNotice('');
              setShowInviteCodeInput(false);
              setAuthView('landing');
            }}
          >
            <Icon name="back" size={16} /> Back to home
          </button>
          <BrandMark size={44} className="auth-brand" />
          <h1>Welcome back</h1>
          <p className="subtitle">Sign in to continue to BodUp.</p>
          {loginNotice && <p className="login-notice">{loginNotice}</p>}
          <EmailSignIn />
          <div className="onb-or"><span>or</span></div>
          <button className="google-btn" onClick={handleGoogleSignIn}>
            Sign in with Google
          </button>
          <p className="onb-switch">
            New to BodUp? <button className="link-btn" onClick={() => setAuthView('register')}>Create an account</button>
          </p>
          <button 
            className="btn-secondary" 
            onClick={() => setShowInviteCodeInput(!showInviteCodeInput)}
            style={{ marginTop: '20px' }}
          >
            I have an invite code
          </button>
          
          {showInviteCodeInput && (
            <div style={{ marginTop: '20px', padding: '20px', backgroundColor: 'var(--panel)', borderRadius: '12px' }}>
              <h3>Enter Invite Code</h3>
              <input
                type="text"
                placeholder="Enter your invite code"
                value={inviteCodeInput}
                onChange={(e) => {
                  setInviteCodeInput(e.target.value);
                  setInviteCodeError('');
                }}
                style={{ width: '100%', padding: '10px', marginBottom: '10px', borderRadius: '10px', border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)' }}
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

  if (userRole === 'admin') {
    return (
      <AdminPanel
        user={user}
        theme={theme}
        onToggleTheme={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        onSignOut={handleSignOut}
      />
    );
  }

  if (accountStatus === 'suspended') {
    return (
      <SuspendedPage user={user} onSignOut={handleSignOut} onSend={handleSendAdminMessage} message={modalMessage} loading={loading} />
    );
  }

  if (user && !userRole) {
    return <LoadingScreen onSignOut={handleSignOut} />;
  }

  if (userRole === 'coach' && onboardingComplete === false) {
    return (
      <OnboardingFlow
        key={user.uid}
        user={user}
        startStep={onboardingStep}
        startAnswers={onboardingData}
        onFinished={() => loadUserData(user.uid)}
        onStartOver={handleStartOver}
      />
    );
  }

  if (userRole === 'client' && !profile && currentPage === 'dashboard') {
    return (
      <div className="client-container">
        <header className="client-header">
          <h1><BrandMark size={30} /></h1>
          <div className="header-actions">
            <LanguageMenu language={language} onChange={setLanguage} />
            <button
              className="btn-icon"
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
              title={theme === 'dark' ? 'Light mode' : 'Dark mode'}
            >
              <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={18} />
            </button>
            <span className="user-email">{user.email}</span>
            <button className="btn-secondary" onClick={handleSignOut}>Sign out</button>
          </div>
        </header>

        <main className="client-main">
          <section className="section">
            <h2>Complete Your Profile</h2>
            <p className="section-subtitle">Help your coach understand your fitness background</p>

            {clientNotice && <p className={`form-message ${clientNotice.type}`}>{clientNotice.text}</p>}

            <form className="form" onSubmit={handleSaveProfile}>
              <ProfileFields profile={null} />
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
      .map((c) => decorateClient(c, clientData))
      .sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || (a.name || '').localeCompare(b.name || ''));

    const coachName = coachProfile?.displayName || user.displayName || user.email;
    const sidebarClients = [...decorated].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    const selectedClient = decorated.find((c) => c.id === selectedClientId);
    const activeTop = ['add-client', 'client-detail'].includes(currentPage) ? 'clients' : currentPage;
    const activeCount = decorated.filter((c) => c.accountStatus === 'active' && c.level !== 'completed').length;
    const pendingCount = decorated.filter((c) => c.accountStatus === 'pending').length;
    const inactiveClients = decorated
      .filter((c) => c.inactiveDays != null)
      .sort((a, b) => b.inactiveDays - a.inactiveDays);
    const completedClients = decorated.filter((c) => c.level === 'completed');
    const schedulable = decorated.filter((c) => c.accountStatus === 'active' && c.level !== 'completed');
    const googleOk = googleReady();
    const todayKey = toDateKey(new Date());
    const startMs = (ev) => toDate(ev.startAt)?.getTime() || 0;
    const monthGrid = buildMonthGrid(calendarMonth);
    const eventsByDay = {};
    calendarEvents
      .filter((ev) => ev.status !== 'cancelled')
      .sort((a, b) => startMs(a) - startMs(b))
      .forEach((ev) => {
        if (!eventsByDay[ev.dateKey]) eventsByDay[ev.dateKey] = [];
        eventsByDay[ev.dateKey].push(ev);
      });
    const upcomingEvents = calendarEvents
      .filter((ev) => ev.status === 'scheduled' && ev.dateKey >= todayKey)
      .sort((a, b) => startMs(a) - startMs(b))
      .slice(0, 8);
    const selectedEvent = calendarEvents.find((ev) => ev.id === selectedEventId);
    const draftClient = scheduleDraft ? decorated.find((c) => c.id === scheduleDraft.clientId) : null;
    const optInClient = optInDraft ? decorated.find((c) => c.id === optInDraft.clientId) : null;
    const reminderClient = reminderDraft ? decorated.find((c) => c.id === reminderDraft.clientId) : null;

    const optInRows = [
      { kind: 'birthday', label: 'Birthday wishes', desc: 'A personal birthday message every year.', icon: 'gift' },
      { kind: 'christmas', label: 'Christmas wishes', desc: 'A Christmas greeting on 24 December every year.', icon: 'star' },
      ...livePartners.map((p) => ({
        kind: p.id,
        label: p.name,
        desc: `A one-time introduction to ${p.name} from you.`,
        icon: 'mail'
      }))
    ];

    const automationNote = (clientId, kind) => {
      const isPartner = kind !== 'birthday' && kind !== 'christmas';
      const mails = outbox.filter(
        (m) => m.clientId === clientId && m.kind === (isPartner ? 'partner' : kind) && (!isPartner || m.partnerId === kind)
      );
      const next = mails.find((m) => m.status === 'scheduled');
      if (next) return `Next message: ${formatDate(parseDateKey(next.sendOn))}`;
      const sent = mails
        .filter((m) => m.status === 'sent')
        .sort((a, b) => (toDate(b.sentAt)?.getTime() || 0) - (toDate(a.sentAt)?.getTime() || 0))[0];
      return sent ? `Last sent ${formatDate(toDate(sent.sentAt))}` : '';
    };

    const previewFill = (text) =>
      text.split('{{MEET_LINK}}').join(googleOk ? '[Google Meet link - created when you schedule]' : '[Google Meet link]');
    const fromLabel = `${coachName} via BodUp`;

    const clientDate = (c) => toDate(c.createdAt) || new Date(0);
    const sparkCards = [
      {
        key: 'total',
        label: 'Total Clients',
        value: decorated.length,
        icon: 'users',
        tone: 'primary',
        series: cumulativeWeekly(decorated.map(clientDate))
      },
      {
        key: 'active',
        label: 'Active Clients',
        value: activeCount,
        icon: 'check',
        tone: 'blue',
        series: cumulativeWeekly(
          decorated.filter((c) => c.accountStatus === 'active' && c.level !== 'completed').map((c) => toDate(c.acceptedAt) || clientDate(c))
        )
      },
      {
        key: 'pending',
        label: 'Pending Invites',
        value: pendingCount,
        icon: 'mail',
        tone: 'red',
        series: cumulativeWeekly(decorated.filter((c) => c.accountStatus === 'pending').map(clientDate))
      }
    ];

    const checkInDates = decorated.flatMap((c) => c.checkIns.map((ci) => checkInDate(ci)).filter(Boolean));
    const chartPoints = bucketCheckIns(checkInDates, chartRange);
    const chartTotal = chartPoints.reduce((sum, p) => sum + p.value, 0);

    const subscription = billing.subscription;
    const currentPlanId = subscription && subscription.status === 'active' ? subscription.planId : null;
    const subPlan = subscription ? livePlans.find((p) => p.id === subscription.planId) : null;
    const subPrice = subPlan ? subPlan.price : subscription ? subscription.price : 0;
    const checkoutPlan = livePlans.find((p) => p.id === checkoutPlanId);

    const renderClientCard = (c, note) => (
      <div key={c.id} className="card-wrap">
      <button className={`activity-card level-${c.level}`} onClick={() => openClient(c.id)}>
        <div className="activity-card-head">
          <span className="client-avatar large">{initialOf(c.name)}</span>
          <div className="activity-card-title">
            <span className="activity-name">{c.name}</span>
            <span className="activity-sub">
              {note || (c.accountStatus === 'pending' ? 'Invite not redeemed yet' : describeLastCheckIn(c.lastCheckIn))}
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
      {c.accountStatus === 'active' && c.level !== 'completed' && (
        <button className="card-action" onClick={() => openSchedule(c.id)}>
          <Icon name="calendar" size={14} /> Add feedback to calendar
        </button>
      )}
      </div>
    );

    const renderLevelCard = (level) => {
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
                      <span className="activity-sub">
                        {c.accountStatus === 'pending' ? 'Invite not redeemed yet' : describeLastCheckIn(c.lastCheckIn)}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      );
    };

    const s = selectedClient ? selectedClient.stats : null;
    const sexLabel = { M: 'Male', F: 'Female', Other: 'Other' };

    return (
      <div className={`dashboard-container ${sidebarCollapsed ? 'collapsed' : ''}`}>
        <aside className="sidebar">
          <div className="sidebar-header">
            {!sidebarCollapsed && <h1><BrandMark size={30} /></h1>}
            <button
              className="sidebar-toggle"
              onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
              aria-label={sidebarCollapsed ? 'Expand menu' : 'Collapse menu'}
              title={sidebarCollapsed ? 'Expand menu' : 'Collapse menu'}
            >
              <Icon name={sidebarCollapsed ? 'expand' : 'collapse'} />
            </button>
          </div>

          <div className="coach-chip" title={coachName}>
            {coachProfile?.photoUrl ? <img className="coach-photo" src={coachProfile.photoUrl} alt="" /> : <span className="client-avatar coach-avatar">{initialOf(coachName)}</span>}
            <span className="nav-label coach-chip-text">
              <span className="coach-chip-name">{coachName}</span>
              <span className="coach-chip-role">Coach</span>
            </span>
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
              className={`nav-item ${currentPage === 'calendar' ? 'active' : ''}`}
              onClick={() => goTo('calendar')}
              title="Calendar"
            >
              <Icon name="calendar" />
              <span className="nav-label">Calendar</span>
            </button>
            <button
              className={`nav-item ${currentPage === 'chat' ? 'active' : ''}`}
              onClick={() => goTo('chat')}
              title="Chat"
            >
              <Icon name="chat" />
              <span className="nav-label">Chat</span>
            </button>
            <button
              className={`nav-item ${currentPage === 'payments' ? 'active' : ''}`}
              onClick={() => goTo('payments')}
              title="Payments"
            >
              <Icon name="card" />
              <span className="nav-label">Payments</span>
            </button>
            {isAdmin && (
              <button
                className={`nav-item ${currentPage === 'admin' ? 'active' : ''}`}
                onClick={() => goTo('admin')}
                title="Admin"
              >
                <Icon name="shield" />
                <span className="nav-label">Admin</span>
              </button>
            )}
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

        <div className="workspace">
          <header className="topbar">
            <div className="topbar-left" />
            <nav className="topnav" aria-label="Main">
              {(isAdmin ? [...TOP_NAV, { id: 'admin', label: 'Admin', icon: 'shield' }] : TOP_NAV).map((item) => (
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
              <LanguageMenu language={language} onChange={setLanguage} />
              <SettingsMenu
                theme={theme}
                onToggleTheme={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
                onOpenModal={openModal}
              />
            </div>
          </header>

          <main className="main-content">
            {currentPage === 'dashboard' && (
              <div className="dashboard-view">
                <div className="page-header">
                  <h2>Dashboard</h2>
                  <p>Welcome, {coachName}</p>
                  <FestiveBadge season={siteConfig.season} />
                </div>

                <div className="stats-grid">
                  {sparkCards.map((card) => {
                    const delta = card.series[card.series.length - 1] - card.series[card.series.length - 2];
                    return (
                      <div key={card.key} className="stat-card spark-card">
                        <div className="spark-top">
                          <span className={`spark-icon ${card.tone}`}><Icon name={card.icon} size={18} /></span>
                          <span className="spark-label">{card.label}</span>
                          <span className="spark-value">{card.value}</span>
                        </div>
                        <div className="spark-divider" />
                        <div className="spark-bottom">
                          <Sparkline values={card.series} tone={card.tone} />
                          <div className="spark-delta">
                            {delta > 0 ? (
                              <>
                                <strong>+{delta} more</strong>
                                <span>from last week</span>
                              </>
                            ) : (
                              <>
                                <strong className="flat">No change</strong>
                                <span>from last week</span>
                              </>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>

                <section className="section">
                  <div className="section-header">
                    <div>
                      <h3>Check-ins logged</h3>
                      <p className="section-subtitle section-subtitle-tight">
                        {chartTotal} {chartTotal === 1 ? 'check-in' : 'check-ins'} in this period, across all clients.
                      </p>
                    </div>
                    <div className="range-tabs" role="tablist" aria-label="Chart range">
                      {[
                        { id: 'daily', label: 'Daily' },
                        { id: 'weekly', label: 'Weekly' },
                        { id: 'monthly', label: 'Monthly' }
                      ].map((tab) => (
                        <button
                          key={tab.id}
                          role="tab"
                          aria-selected={chartRange === tab.id}
                          className={`range-tab ${chartRange === tab.id ? 'active' : ''}`}
                          onClick={() => setChartRange(tab.id)}
                        >
                          {tab.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <AreaChart points={chartPoints} />
                </section>

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
                    <div className="activity-grid">{decorated.map((c) => renderClientCard(c))}</div>
                  )}
                </section>
              </div>
            )}

            {currentPage === 'clients' && (
              <div className="dashboard-view">
                <div className="clients-bar">
                  <div className="clients-bar-left">
                    <h2>Client List</h2>
                    <p>{decorated.length} {decorated.length === 1 ? 'client' : 'clients'} in total</p>
                  </div>
                  <div className="seg clients-seg" role="group" aria-label="Client view">
                    {CLIENT_VIEWS.map((view) => (
                      <button
                        key={view.id}
                        className={`seg-btn ${clientView === view.id ? 'active' : ''}`}
                        aria-pressed={clientView === view.id}
                        onClick={() => setClientView(view.id)}
                      >
                        <Icon name={view.icon} size={16} />
                        <span>{view.label}</span>
                        {view.id === 'inactive' && inactiveClients.length > 0 && (
                          <span className="seg-count">{inactiveClients.length}</span>
                        )}
                        {view.id === 'completed' && completedClients.length > 0 && (
                          <span className="seg-count">{completedClients.length}</span>
                        )}
                      </button>
                    ))}
                  </div>
                  <div className="clients-bar-right">
                    <button className="btn-primary" onClick={() => goTo('add-client')}>+ Add Client</button>
                  </div>
                </div>

                {decorated.length === 0 ? (
                  <section className="section">
                    <p className="empty-state">No clients yet. Add your first client to get started.</p>
                  </section>
                ) : (
                  <>
                    {clientView === 'overview' && <div className="activity-grid">{decorated.map((c) => renderClientCard(c))}</div>}

                    {clientView === 'list' && (
                      <section className="section">
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
                      </section>
                    )}

                    {clientView === 'segments' && (
                      <div className="analytics-grid segments-grid">
                        {['green', 'yellow', 'red', 'pending', 'completed'].map(renderLevelCard)}
                      </div>
                    )}

                    {clientView === 'inactive' && (
                      <>
                        <p className="view-hint">
                          Clients with no check-in for {INACTIVE_DAYS} days or more. A short feedback session is often all it takes to bring them back.
                        </p>
                        {inactiveClients.length === 0 ? (
                          <section className="section">
                            <p className="empty-state">No inactive clients. Everyone has checked in within the last {INACTIVE_DAYS} days.</p>
                          </section>
                        ) : (
                          <div className="activity-grid">
                            {inactiveClients.map((c) => renderClientCard(c, `Inactive for ${c.inactiveDays} days`))}
                          </div>
                        )}
                      </>
                    )}

                    {clientView === 'completed' && (
                      <>
                        <p className="view-hint">
                          Clients whose programme you have marked as completed. Open a client to reopen their programme.
                        </p>
                        {completedClients.length === 0 ? (
                          <section className="section">
                            <p className="empty-state">No completed programmes yet. Mark a programme as completed from the client page.</p>
                          </section>
                        ) : (
                          <div className="activity-grid">
                            {completedClients.map((c) =>
                              renderClientCard(c, c.accountClosed ? 'Closed their own account' : `Completed ${formatDate(toDate(c.completedAt))}`)
                            )}
                          </div>
                        )}
                      </>
                    )}
                  </>
                )}
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
                <div className="analytics-grid">{['green', 'yellow', 'red'].map(renderLevelCard)}</div>
              </div>
            )}

            {currentPage === 'calendar' && (
              <div className="dashboard-view">
                <div className="page-header page-header-row">
                  <div>
                    <h2>Calendar</h2>
                    <p>Feedback sessions and reminders for your clients.</p>
                  </div>
                  <div className="page-header-actions">
                    {googleOk ? (
                      <span className="badge active">Google connected</span>
                    ) : (
                      <button className="btn-secondary" onClick={handleConnectGoogle}>Connect Google Calendar</button>
                    )}
                    <button className="btn-primary" onClick={() => openSchedule('')}>+ Schedule feedback</button>
                  </div>
                </div>

                {calendarNotice && <p className={`form-message ${calendarNotice.type}`}>{calendarNotice.text}</p>}

                <section className="section calendar-section">
                  <div className="cal-toolbar">
                    <div className="cal-nav">
                      <button
                        className="btn-icon"
                        aria-label="Previous month"
                        onClick={() => setCalendarMonth(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1))}
                      >
                        <Icon name="back" size={16} />
                      </button>
                      <button
                        className="btn-icon"
                        aria-label="Next month"
                        onClick={() => setCalendarMonth(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1))}
                      >
                        <Icon name="expand" size={16} />
                      </button>
                      <h3 className="cal-title">
                        {calendarMonth.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
                      </h3>
                    </div>
                    <button
                      className="btn-secondary"
                      onClick={() => {
                        const n = new Date();
                        setCalendarMonth(new Date(n.getFullYear(), n.getMonth(), 1));
                      }}
                    >
                      Today
                    </button>
                  </div>

                  <div className="cal-grid cal-weekdays">
                    {WEEKDAYS.map((w) => (
                      <div key={w}>{w}</div>
                    ))}
                  </div>
                  <div className="cal-grid">
                    {monthGrid.map((cell) => {
                      const dayEvents = eventsByDay[cell.key] || [];
                      const birthdays = decorated.filter(
                        (c) => c.dateOfBirth && c.dateOfBirth.slice(5) === cell.key.slice(5)
                      );
                      return (
                        <div
                          key={cell.key}
                          className={`cal-cell ${cell.inMonth ? '' : 'muted'} ${cell.key === todayKey ? 'today' : ''}`}
                        >
                          <span className="cal-day">{cell.date.getDate()}</span>
                          {dayEvents.slice(0, 3).map((ev) => (
                            <button
                              key={ev.id}
                              className={`cal-chip ${ev.type} ${ev.status}`}
                              onClick={() => setSelectedEventId(ev.id)}
                              title={`${ev.clientName} - ${formatTime(toDate(ev.startAt))}`}
                            >
                              <Icon name={ev.type === 'meet' ? 'video' : 'mail'} size={12} />
                              <span>{formatTime(toDate(ev.startAt))} {ev.clientName}</span>
                            </button>
                          ))}
                          {dayEvents.length > 3 && <span className="cal-more">+{dayEvents.length - 3} more</span>}
                          {birthdays.map((c) => (
                            <span key={c.id} className="cal-chip birthday" title={`${c.name}'s birthday`}>
                              <Icon name="gift" size={12} />
                              <span>{firstName(c.name)}</span>
                            </span>
                          ))}
                        </div>
                      );
                    })}
                  </div>
                </section>

                <section className="section">
                  <h3>Upcoming feedback</h3>
                  {upcomingEvents.length === 0 ? (
                    <p className="empty-state">
                      Nothing scheduled yet. Use "Schedule feedback" or open a client and choose "Add feedback to calendar".
                    </p>
                  ) : (
                    <ul className="upcoming-list">
                      {upcomingEvents.map((ev) => (
                        <li key={ev.id}>
                          <button className="upcoming-item" onClick={() => setSelectedEventId(ev.id)}>
                            <span className={`upcoming-icon ${ev.type}`}>
                              <Icon name={ev.type === 'meet' ? 'video' : 'mail'} size={16} />
                            </span>
                            <span className="upcoming-main">
                              <span className="activity-name">{ev.clientName}</span>
                              <span className="activity-sub">
                                {formatWhen(ev.dateKey, formatTime(toDate(ev.startAt)))}
                              </span>
                            </span>
                            <span className="badge">{ev.type === 'meet' ? 'Google Meet' : 'Email'}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <p className="field-hint">
                    Reminder and client emails are sent by a daily run, around 07:00 to 08:00 Estonian time.
                  </p>
                </section>
              </div>
            )}

            {currentPage === 'chat' && <CoachChat />}

            {currentPage === 'admin' && isAdmin && (
              <AdminPanel
                embedded
                user={user}
                theme={theme}
                onToggleTheme={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
                onSignOut={handleSignOut}
              />
            )}

            {currentPage === 'payments' && (
              <div className="dashboard-view payments-view">
                <div className="page-header">
                  <h2>Payments</h2>
                  <p>Manage your BodUp plan, payment methods and invoices.</p>
                </div>

                <div className="notice-banner">
                  <Icon name="alert" size={18} />
                  <span>Demo mode. Plans and invoices are recorded, but no real charges are made yet.</span>
                </div>

                <section className="section">
                  <h3>Current plan</h3>
                  {subscription ? (
                    <div className="current-plan">
                      <div>
                        <div className="current-plan-name">
                          {subPlan ? subPlan.name : subscription.planName}
                          <span className={`badge ${subscription.status === 'active' ? 'active' : 'pending'}`}>
                            {subscription.status === 'active' ? 'active' : 'cancelled'}
                          </span>
                        </div>
                        <p className="section-subtitle section-subtitle-tight">
                          {subPrice === 0
                            ? 'No payment needed. You can upgrade to Pro at any time.'
                            : `${formatMoney(subPrice, subscription.currency)} per month, paid with ${subscription.methodLabel}.${
                                subscription.status === 'active'
                                  ? ` Next payment on ${formatDate(toDate(subscription.nextBillingDate))}.`
                                  : ` Access continues until ${formatDate(toDate(subscription.nextBillingDate))}.`
                              }`}
                        </p>
                      </div>
                      {subscription.status === 'active' && subPrice > 0 && (
                        <button className="btn-secondary" onClick={handleCancelSubscription} disabled={billingBusy}>
                          Cancel plan
                        </button>
                      )}
                    </div>
                  ) : (
                    <p className="empty-state">You do not have a plan yet. Choose one below to get started.</p>
                  )}
                </section>

                <div className="plans-grid">
                  {livePlans.map((plan) => {
                    const isCurrent = currentPlanId === plan.id;
                    return (
                      <section key={plan.id} className={`plan-card ${isCurrent ? 'current' : ''}`}>
                        <div className="plan-head">
                          <h3>{plan.name}</h3>
                          {isCurrent && <span className="badge active">current</span>}
                        </div>
                        <p className="plan-tagline">{plan.tagline}</p>
                        <div className="plan-price">
                          {plan.price === 0 ? 'Free' : formatMoney(plan.price)}
                          {plan.price > 0 && <span> / month</span>}
                        </div>
                        <ul className="plan-features">
                          {plan.features.map((f) => (
                            <li key={f}><Icon name="check" size={16} /><span>{f}</span></li>
                          ))}
                        </ul>
                        <button
                          className={isCurrent ? 'btn-secondary' : 'btn-primary'}
                          disabled={isCurrent || billingBusy}
                          onClick={() => handleSelectPlan(plan)}
                        >
                          {isCurrent ? 'Current plan' : currentPlanId ? `Switch to ${plan.name}` : `Choose ${plan.name}`}
                        </button>
                      </section>
                    );
                  })}
                </div>

                <section className="section">
                  <div className="section-header">
                    <div>
                      <h3>Payment methods</h3>
                      <p className="section-subtitle section-subtitle-tight">Cards you can use to pay for your plan.</p>
                    </div>
                    <button className="btn-secondary" onClick={() => openModal('add-card')}>+ Add payment method</button>
                  </div>
                  {billing.methods.length === 0 ? (
                    <p className="empty-state">No payment methods yet. Add a card to subscribe.</p>
                  ) : (
                    <ul className="method-list">
                      {billing.methods.map((m) => (
                        <li key={m.id} className="method-row">
                          <span className={`card-brand ${m.brand}`}>{BRAND_LABEL[m.brand] || 'Card'}</span>
                          <span className="method-main">
                            <span className="method-number">Ending {m.last4}</span>
                            <span className="activity-sub">
                              {m.holder} - expires {String(m.expMonth).padStart(2, '0')}/{String(m.expYear).slice(-2)}
                            </span>
                          </span>
                          {m.isDefault ? (
                            <span className="badge active">default</span>
                          ) : (
                            <button className="link-btn" disabled={billingBusy} onClick={() => handleSetDefaultMethod(m.id)}>
                              Make default
                            </button>
                          )}
                          <button className="link-btn danger" disabled={billingBusy} onClick={() => handleRemoveMethod(m)}>
                            Remove
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>

                <section className="section">
                  <h3>Invoice history</h3>
                  {billing.invoices.length === 0 ? (
                    <p className="empty-state">No invoices yet. They appear here after your first payment.</p>
                  ) : (
                    <div className="table-scroll">
                      <table className="data-table invoice-table">
                        <thead>
                          <tr>
                            <th>Invoice</th>
                            <th>Date</th>
                            <th>Plan</th>
                            <th>Amount</th>
                            <th>Method</th>
                            <th>Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {billing.invoices.map((inv) => (
                            <tr key={inv.id}>
                              <td>{inv.invoiceNumber}</td>
                              <td>{formatDate(toDate(inv.createdAt))}</td>
                              <td>{inv.planName}</td>
                              <td>{formatMoney(inv.amount, inv.currency)}</td>
                              <td>{inv.methodLabel}</td>
                              <td>
                                <span className="badge active">{inv.status}</span>
                                {inv.mode === 'demo' && <span className="demo-tag">demo</span>}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
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

                <section className="section">
                  <form className="form" onSubmit={handleAddClient}>
                    <div className="form-group">
                      <label>Client Name</label>
                      <input type="text" name="clientName" placeholder="John Smith" required />
                    </div>
                    <div className="form-group">
                      <label>Client email (optional)</label>
                      <input type="email" name="clientEmail" placeholder="client@example.com" />
                      <small className="field-hint">Used to send an invitation reminder if they have not joined yet.</small>
                    </div>
                    <button type="submit" className="btn-primary" disabled={loading}>
                      {loading ? 'Adding...' : 'Add Client'}
                    </button>
                  </form>
                </section>
              </div>
            )}

            {currentPage === 'client-detail' && selectedClient && (
              <div className="client-page">
                <button className="btn-back icon-text" onClick={() => goTo(returnPage)}>
                  <Icon name="back" size={16} /> Back
                </button>

                {calendarNotice && <p className={`form-message ${calendarNotice.type}`}>{calendarNotice.text}</p>}

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
                      {selectedClient.inactiveDays != null && (
                        <span className="level-pill red">Inactive for {selectedClient.inactiveDays} days</span>
                      )}
                    </div>
                  </div>
                  {selectedClient.accountStatus === 'active' && (
                    <div className="client-page-actions">
                      {selectedClient.level !== 'completed' && (
                        <button className="btn-secondary" onClick={() => openSchedule(selectedClient.id)}>
                          <Icon name="calendar" size={16} /> Add feedback to calendar
                        </button>
                      )}
                      <button
                        className="btn-secondary"
                        disabled={calendarBusy}
                        onClick={() => handleSetProgramme(selectedClient, selectedClient.level !== 'completed')}
                      >
                        {selectedClient.level === 'completed' ? 'Reopen programme' : 'Mark programme completed'}
                      </button>
                    </div>
                  )}
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
                      <button className="btn-secondary" onClick={() => openInviteReminder(selectedClient.id)}>
                        Send reminder
                      </button>
                    </div>
                    {selectedClient.inviteReminders?.count > 0 && (
                      <p className="field-hint">
                        Reminders sent: {selectedClient.inviteReminders.count}
                        {selectedClient.inviteReminders.lastSentAt
                          ? `, last on ${formatDate(toDate(selectedClient.inviteReminders.lastSentAt))}`
                          : ''}
                        .
                      </p>
                    )}
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
                        <div><dt>Date of birth</dt><dd>{selectedClient.dateOfBirth ? formatDate(parseDateKey(selectedClient.dateOfBirth)) : '-'}</dd></div>
                        <div><dt>Age</dt><dd>{selectedClient.dateOfBirth ? ageFromDob(selectedClient.dateOfBirth) : selectedClient.profile.age ?? '-'}</dd></div>
                        <div><dt>Sex</dt><dd>{sexLabel[selectedClient.profile.sex] || selectedClient.profile.sex || '-'}</dd></div>
                        <div><dt>Height</dt><dd>{fmt(selectedClient.profile.height, 0, ' cm')}</dd></div>
                        <div><dt>Starting weight</dt><dd>{fmt(selectedClient.profile.weight, 1, ' kg')}</dd></div>
                        <div><dt>Activity level</dt><dd className="capitalize">{selectedClient.profile.activityLevel || '-'}</dd></div>
                        <div><dt>Daily steps (average)</dt><dd>{selectedClient.profile.steps ?? '-'}</dd></div>
                        <div><dt>Daily water goal</dt><dd>{fmt(selectedClient.profile.water, 1, ' L')}</dd></div>
                        <div><dt>Gym</dt><dd>{selectedClient.profile.gym || '-'}</dd></div>
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
                                  <span className="checkin-row-title">{ci.weekKey ? `Week of ${formatDate(parseDateKey(ci.weekKey))}` : `Check-in on ${formatDate(toDate(ci.createdAt))}`}</span>
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
                                            <td>{dayLabel(ci, d)}</td>
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

                {selectedClient.accountStatus === 'active' && (
                  <>
                    <section className="section">
                      <div className="section-header">
                        <div>
                          <h3>Feedback and calendar</h3>
                          <p className="section-subtitle section-subtitle-tight">
                            Schedule a Google Meet 1-on-1 or an email feedback so you never miss it.
                          </p>
                        </div>
                        {selectedClient.level !== 'completed' && (
                          <button className="btn-primary" onClick={() => openSchedule(selectedClient.id)}>
                            Add feedback to calendar
                          </button>
                        )}
                      </div>
                      {calendarEvents.filter((ev) => ev.clientId === selectedClient.id && ev.status === 'scheduled').length === 0 ? (
                        <p className="empty-state">No feedback scheduled for {firstName(selectedClient.name)}.</p>
                      ) : (
                        <ul className="upcoming-list">
                          {calendarEvents
                            .filter((ev) => ev.clientId === selectedClient.id && ev.status === 'scheduled')
                            .sort((a, b) => startMs(a) - startMs(b))
                            .map((ev) => (
                              <li key={ev.id}>
                                <button className="upcoming-item" onClick={() => setSelectedEventId(ev.id)}>
                                  <span className={`upcoming-icon ${ev.type}`}>
                                    <Icon name={ev.type === 'meet' ? 'video' : 'mail'} size={16} />
                                  </span>
                                  <span className="upcoming-main">
                                    <span className="activity-name">{formatWhen(ev.dateKey, formatTime(toDate(ev.startAt)))}</span>
                                    <span className="activity-sub">{ev.type === 'meet' ? 'Google Meet 1-on-1' : 'Email feedback'}</span>
                                  </span>
                                </button>
                              </li>
                            ))}
                        </ul>
                      )}
                    </section>

                    <section className="section">
                      <h3>Automated messages</h3>
                      <p className="section-subtitle">
                        Emails sent in your name. Switch one on only when {firstName(selectedClient.name)} has agreed to receive it.
                      </p>

                      {selectedClient.profile?.dateOfBirth ? (
                        <p className="dob-from-profile">
                          Date of birth: <strong>{formatDate(parseDateKey(selectedClient.profile.dateOfBirth))}</strong>
                          <span>from the client's own profile</span>
                        </p>
                      ) : (
                        <form
                          className="dob-form"
                          onSubmit={(e) => handleSaveDob(e, selectedClient)}
                          key={`${selectedClient.id}-${selectedClient.dateOfBirth || ''}`}
                        >
                          <div className="form-group">
                            <label>Date of birth</label>
                            <input type="date" name="dob" defaultValue={selectedClient.dateOfBirth || ''} />
                            <small className="field-hint">
                              The client has not added it to their profile yet. You can enter it here for now.
                            </small>
                          </div>
                          <button type="submit" className="btn-secondary" disabled={calendarBusy}>Save</button>
                        </form>
                      )}

                      {!selectedClient.email && (
                        <p className="form-message error">
                          No email address on file for this client yet, so messages cannot be sent.
                        </p>
                      )}

                      <ul className="automation-list">
                        {optInRows.map((row) => {
                          const on = !!selectedClient.optIns?.[row.kind]?.enabled;
                          const note = automationNote(selectedClient.id, row.kind);
                          return (
                            <li key={row.kind} className="automation-row">
                              <span className="automation-icon"><Icon name={row.icon} size={18} /></span>
                              <div className="automation-text">
                                <strong>{row.label}</strong>
                                <small>{row.desc}{note ? ` ${note}.` : ''}</small>
                              </div>
                              <button
                                className={`switch ${on ? 'on' : ''}`}
                                role="switch"
                                aria-checked={on}
                                aria-label={row.label}
                                onClick={() => openOptIn(selectedClient.id, row.kind, !on)}
                              >
                                <span className="switch-knob" />
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    </section>
                  </>
                )}
              </div>
            )}
          </main>
        </div>

        {activeModal === 'profile' && (
          <Modal title="Update profile" onClose={closeModal}>
            <form className="form" onSubmit={handleSaveCoachProfile}>
                <div className="profile-photo-row">
                  {coachProfile?.photoUrl ? (
                    <img className="profile-photo" src={coachProfile.photoUrl} alt="" />
                  ) : (
                    <span className="client-avatar xlarge">{initialOf(coachName)}</span>
                  )}
                  {profilePhotoEditing ? (
                    <PhotoPicker
                      busy={loading}
                      saveLabel="Save photo"
                      onUse={handleSaveCoachPhoto}
                      onCancel={() => setProfilePhotoEditing(false)}
                    />
                  ) : (
                    <button type="button" className="btn-secondary" onClick={() => setProfilePhotoEditing(true)}>
                      Change photo
                    </button>
                  )}
                </div>
              <div className="form-group">
                <label>Full name</label>
                <input type="text" name="displayName" defaultValue={coachName} required />
              </div>
              <div className="form-group">
                <label>Business or coaching name</label>
                <input type="text" name="businessName" defaultValue={coachProfile?.businessName || ''} placeholder="Optional" />
              </div>
              <div className="form-group">
                <label>Phone</label>
                <input type="tel" name="phone" defaultValue={coachProfile?.phone || ''} placeholder="Optional" />
              </div>
              <div className="form-group">
                <label>Email</label>
                <input type="email" value={user.email || ''} readOnly />
                <small className="field-hint">Your email comes from your Google account and cannot be changed here.</small>
              </div>
              {modalMessage && <p className={`form-message ${modalMessage.type}`}>{modalMessage.text}</p>}
              <div className="modal-actions">
                <button type="button" className="btn-secondary" onClick={closeModal}>Close</button>
                <button type="submit" className="btn-primary" disabled={loading}>
                  {loading ? 'Saving...' : 'Save changes'}
                </button>
              </div>
            </form>
          </Modal>
        )}

        {activeModal === 'install' && <InstallModal onClose={closeModal} />}

        {activeModal === 'contact' && (
          <Modal title="Contact admin" onClose={closeModal}>
            <form className="form" onSubmit={handleSendAdminMessage}>
              <p className="section-subtitle">Ask a question or report a problem. The admin replies to {user.email}.</p>
              <div className="form-group">
                <label>Subject</label>
                <input type="text" name="subject" required />
              </div>
              <div className="form-group">
                <label>Message</label>
                <textarea name="message" rows="5" required />
              </div>
              {modalMessage && <p className={`form-message ${modalMessage.type}`}>{modalMessage.text}</p>}
              <div className="modal-actions">
                <button type="button" className="btn-secondary" onClick={closeModal}>Close</button>
                <button type="submit" className="btn-primary" disabled={loading}>
                  {loading ? 'Sending...' : 'Send message'}
                </button>
              </div>
            </form>
          </Modal>
        )}

        {activeModal === 'close' && (
          <Modal title="Close account" onClose={closeModal}>
            <div className="form">
              <p className="warning-text">
                Closing your account signs you out and blocks you from signing in again. Your clients and their data are
                kept, but you will no longer be able to see them.
              </p>
              <div className="form-group">
                <label>Type CLOSE to confirm</label>
                <input
                  type="text"
                  value={closeConfirm}
                  onChange={(e) => setCloseConfirm(e.target.value)}
                  autoComplete="off"
                />
              </div>
              {modalMessage && <p className={`form-message ${modalMessage.type}`}>{modalMessage.text}</p>}
              <div className="modal-actions">
                <button type="button" className="btn-secondary" onClick={closeModal}>Keep my account</button>
                <button
                  type="button"
                  className="btn-danger"
                  disabled={closeConfirm !== 'CLOSE' || loading}
                  onClick={handleCloseAccount}
                >
                  {loading ? 'Closing...' : 'Close account'}
                </button>
              </div>
            </div>
          </Modal>
        )}

        {activeModal === 'add-card' && (
          <Modal title="Add payment method" onClose={closeModal}>
            <form className="form" onSubmit={handleAddCard}>
              <div className="form-group">
                <label>Name on card</label>
                <input type="text" name="holder" autoComplete="cc-name" required />
              </div>
              <div className="form-group">
                <label>Card number</label>
                <input type="text" name="number" inputMode="numeric" autoComplete="cc-number" placeholder="1234 5678 9012 3456" required />
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Expiry (MM/YY)</label>
                  <input type="text" name="expiry" autoComplete="cc-exp" placeholder="08/28" required />
                </div>
                <div className="form-group">
                  <label>Security code</label>
                  <input type="password" name="cvc" inputMode="numeric" autoComplete="cc-csc" placeholder="123" required />
                </div>
              </div>
              <small className="field-hint">
                Only the card type, last four digits and expiry are saved. The full number and security code are never stored.
              </small>
              {modalMessage && <p className={`form-message ${modalMessage.type}`}>{modalMessage.text}</p>}
              <div className="modal-actions">
                <button type="button" className="btn-secondary" onClick={closeModal}>Cancel</button>
                <button type="submit" className="btn-primary" disabled={billingBusy}>
                  {billingBusy ? 'Saving...' : 'Save card'}
                </button>
              </div>
            </form>
          </Modal>
        )}

        {activeModal === 'checkout' && checkoutPlan && (
          <Modal title={`Subscribe to ${checkoutPlan.name}`} onClose={closeModal}>
            <div className="form">
              <div className="checkout-summary">
                <span>{checkoutPlan.name} plan, billed monthly</span>
                <strong>{formatMoney(checkoutPlan.price)}</strong>
              </div>

              <div className="form-group">
                <label>Pay with</label>
                {billing.methods.length === 0 ? (
                  <p className="section-subtitle section-subtitle-tight">You need a payment method before you can subscribe.</p>
                ) : (
                  <ul className="method-pick">
                    {billing.methods.map((m) => (
                      <li key={m.id}>
                        <label className={`method-option ${selectedMethodId === m.id ? 'selected' : ''}`}>
                          <input
                            type="radio"
                            name="method"
                            checked={selectedMethodId === m.id}
                            onChange={() => setSelectedMethodId(m.id)}
                          />
                          <span className={`card-brand ${m.brand}`}>{BRAND_LABEL[m.brand] || 'Card'}</span>
                          <span>Ending {m.last4}</span>
                        </label>
                      </li>
                    ))}
                  </ul>
                )}
                <button type="button" className="link-btn" onClick={() => openModal('add-card')}>
                  + Add a new payment method
                </button>
              </div>

              <div className="coupon-box">
                <label>Coupon code</label>
                <div className="coupon-row">
                  <input
                    type="text"
                    value={couponInput}
                    maxLength={20}
                    placeholder="Enter a code"
                    onChange={(e) => {
                      setCouponInput(e.target.value.toUpperCase());
                      setAppliedCoupon(null);
                      setCouponMsg(null);
                    }}
                  />
                  <button type="button" className="btn-secondary" disabled={!couponInput.trim()} onClick={applyCoupon}>Apply</button>
                </div>
                {couponMsg && <p className={`form-message ${couponMsg.type}`}>{couponMsg.text}</p>}
                {appliedCoupon && (
                  <p className="coupon-total">
                    Total today: <strong>{formatMoney(appliedCoupon.discounted)}</strong> <span>(was {formatMoney(checkoutPlan.price)})</span>
                  </p>
                )}
              </div>
              <p className="section-subtitle section-subtitle-tight">
                Demo mode: this records your plan and an invoice but does not charge your card.
              </p>
              {modalMessage && <p className={`form-message ${modalMessage.type}`}>{modalMessage.text}</p>}
              <div className="modal-actions">
                <button type="button" className="btn-secondary" onClick={closeModal}>Cancel</button>
                <button
                  type="button"
                  className="btn-primary"
                  disabled={billingBusy || billing.methods.length === 0}
                  onClick={handleSubscribe}
                >
                  {billingBusy ? 'Processing...' : `Pay ${formatMoney(appliedCoupon ? appliedCoupon.discounted : checkoutPlan.price)} and subscribe`}
                </button>
              </div>
            </div>
          </Modal>
        )}
        {scheduleDraft && (
          <Modal title="Add feedback to calendar" onClose={() => setScheduleDraft(null)} wide>
            <div className="form">
              <div className="form-group">
                <label>Client</label>
                <select value={scheduleDraft.clientId} onChange={(e) => updateDraft({ clientId: e.target.value })}>
                  <option value="">Choose a client</option>
                  {schedulable.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>

              <div className="form-group">
                <label>How will you give the feedback?</label>
                <div className="seg">
                  <button
                    type="button"
                    className={`seg-btn ${scheduleDraft.type === 'meet' ? 'active' : ''}`}
                    onClick={() => updateDraft({ type: 'meet' })}
                  >
                    <Icon name="video" size={16} /><span>Google Meet 1-on-1</span>
                  </button>
                  <button
                    type="button"
                    className={`seg-btn ${scheduleDraft.type === 'email' ? 'active' : ''}`}
                    onClick={() => updateDraft({ type: 'email' })}
                  >
                    <Icon name="mail" size={16} /><span>Email feedback</span>
                  </button>
                </div>
              </div>

              <div className="form-row three">
                <div className="form-group">
                  <label>Date</label>
                  <input type="date" value={scheduleDraft.date} min={todayKey} onChange={(e) => updateDraft({ date: e.target.value })} />
                </div>
                <div className="form-group">
                  <label>Time</label>
                  <input type="time" value={scheduleDraft.time} onChange={(e) => updateDraft({ time: e.target.value })} />
                </div>
                {scheduleDraft.type === 'meet' && (
                  <div className="form-group">
                    <label>Length</label>
                    <select value={scheduleDraft.duration} onChange={(e) => updateDraft({ duration: Number(e.target.value) })}>
                      <option value={30}>30 minutes</option>
                      <option value={45}>45 minutes</option>
                      <option value={60}>60 minutes</option>
                    </select>
                  </div>
                )}
              </div>

              {scheduleDraft.type === 'meet' && (
                <div className="meet-box">
                  {googleOk ? (
                    <p className="meet-ok">
                      <Icon name="check" size={16} />
                      <span>
                        Google Calendar is connected. The Meet link is created when you add this, and Google invites{' '}
                        {draftClient ? draftClient.name : 'the client'}.
                      </span>
                    </p>
                  ) : (
                    <>
                      <p>Connect Google Calendar to create the Meet link automatically.</p>
                      <button type="button" className="btn-secondary" onClick={handleConnectGoogle}>
                        Connect Google Calendar
                      </button>
                      <div className="form-group meet-manual">
                        <label>Or paste an existing Meet link</label>
                        <input
                          type="url"
                          value={scheduleDraft.manualMeetLink}
                          onChange={(e) => updateDraft({ manualMeetLink: e.target.value })}
                          placeholder="https://meet.google.com/..."
                        />
                      </div>
                    </>
                  )}
                </div>
              )}

              <div className="form-row">
                <div className="form-group">
                  <label>Remind me</label>
                  <select value={scheduleDraft.remindDays} onChange={(e) => updateDraft({ remindDays: Number(e.target.value) })}>
                    <option value={0}>On the day</option>
                    <option value={1}>1 day before</option>
                    <option value={2}>2 days before</option>
                  </select>
                </div>
                <div className="form-group">
                  <label>Email to client</label>
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={scheduleDraft.sendClientEmail && !!(draftClient && draftClient.email)}
                      disabled={!draftClient || !draftClient.email}
                      onChange={(e) => updateDraft({ sendClientEmail: e.target.checked })}
                    />
                    <span>
                      {draftClient && !draftClient.email ? 'No email on file yet' : 'Send on the day'}
                    </span>
                  </label>
                </div>
              </div>

              {draftClient && (
                <div className="email-section">
                  <div className="email-tabs" role="tablist">
                    {scheduleDraft.sendClientEmail && draftClient.email && (
                      <button
                        role="tab"
                        aria-selected={emailTab === 'client'}
                        className={`range-tab ${emailTab === 'client' ? 'active' : ''}`}
                        onClick={() => setEmailTab('client')}
                      >
                        Email to client
                      </button>
                    )}
                    <button
                      role="tab"
                      aria-selected={!(scheduleDraft.sendClientEmail && draftClient.email) || emailTab === 'coach'}
                      className={`range-tab ${!(scheduleDraft.sendClientEmail && draftClient.email) || emailTab === 'coach' ? 'active' : ''}`}
                      onClick={() => setEmailTab('coach')}
                    >
                      Your reminder
                    </button>
                    <span className="email-tabs-spacer" />
                    <button type="button" className="link-btn" onClick={() => setEmailEditing(!emailEditing)}>
                      {emailEditing ? 'Show preview' : 'Edit text'}
                    </button>
                    <button
                      type="button"
                      className="link-btn"
                      onClick={() => updateDraft({ edited: { client: false, coach: false } })}
                    >
                      Reset text
                    </button>
                  </div>

                  {scheduleDraft.sendClientEmail && draftClient.email && emailTab === 'client' ? (
                    emailEditing ? (
                      <>
                        <div className="form-group">
                          <label>Subject</label>
                          <input type="text" value={scheduleDraft.clientSubject} onChange={(e) => editDraftText('client', 'clientSubject', e.target.value)} />
                        </div>
                        <div className="form-group">
                          <label>Message</label>
                          <textarea rows="12" value={scheduleDraft.clientBody} onChange={(e) => editDraftText('client', 'clientBody', e.target.value)} />
                        </div>
                      </>
                    ) : (
                      <EmailPreview
                        from={fromLabel}
                        to={`${draftClient.name} <${draftClient.email}>`}
                        replyTo={user.email}
                        sendOn={formatDate(parseDateKey(scheduleDraft.date))}
                        subject={scheduleDraft.clientSubject}
                        body={previewFill(scheduleDraft.clientBody)}
                      />
                    )
                  ) : emailEditing ? (
                    <>
                      <div className="form-group">
                        <label>Subject</label>
                        <input type="text" value={scheduleDraft.coachSubject} onChange={(e) => editDraftText('coach', 'coachSubject', e.target.value)} />
                      </div>
                      <div className="form-group">
                        <label>Message</label>
                        <textarea rows="10" value={scheduleDraft.coachBody} onChange={(e) => editDraftText('coach', 'coachBody', e.target.value)} />
                      </div>
                    </>
                  ) : (
                    <EmailPreview
                      from="BodUp reminders"
                      to={user.email}
                      sendOn={formatDate(
                        parseDateKey(
                          addDaysKey(scheduleDraft.date, -scheduleDraft.remindDays) < todayKey
                            ? todayKey
                            : addDaysKey(scheduleDraft.date, -scheduleDraft.remindDays)
                        )
                      )}
                      subject={scheduleDraft.coachSubject}
                      body={previewFill(scheduleDraft.coachBody)}
                    />
                  )}
                </div>
              )}

              {scheduleDraft.message && (
                <p className={`form-message ${scheduleDraft.message.type}`}>{scheduleDraft.message.text}</p>
              )}
              <div className="modal-actions">
                <button type="button" className="btn-secondary" onClick={() => setScheduleDraft(null)}>Cancel</button>
                <button type="button" className="btn-primary" disabled={calendarBusy || !draftClient} onClick={handleScheduleSave}>
                  {calendarBusy ? 'Adding...' : 'Add to calendar'}
                </button>
              </div>
            </div>
          </Modal>
        )}

        {selectedEvent && (
          <Modal title="Feedback session" onClose={() => setSelectedEventId(null)}>
            <dl className="event-facts">
              <div><dt>Client</dt><dd>{selectedEvent.clientName}</dd></div>
              <div>
                <dt>When</dt>
                <dd>{formatWhen(selectedEvent.dateKey, formatTime(toDate(selectedEvent.startAt)))}</dd>
              </div>
              <div>
                <dt>Type</dt>
                <dd>{selectedEvent.type === 'meet' ? 'Google Meet 1-on-1' : 'Email feedback'}</dd>
              </div>
              {selectedEvent.meetLink && (
                <div>
                  <dt>Meet link</dt>
                  <dd>
                    <a href={selectedEvent.meetLink} target="_blank" rel="noopener noreferrer">{selectedEvent.meetLink}</a>
                  </dd>
                </div>
              )}
              {selectedEvent.googleHtmlLink && (
                <div>
                  <dt>Google Calendar</dt>
                  <dd>
                    <a href={selectedEvent.googleHtmlLink} target="_blank" rel="noopener noreferrer">Open the event</a>
                  </dd>
                </div>
              )}
              <div><dt>Status</dt><dd className="capitalize">{selectedEvent.status}</dd></div>
              <div>
                <dt>Email to client</dt>
                <dd>
                  {selectedEvent.clientEmailId
                    ? describeEmailStatus(outbox.find((m) => m.id === selectedEvent.clientEmailId))
                    : 'Not sending an email'}
                </dd>
              </div>
              <div>
                <dt>Your reminder</dt>
                <dd>{describeEmailStatus(outbox.find((m) => m.id === selectedEvent.reminderEmailId))}</dd>
              </div>
            </dl>
            <div className="modal-actions modal-actions-spread">
              <button
                className="btn-danger"
                disabled={calendarBusy}
                onClick={() => handleDeleteEvent(selectedEvent)}
              >
                Delete
              </button>
              <div className="modal-actions-group">
                <button
                  className="btn-secondary"
                  onClick={() => {
                    const id = selectedEvent.clientId;
                    setSelectedEventId(null);
                    openClient(id);
                  }}
                >
                  Open client
                </button>
                {selectedEvent.status === 'scheduled' && (
                  <button className="btn-primary" disabled={calendarBusy} onClick={() => handleMarkEventDone(selectedEvent)}>
                    Mark as done
                  </button>
                )}
              </div>
            </div>
          </Modal>
        )}

        {reminderDraft && reminderClient && (
          <Modal title={`Remind ${reminderClient.name} to join`} onClose={() => setReminderDraft(null)} wide>
            <div className="form">
              <div className="form-group">
                <label>Client email address</label>
                <input
                  type="email"
                  value={reminderDraft.email}
                  onChange={(e) => setReminderDraft({ ...reminderDraft, email: e.target.value, message: null })}
                  placeholder="client@example.com"
                />
                <small className="field-hint">
                  {reminderClient.inviteReminders?.count > 0
                    ? `Reminders sent so far: ${reminderClient.inviteReminders.count}.`
                    : 'No reminder has been sent to this client yet.'}
                </small>
              </div>

              <div className="email-tabs">
                <span className="email-tabs-spacer" />
                <button type="button" className="link-btn" onClick={() => setEmailEditing(!emailEditing)}>
                  {emailEditing ? 'Show preview' : 'Edit text'}
                </button>
              </div>

              {emailEditing ? (
                <>
                  <div className="form-group">
                    <label>Subject</label>
                    <input
                      type="text"
                      value={reminderDraft.subject}
                      onChange={(e) => setReminderDraft({ ...reminderDraft, subject: e.target.value })}
                    />
                  </div>
                  <div className="form-group">
                    <label>Message</label>
                    <textarea
                      rows="14"
                      value={reminderDraft.body}
                      onChange={(e) => setReminderDraft({ ...reminderDraft, body: e.target.value })}
                    />
                  </div>
                </>
              ) : (
                <EmailPreview
                  from={fromLabel}
                  to={reminderDraft.email || 'Enter the client email above'}
                  replyTo={user.email}
                  subject={reminderDraft.subject}
                  body={reminderDraft.body}
                />
              )}

              {reminderDraft.message && (
                <p className={`form-message ${reminderDraft.message.type}`}>{reminderDraft.message.text}</p>
              )}
              <div className="modal-actions">
                <button type="button" className="btn-secondary" onClick={() => setReminderDraft(null)}>Close</button>
                <button type="button" className="btn-secondary" onClick={handleCopyReminder}>
                  {reminderDraft.copied ? 'Copied' : 'Copy message'}
                </button>
                <button type="button" className="btn-primary" disabled={reminderDraft.busy} onClick={handleSendInviteReminder}>
                  {reminderDraft.busy ? 'Sending...' : 'Send email now'}
                </button>
              </div>
            </div>
          </Modal>
        )}

        {optInDraft && optInClient && (
          <Modal
            title={`${optInDraft.enable ? 'Turn on' : 'Turn off'}: ${optInRows.find((r) => r.kind === optInDraft.kind)?.label}`}
            onClose={() => setOptInDraft(null)}
            wide
          >
            <div className="form">
              {optInDraft.enable ? (
                <>
                  <p className="section-subtitle">
                    This email goes to {optInClient.name}
                    {optInClient.email ? ` (${optInClient.email})` : ''}.{' '}
                    {optInDraft.kind === 'birthday' && optInClient.dateOfBirth &&
                      `It sends on ${formatDate(parseDateKey(nextBirthdayKey(optInClient.dateOfBirth)))}, then every year.`}
                    {optInDraft.kind === 'christmas' &&
                      `It sends on ${formatDate(parseDateKey(nextChristmasKey()))}, then every year.`}
                    {optInDraft.kind !== 'birthday' && optInDraft.kind !== 'christmas' &&
                      'It sends once, in the next daily run.'}
                  </p>

                  <div className="email-tabs">
                    <span className="email-tabs-spacer" />
                    <button type="button" className="link-btn" onClick={() => setEmailEditing(!emailEditing)}>
                      {emailEditing ? 'Show preview' : 'Edit text'}
                    </button>
                  </div>

                  {emailEditing ? (
                    <>
                      <div className="form-group">
                        <label>Subject</label>
                        <input
                          type="text"
                          value={optInDraft.subject}
                          onChange={(e) => setOptInDraft({ ...optInDraft, subject: e.target.value })}
                        />
                      </div>
                      <div className="form-group">
                        <label>Message</label>
                        <textarea
                          rows="12"
                          value={optInDraft.body}
                          onChange={(e) => setOptInDraft({ ...optInDraft, body: e.target.value })}
                        />
                      </div>
                    </>
                  ) : (
                    <EmailPreview
                      from={fromLabel}
                      to={`${optInClient.name} <${optInClient.email || 'no email on file'}>`}
                      replyTo={user.email}
                      subject={optInDraft.subject}
                      body={optInDraft.body}
                    />
                  )}

                  <label className="check-row consent-row">
                    <input
                      type="checkbox"
                      checked={optInDraft.confirmed}
                      onChange={(e) => setOptInDraft({ ...optInDraft, confirmed: e.target.checked, message: null })}
                    />
                    <span>I confirm that {optInClient.name} has agreed to receive this message from me.</span>
                  </label>
                </>
              ) : (
                <p className="section-subtitle">
                  Stop this message for {optInClient.name}? Anything not yet sent will be cancelled.
                </p>
              )}

              {optInDraft.message && (
                <p className={`form-message ${optInDraft.message.type}`}>{optInDraft.message.text}</p>
              )}
              <div className="modal-actions">
                <button type="button" className="btn-secondary" onClick={() => setOptInDraft(null)}>Cancel</button>
                <button
                  type="button"
                  className={optInDraft.enable ? 'btn-primary' : 'btn-danger'}
                  disabled={calendarBusy}
                  onClick={handleOptInSave}
                >
                  {calendarBusy ? 'Saving...' : optInDraft.enable ? 'Turn on' : 'Turn off'}
                </button>
              </div>
            </div>
          </Modal>
        )}
      </div>
    );
  }

  if (userRole === 'client') {
    const myName = user.displayName || user.email;
    const weekKey = getWeekKey(new Date());
    const todayKey = toDateKey(new Date());
    const todayIndex = ((new Date().getDay() + 6) % 7) + 1;
    const sortedCheckIns = [...weeklyCheckIns].sort(
      (a, b) => (checkInDate(a)?.getTime() || 0) - (checkInDate(b)?.getTime() || 0)
    );
    const weekDoc = findWeekDoc(weeklyCheckIns, weekKey);
    const weekDays = Array.from({ length: 7 }, (_, i) => {
      const key = addDaysKey(weekKey, i);
      const found = (weekDoc?.days || []).find((d) => d.day === i + 1);
      return { index: i + 1, key, label: WEEKDAYS[i], date: parseDateKey(key), saved: dayHasData(found) ? found : null };
    });
    const daysLogged = weekDays.filter((d) => d.saved).length;
    const selectedDay = weekDays[checkinDay - 1];
    const savedStamp = weekDoc ? checkInDate(weekDoc)?.getTime() || 0 : 0;
    const pastCheckIns = sortedCheckIns.filter((ci) => ci !== weekDoc).reverse();

    const stats = buildClientStats(profile, sortedCheckIns);
    const startWeight = profile?.weight;
    const progress =
      startWeight != null && stats.target != null && stats.latestWeight != null && startWeight !== stats.target
        ? Math.max(0, Math.min(100, ((startWeight - stats.latestWeight) / (startWeight - stats.target)) * 100))
        : null;

    const myEvents = clientEvents.filter((ev) => ev.status !== 'cancelled');
    const eventStartMs = (ev) => toDate(ev.startAt)?.getTime() || 0;
    const nextEvents = myEvents
      .filter((ev) => ev.status === 'scheduled' && ev.dateKey >= todayKey)
      .sort((a, b) => eventStartMs(a) - eventStartMs(b));
    const myEventsByDay = {};
    myEvents
      .sort((a, b) => eventStartMs(a) - eventStartMs(b))
      .forEach((ev) => {
        if (!myEventsByDay[ev.dateKey]) myEventsByDay[ev.dateKey] = [];
        myEventsByDay[ev.dateKey].push(ev);
      });
    const myGrid = buildMonthGrid(calendarMonth);
    const selectedClientEvent = clientEvents.find((ev) => ev.id === selectedEventId);
    const dob = profile?.dateOfBirth || '';
    const activeTop = currentPage === 'profile' ? 'dashboard' : currentPage;
    const openClientSettings = (name) => (name === 'profile' ? goClient('profile') : openModal(name));

    const sideItems = [
      { id: 'dashboard', label: 'Dashboard', icon: 'dashboard' },
      { id: 'checkin', label: 'Weekly Check-in', icon: 'check' },
      { id: 'learning', label: 'Learning', icon: 'book' },
      { id: 'calendar', label: 'Calendar', icon: 'calendar' },
      { id: 'chat', label: 'Chat', icon: 'chat' },
      { id: 'profile', label: 'My Profile', icon: 'user' }
    ];

    return (
      <div className={`dashboard-container ${sidebarCollapsed ? 'collapsed' : ''}`}>
        <aside className="sidebar">
          <div className="sidebar-header">
            {!sidebarCollapsed && <h1><BrandMark size={30} /></h1>}
            <button
              className="sidebar-toggle"
              onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
              aria-label={sidebarCollapsed ? 'Expand menu' : 'Collapse menu'}
              title={sidebarCollapsed ? 'Expand menu' : 'Collapse menu'}
            >
              <Icon name={sidebarCollapsed ? 'expand' : 'collapse'} />
            </button>
          </div>

          <div className="coach-chip" title={myName}>
            <span className="client-avatar coach-avatar">{initialOf(myName)}</span>
            <span className="nav-label coach-chip-text">
              <span className="coach-chip-name">{myName}</span>
              <span className="coach-chip-role">{coachInfo ? `Coach: ${coachInfo.name}` : 'Client'}</span>
            </span>
          </div>

          <nav className="sidebar-nav">
            {sideItems.map((item) => (
              <button
                key={item.id}
                className={`nav-item ${currentPage === item.id ? 'active' : ''}`}
                onClick={() => goClient(item.id)}
                title={item.label}
              >
                <Icon name={item.icon} />
                <span className="nav-label">{item.label}</span>
              </button>
            ))}
          </nav>

          <div className="sidebar-footer">
            <button className="nav-item logout" onClick={handleSignOut} title="Log out">
              <Icon name="logout" />
              <span className="nav-label">Log out</span>
            </button>
          </div>
        </aside>

        <div className="workspace">
          <header className="topbar">
            <div className="topbar-left" />
            <nav className="topnav" aria-label="Main">
              {CLIENT_NAV.map((item) => (
                <button
                  key={item.id}
                  className={`topnav-item ${activeTop === item.id ? 'active' : ''}`}
                  onClick={() => goClient(item.id)}
                >
                  <Icon name={item.icon} size={18} />
                  <span className="topnav-label">{item.label}</span>
                </button>
              ))}
            </nav>
            <div className="topbar-right">
              <LanguageMenu language={language} onChange={setLanguage} />
              <SettingsMenu
                theme={theme}
                onToggleTheme={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
                onOpenModal={openClientSettings}
              />
            </div>
          </header>

          <main className="main-content">
            {clientNotice && <p className={`form-message ${clientNotice.type}`}>{clientNotice.text}</p>}

            {currentPage === 'dashboard' && (
              <div className="dashboard-view">
                <div className="page-header">
                  <h2>Hello, {firstName(myName)}</h2>
                  <p>Here is how your week is going.</p>
                </div>

                <div className="stats-grid">
                  <div className="stat-card">
                    <div className="stat-value">{fmt(stats.latestWeight, 1)}<span className="stat-unit"> kg</span></div>
                    <div className="stat-label">Current weight</div>
                  </div>
                  <div className="stat-card">
                    <div className="stat-value">{fmt(stats.target, 1)}<span className="stat-unit"> kg</span></div>
                    <div className="stat-label">Target weight</div>
                  </div>
                  <div className="stat-card">
                    <div className="stat-value">{progress == null ? '-' : `${Math.round(progress)}%`}</div>
                    <div className="stat-label">Progress to target</div>
                  </div>
                  <div className="stat-card">
                    <div className="stat-value">{daysLogged}<span className="stat-unit"> / 7</span></div>
                    <div className="stat-label">Days logged this week</div>
                  </div>
                </div>

                <section className="section">
                  <div className="section-header">
                    <div>
                      <h3>This week</h3>
                      <p className="section-subtitle section-subtitle-tight">Log a day at a time, or fill in the whole week.</p>
                    </div>
                    <button
                      className="btn-primary"
                      onClick={() => {
                        setCheckinMode('day');
                        setCheckinDay(todayIndex);
                        goClient('checkin');
                      }}
                    >
                      Log today
                    </button>
                  </div>
                  <div className="week-strip">
                    {weekDays.map((d) => (
                      <button
                        key={d.key}
                        className={`week-day ${d.saved ? 'saved' : ''} ${d.key === todayKey ? 'today' : ''}`}
                        onClick={() => {
                          setCheckinMode('day');
                          setCheckinDay(d.index);
                          goClient('checkin');
                        }}
                      >
                        <span className="week-day-name">{d.label}</span>
                        <span className="week-day-date">{d.date.getDate()}</span>
                        <span className="week-day-state">{d.saved ? 'Logged' : 'Empty'}</span>
                      </button>
                    ))}
                  </div>
                </section>

                <div className="two-col">
                  <section className="section">
                    <h3>Next session with your coach</h3>
                    {nextEvents.length === 0 ? (
                      <p className="empty-state">Nothing scheduled yet. Your coach will add your next feedback session here.</p>
                    ) : (
                      <button className="upcoming-item" onClick={() => setSelectedEventId(nextEvents[0].id)}>
                        <span className={`upcoming-icon ${nextEvents[0].type}`}>
                          <Icon name={nextEvents[0].type === 'meet' ? 'video' : 'mail'} size={16} />
                        </span>
                        <span className="upcoming-main">
                          <span className="activity-name">
                            {formatWhen(nextEvents[0].dateKey, formatTime(toDate(nextEvents[0].startAt)))}
                          </span>
                          <span className="activity-sub">
                            {nextEvents[0].type === 'meet' ? 'Google Meet 1-on-1' : 'Feedback by email'}
                          </span>
                        </span>
                      </button>
                    )}
                  </section>

                  <section className="section">
                    <div className="section-header">
                      <h3>Your profile</h3>
                      <button className="btn-secondary" onClick={() => goClient('profile')}>Edit</button>
                    </div>
                    <dl className="profile-facts compact">
                      <div><dt>Date of birth</dt><dd>{dob ? formatDate(parseDateKey(dob)) : '-'}</dd></div>
                      <div><dt>Height</dt><dd>{fmt(profile?.height, 0, ' cm')}</dd></div>
                      <div><dt>Gym</dt><dd>{profile?.gym || '-'}</dd></div>
                      <div><dt>Activity level</dt><dd className="capitalize">{profile?.activityLevel || '-'}</dd></div>
                    </dl>
                  </section>
                </div>

                <section className="section">
                  <h3>Check-in history</h3>
                  {pastCheckIns.length === 0 ? (
                    <p className="empty-state">Earlier weeks will show up here.</p>
                  ) : (
                    <div className="checkins-list">
                      {pastCheckIns.map((ci) => (
                        <div key={ci.id} className="checkin-summary">
                          <h4>
                            {ci.weekKey
                              ? `Week of ${formatDate(parseDateKey(ci.weekKey))}`
                              : `Check-in on ${formatDate(toDate(ci.createdAt))}`}
                          </h4>
                          <p>{(ci.days || []).filter(dayHasData).length} days logged</p>
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              </div>
            )}

            {currentPage === 'checkin' && (
              <div className="dashboard-view">
                <div className="page-header page-header-row">
                  <div>
                    <h2>Weekly Check-in</h2>
                    <p>Week of {formatDate(parseDateKey(weekKey))}. {daysLogged} of 7 days logged.</p>
                  </div>
                  <div className="seg" role="group" aria-label="Check-in mode">
                    <button
                      className={`seg-btn ${checkinMode === 'day' ? 'active' : ''}`}
                      onClick={() => setCheckinMode('day')}
                    >
                      <span>Day by day</span>
                    </button>
                    <button
                      className={`seg-btn ${checkinMode === 'week' ? 'active' : ''}`}
                      onClick={() => setCheckinMode('week')}
                    >
                      <span>Whole week</span>
                    </button>
                  </div>
                </div>

                {checkinMode === 'day' && (
                  <>
                    <div className="week-strip">
                      {weekDays.map((d) => (
                        <button
                          key={d.key}
                          className={`week-day ${d.saved ? 'saved' : ''} ${d.key === todayKey ? 'today' : ''} ${
                            d.index === checkinDay ? 'selected' : ''
                          }`}
                          onClick={() => {
                            setClientNotice(null);
                            setCheckinDay(d.index);
                          }}
                          aria-pressed={d.index === checkinDay}
                        >
                          <span className="week-day-name">{d.label}</span>
                          <span className="week-day-date">{d.date.getDate()}</span>
                          <span className="week-day-state">{d.saved ? 'Logged' : 'Empty'}</span>
                        </button>
                      ))}
                    </div>

                    <section className="section">
                      <h3>
                        {selectedDay.label} {formatDate(selectedDay.date)}
                        {selectedDay.saved && <span className="badge active saved-badge">saved</span>}
                      </h3>
                      <form
                        key={`day-${weekDoc ? weekDoc.id : 'new'}-${checkinDay}-${savedStamp}`}
                        className="form"
                        onSubmit={handleSaveDay}
                      >
                        <div className="form-row">
                          <div className="form-group">
                            <label>Weight (kg)</label>
                            <input
                              type="number"
                              name="weight"
                              step="0.1"
                              defaultValue={selectedDay.saved?.weight > 0 ? selectedDay.saved.weight : ''}
                            />
                          </div>
                          <div className="form-group">
                            <label>Water (liters)</label>
                            <input
                              type="number"
                              name="water"
                              step="0.5"
                              min="0"
                              defaultValue={selectedDay.saved?.water > 0 ? selectedDay.saved.water : ''}
                            />
                          </div>
                        </div>
                        {['breakfast', 'lunch', 'dinner', 'snacks'].map((meal) => (
                          <div className="form-group" key={meal}>
                            <label className="capitalize">{meal}</label>
                            <input
                              type="text"
                              name={meal}
                              placeholder={meal === 'snacks' ? 'Any snacks?' : 'What did you eat?'}
                              defaultValue={selectedDay.saved?.meals?.[meal] || ''}
                            />
                          </div>
                        ))}
                        <div className="modal-actions modal-actions-left">
                          <button type="submit" value="save" className="btn-primary" disabled={loading}>
                            {loading ? 'Saving...' : 'Save day'}
                          </button>
                          {checkinDay < 7 && (
                            <button type="submit" value="next" className="btn-secondary" disabled={loading}>
                              Save and go to {WEEKDAYS[checkinDay]}
                            </button>
                          )}
                        </div>
                      </form>
                    </section>
                  </>
                )}

                {checkinMode === 'week' && (
                  <form
                    key={`week-${weekDoc ? weekDoc.id : 'new'}-${savedStamp}`}
                    className="form weekly-form"
                    onSubmit={handleSaveWeek}
                  >
                    {weekDays.map((d) => (
                      <div key={d.key} className="day-section">
                        <h4>{d.label} {formatDate(d.date)}</h4>
                        <div className="form-row">
                          <div className="form-group">
                            <label>Weight (kg)</label>
                            <input
                              type="number"
                              name={`weight-${d.index}`}
                              step="0.1"
                              defaultValue={d.saved?.weight > 0 ? d.saved.weight : ''}
                            />
                          </div>
                          <div className="form-group">
                            <label>Water (liters)</label>
                            <input
                              type="number"
                              name={`water-${d.index}`}
                              step="0.5"
                              min="0"
                              defaultValue={d.saved?.water > 0 ? d.saved.water : ''}
                            />
                          </div>
                        </div>
                        <div className="form-row">
                          <div className="form-group">
                            <label>Breakfast</label>
                            <input type="text" name={`breakfast-${d.index}`} defaultValue={d.saved?.meals?.breakfast || ''} placeholder="What did you eat?" />
                          </div>
                          <div className="form-group">
                            <label>Lunch</label>
                            <input type="text" name={`lunch-${d.index}`} defaultValue={d.saved?.meals?.lunch || ''} placeholder="What did you eat?" />
                          </div>
                        </div>
                        <div className="form-row">
                          <div className="form-group">
                            <label>Dinner</label>
                            <input type="text" name={`dinner-${d.index}`} defaultValue={d.saved?.meals?.dinner || ''} placeholder="What did you eat?" />
                          </div>
                          <div className="form-group">
                            <label>Snacks</label>
                            <input type="text" name={`snacks-${d.index}`} defaultValue={d.saved?.meals?.snacks || ''} placeholder="Any snacks?" />
                          </div>
                        </div>
                      </div>
                    ))}
                    <button type="submit" className="btn-primary" disabled={loading}>
                      {loading ? 'Saving...' : 'Save whole week'}
                    </button>
                  </form>
                )}
              </div>
            )}

            {currentPage === 'learning' && <LearningPage />}

            {currentPage === 'calendar' && (
              <div className="dashboard-view">
                <div className="page-header">
                  <h2>Calendar</h2>
                  <p>Your feedback sessions with {coachInfo ? coachInfo.name : 'your coach'}.</p>
                </div>

                <section className="section calendar-section">
                  <div className="cal-toolbar">
                    <div className="cal-nav">
                      <button
                        className="btn-icon"
                        aria-label="Previous month"
                        onClick={() => setCalendarMonth(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1))}
                      >
                        <Icon name="back" size={16} />
                      </button>
                      <button
                        className="btn-icon"
                        aria-label="Next month"
                        onClick={() => setCalendarMonth(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1))}
                      >
                        <Icon name="expand" size={16} />
                      </button>
                      <h3 className="cal-title">
                        {calendarMonth.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
                      </h3>
                    </div>
                    <button
                      className="btn-secondary"
                      onClick={() => {
                        const n = new Date();
                        setCalendarMonth(new Date(n.getFullYear(), n.getMonth(), 1));
                      }}
                    >
                      Today
                    </button>
                  </div>

                  <div className="cal-grid cal-weekdays">
                    {WEEKDAYS.map((w) => (
                      <div key={w}>{w}</div>
                    ))}
                  </div>
                  <div className="cal-grid">
                    {myGrid.map((cell) => {
                      const dayEvents = myEventsByDay[cell.key] || [];
                      const isBirthday = dob && dob.slice(5) === cell.key.slice(5);
                      return (
                        <div
                          key={cell.key}
                          className={`cal-cell ${cell.inMonth ? '' : 'muted'} ${cell.key === todayKey ? 'today' : ''}`}
                        >
                          <span className="cal-day">{cell.date.getDate()}</span>
                          {dayEvents.slice(0, 3).map((ev) => (
                            <button
                              key={ev.id}
                              className={`cal-chip ${ev.type} ${ev.status}`}
                              onClick={() => setSelectedEventId(ev.id)}
                            >
                              <Icon name={ev.type === 'meet' ? 'video' : 'mail'} size={12} />
                              <span>{formatTime(toDate(ev.startAt))} Feedback</span>
                            </button>
                          ))}
                          {isBirthday && (
                            <span className="cal-chip birthday">
                              <Icon name="gift" size={12} />
                              <span>Birthday</span>
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </section>

                <section className="section">
                  <h3>Upcoming</h3>
                  {nextEvents.length === 0 ? (
                    <p className="empty-state">No sessions scheduled. Your coach will add them here.</p>
                  ) : (
                    <ul className="upcoming-list">
                      {nextEvents.slice(0, 8).map((ev) => (
                        <li key={ev.id}>
                          <button className="upcoming-item" onClick={() => setSelectedEventId(ev.id)}>
                            <span className={`upcoming-icon ${ev.type}`}>
                              <Icon name={ev.type === 'meet' ? 'video' : 'mail'} size={16} />
                            </span>
                            <span className="upcoming-main">
                              <span className="activity-name">{formatWhen(ev.dateKey, formatTime(toDate(ev.startAt)))}</span>
                              <span className="activity-sub">{ev.type === 'meet' ? 'Google Meet 1-on-1' : 'Feedback by email'}</span>
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              </div>
            )}

            {currentPage === 'chat' && (
              <div className="dashboard-view">
                <div className="page-header">
                  <h2>Chat</h2>
                  <p>Message your coach directly from BodUp.</p>
                </div>
                <section className="section chat-placeholder">
                  <Icon name="chat" size={36} />
                  <h3>Chat is coming soon</h3>
                  <p>You will be able to message {coachInfo ? coachInfo.name : 'your coach'} here. For now, your coach will reach you by email.</p>
                  <button className="btn-secondary" onClick={() => goClient('dashboard')}>Back to dashboard</button>
                </section>
              </div>
            )}

            {currentPage === 'profile' && (
              <div className="page-view">
                <div className="page-header">
                  <button className="btn-back icon-text" onClick={() => goClient('dashboard')}>
                    <Icon name="back" size={16} /> Back
                  </button>
                  <h2>My Profile</h2>
                  <p>Keep this up to date so your coach can help you better.</p>
                </div>
                <section className="section">
                  <form className="form" onSubmit={handleSaveProfile}>
                    <ProfileFields profile={profile} />
                    <button type="submit" className="btn-primary" disabled={loading}>
                      {loading ? 'Saving...' : 'Save Profile'}
                    </button>
                  </form>
                </section>
              </div>
            )}
          </main>
        </div>

        {selectedClientEvent && (
          <Modal title="Feedback session" onClose={() => setSelectedEventId(null)}>
            <dl className="event-facts">
              <div>
                <dt>When</dt>
                <dd>{formatWhen(selectedClientEvent.dateKey, formatTime(toDate(selectedClientEvent.startAt)))}</dd>
              </div>
              <div>
                <dt>Type</dt>
                <dd>{selectedClientEvent.type === 'meet' ? 'Google Meet 1-on-1' : 'Feedback by email'}</dd>
              </div>
              <div><dt>Coach</dt><dd>{coachInfo ? coachInfo.name : '-'}</dd></div>
              <div><dt>Status</dt><dd className="capitalize">{selectedClientEvent.status}</dd></div>
            </dl>
            <div className="modal-actions">
              <button className="btn-secondary" onClick={() => setSelectedEventId(null)}>Close</button>
              {selectedClientEvent.meetLink && (
                <a
                  className="btn-primary btn-link"
                  href={selectedClientEvent.meetLink}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Join Google Meet
                </a>
              )}
            </div>
          </Modal>
        )}

        {activeModal === 'install' && <InstallModal onClose={closeModal} />}

        {activeModal === 'contact' && (
          <Modal title="Contact admin" onClose={closeModal}>
            <form className="form" onSubmit={handleSendAdminMessage}>
              <p className="section-subtitle">Ask a question or report a problem. The admin replies to {user.email}.</p>
              <div className="form-group">
                <label>Subject</label>
                <input type="text" name="subject" required />
              </div>
              <div className="form-group">
                <label>Message</label>
                <textarea name="message" rows="5" required />
              </div>
              {modalMessage && <p className={`form-message ${modalMessage.type}`}>{modalMessage.text}</p>}
              <div className="modal-actions">
                <button type="button" className="btn-secondary" onClick={closeModal}>Close</button>
                <button type="submit" className="btn-primary" disabled={loading}>
                  {loading ? 'Sending...' : 'Send message'}
                </button>
              </div>
            </form>
          </Modal>
        )}

        {activeModal === 'close' && (
          <Modal title="Close account" onClose={closeModal}>
            <div className="form">
              <p className="warning-text">
                Closing your account signs you out and you will not be able to sign in again. Your coach will see that you
                have left, and automated messages to you will stop.
              </p>
              <div className="form-group">
                <label>Type CLOSE to confirm</label>
                <input
                  type="text"
                  value={closeConfirm}
                  onChange={(e) => setCloseConfirm(e.target.value)}
                  autoComplete="off"
                />
              </div>
              {modalMessage && <p className={`form-message ${modalMessage.type}`}>{modalMessage.text}</p>}
              <div className="modal-actions">
                <button type="button" className="btn-secondary" onClick={closeModal}>Keep my account</button>
                <button
                  type="button"
                  className="btn-danger"
                  disabled={closeConfirm !== 'CLOSE' || loading}
                  onClick={handleCloseAccount}
                >
                  {loading ? 'Closing...' : 'Close account'}
                </button>
              </div>
            </div>
          </Modal>
        )}
      </div>
    );
  }
}

// The root adds the home screen prompt, which appears once a coach finishes registration
export default function Root() {
  if (window.location.pathname.startsWith('/auth-action')) {
    return <AuthActionPage />;
  }
  return (
    <>
      <FestiveLayer />
      <App />
      <InstallPromptHost />
    </>
  );
}
