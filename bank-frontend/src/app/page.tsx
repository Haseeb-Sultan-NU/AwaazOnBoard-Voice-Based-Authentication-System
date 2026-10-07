"use client";

import { useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";

// ───────────────────────── Config ─────────────────────────
const AWAAZ_URL = "http://localhost:8000";
const BANK_URL = "http://localhost:8001";
const DEMO_PASSWORD = "admin123";
const URDU_FONT = '"Noto Nastaliq Urdu","Jameel Noori Nastaleeq","Segoe UI",Tahoma,sans-serif';

// ───────────────────────── Types ──────────────────────────
type Category = "income" | "bills" | "groceries" | "transfer" | "dining" | "transport";

type Txn = {
  id: string;
  recipient: string;
  category: Category;
  date: string;
  amount: number; // signed: negative = debit
};

type Account = {
  name: string;
  accountNumber: string;
  balance: number;
  transactions: Txn[];
};

type Banner = { kind: "ok" | "err"; text: string; heard?: string } | null;

// ───────────────────────── Helpers ────────────────────────
const pkr = (n: number) => `PKR ${n.toLocaleString("en-US")}`;

const todayLabel = () =>
  new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

const fmtCnic = (d: string) => [d.slice(0, 5), d.slice(5, 12), d.slice(12, 13)].filter(Boolean).join("-");

const fmtTimer = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

const SEED_TXNS: Txn[] = [
  { id: "s1", recipient: "Acme Technologies", category: "income", date: "1 Oct 2026", amount: 65000 },
  { id: "s2", recipient: "K-Electric", category: "bills", date: "3 Oct 2026", amount: -8450 },
  { id: "s3", recipient: "Imtiaz Supermarket", category: "groceries", date: "4 Oct 2026", amount: -6550 },
  { id: "s4", recipient: "Ahmed Raza", category: "transfer", date: "5 Oct 2026", amount: -2000 },
  { id: "s5", recipient: "Foodpanda", category: "dining", date: "6 Oct 2026", amount: -1850 },
  { id: "s6", recipient: "Careem", category: "transport", date: "6 Oct 2026", amount: -700 },
];

const CATEGORY_META: Record<Category, { label: string; icon: IconName; tone: string }> = {
  income: { label: "Income", icon: "briefcase", tone: "bg-emerald-500/15 text-emerald-300" },
  bills: { label: "Bills", icon: "bolt", tone: "bg-amber-500/15 text-amber-300" },
  groceries: { label: "Groceries", icon: "cart", tone: "bg-sky-500/15 text-sky-300" },
  transfer: { label: "Transfer", icon: "send", tone: "bg-violet-500/15 text-violet-300" },
  dining: { label: "Dining", icon: "utensils", tone: "bg-rose-500/15 text-rose-300" },
  transport: { label: "Transport", icon: "car", tone: "bg-cyan-500/15 text-cyan-300" },
};

function parseDigits(data: any): string[] {
  const raw = data?.digits ?? data?.challenge ?? data?.expected_challenge ?? data?.challenge_digits ?? "";
  if (Array.isArray(raw)) return raw.map(String);
  return String(raw).match(/\d/g) ?? [];
}

function toNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v.replace(/[^0-9.-]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Re-encode recorded audio as 16-bit mono WAV so the Python backends can read it. */
async function toWav(blob: Blob): Promise<Blob> {
  const ctx = new AudioContext();
  const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
  await ctx.close();
  const samples = buf.getChannelData(0);
  const out = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const write = (o: number, s: string) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
  write(0, "RIFF");
  out.setUint32(4, 36 + samples.length * 2, true);
  write(8, "WAVE");
  write(12, "fmt ");
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true);
  out.setUint16(22, 1, true);
  out.setUint32(24, buf.sampleRate, true);
  out.setUint32(28, buf.sampleRate * 2, true);
  out.setUint16(32, 2, true);
  out.setUint16(34, 16, true);
  write(36, "data");
  out.setUint32(40, samples.length * 2, true);
  samples.forEach((s, i) => {
    const c = Math.max(-1, Math.min(1, s));
    out.setInt16(44 + i * 2, c < 0 ? c * 0x8000 : c * 0x7fff, true);
  });
  return new Blob([out], { type: "audio/wav" });
}

async function errorText(res: Response, fallback: string) {
  try {
    const d = await res.json();
    return d?.detail ? (typeof d.detail === "string" ? d.detail : JSON.stringify(d.detail)) : d?.message ?? fallback;
  } catch {
    return fallback;
  }
}

const netErr = (e: any, service: string, port: number) =>
  e instanceof TypeError ? `Can't reach the ${service} on port ${port}. Check that it's running.` : e?.message ?? "Something went wrong.";

// ───────────────────────── Icons (inline SVG) ─────────────
type IconName =
  | "mic" | "shield" | "shieldCheck" | "bolt" | "send" | "receipt" | "file" | "arrowUpRight" | "arrowDownLeft"
  | "cart" | "car" | "utensils" | "briefcase" | "eye" | "eyeOff" | "lock" | "check" | "alert" | "x"
  | "logout" | "fingerprint" | "trendUp" | "wave" | "contactless" | "user" | "refresh";

const ICONS: Record<IconName, ReactNode> = {
  mic: (<><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6" /></>),
  shield: <path d="M12 3l8 3v6c0 4.500-3.200 8.200-8 9-4.800-.8-8-4.500-8-9V6l8-3z" />,
  shieldCheck: (<><path d="M12 3l8 3v6c0 4.500-3.200 8.200-8 9-4.800-.8-8-4.500-8-9V6l8-3z" /><path d="M8.500 12l2.500 2.500 4.500-5" /></>),
  bolt: <path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z" />,
  send: <path d="M21 3L10 14M21 3l-7 18-4-7-7-4 18-7z" />,
  receipt: (<><path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3z" /><path d="M9 8h6M9 12h6" /></>),
  file: (<><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5z" /><path d="M14 3v5h5M9 13h6M9 17h6" /></>),
  arrowUpRight: <path d="M7 17L17 7M8 7h9v9" />,
  arrowDownLeft: <path d="M17 7L7 17M16 17H7V8" />,
  cart: (<><circle cx="9" cy="20" r="1.500" /><circle cx="18" cy="20" r="1.500" /><path d="M3 4h2.500l2.200 11h10.600L21 7H6.500" /></>),
  car: (<><path d="M5 16l1.500-5.500A2 2 0 0 1 8.400 9h7.200a2 2 0 0 1 1.900 1.500L19 16" /><rect x="3" y="16" width="18" height="4" rx="1.500" /><path d="M7.500 18h.01M16.500 18h.01" /></>),
  utensils: <path d="M6 3v7a2 2 0 0 0 2 2v9M10 3v7M6 3v7M18 3c-2 2-3 4.500-3 7h3v11" />,
  briefcase: (<><rect x="3" y="7" width="18" height="13" rx="2" /><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M3 13h18" /></>),
  eye: (<><path d="M2 12s3.500-7 10-7 10 7 10 7-3.500 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></>),
  eyeOff: <path d="M3 3l18 18M10.600 6.100A10 10 0 0 1 12 5c6.500 0 10 7 10 7a17 17 0 0 1-3.200 4M6.200 7.700A17 17 0 0 0 2 12s3.500 7 10 7c1.600 0 3-.4 4.300-1M9.900 9.900a3 3 0 0 0 4.200 4.200" />,
  lock: (<><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></>),
  check: <path d="M5 12.500l4.500 4.500L19 7.500" />,
  alert: (<><path d="M12 3l10 18H2L12 3z" /><path d="M12 10v5M12 18h.01" /></>),
  x: <path d="M6 6l12 12M18 6L6 18" />,
  logout: <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />,
  fingerprint: <path d="M6 9a6 6 0 0 1 12 0M4 13c0-1 .2-2 .5-3M9 21c-1-2-1-4-1-6a4 4 0 0 1 8 0c0 3 .5 5 1.500 7M12 14c0 3 .5 5 1.500 7M20 14c0 2-.3 4-1 5" />,
  trendUp: <path d="M3 17l6-6 4 4 8-8M15 7h6v6" />,
  wave: <path d="M4 10v4M8 6v12M12 3v18M16 7v10M20 10v4" />,
  contactless: <path d="M8 8a8 8 0 0 1 0 12M12 5a13 13 0 0 1 0 18M4 11a4 4 0 0 1 0 6" />,
  user: (<><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>),
  refresh: <path d="M20 11a8 8 0 0 0-14-4L4 9M4 4v5h5M4 13a8 8 0 0 0 14 4l2-2M20 20v-5h-5" />,
};

function Icon({ name, className = "h-5 w-5" }: { name: IconName; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {ICONS[name]}
    </svg>
  );
}

function Logo({ size = 38 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id="fs-logo-g" x1="8" y1="4" x2="40" y2="44" gradientUnits="userSpaceOnUse">
          <stop stopColor="#6ee7b7" />
          <stop offset="1" stopColor="#047857" />
        </linearGradient>
      </defs>
      <path d="M24 3l17 6v13c0 10.500-7 18.500-17 23C14 40.500 7 32.500 7 22V9l17-6z" fill="url(#fs-logo-g)" />
      <path d="M17 34V15h14M17 24.500h9.500" stroke="#022c22" strokeWidth="3.600" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M28 33l3.500-3.500L35 33" stroke="#022c22" strokeOpacity=".55" strokeWidth="2.400" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ChipIcon() {
  return (
    <svg width="46" height="35" viewBox="0 0 46 35" fill="none" aria-hidden="true">
      <rect x="1" y="1" width="44" height="33" rx="7" fill="#fcd34d" fillOpacity=".92" />
      <path
        d="M1 12h15M1 23h15M30 12h15M30 23h15M16 1v33M30 1v33M16 12h14M16 23h14"
        stroke="#92400e"
        strokeOpacity=".5"
      />
    </svg>
  );
}

function Styles() {
  return (
    <style>{`
      @keyframes fsWave { 0%,100% { transform: scaleY(.22); } 50% { transform: scaleY(1); } }
      @keyframes fsRing { 0% { transform: scale(1); opacity: .55; } 100% { transform: scale(2); opacity: 0; } }
      @media (prefers-reduced-motion: reduce) { .fs-anim { animation: none !important; } }
    `}</style>
  );
}

// ───────────────────────── Header ─────────────────────────
function Header({ userName, onLogout }: { userName?: string; onLogout?: () => void }) {
  return (
    <header className="sticky top-0 z-30 border-b border-slate-800 bg-slate-950/85 backdrop-blur">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
        <div className="flex items-center gap-3">
          <Logo />
          <div className="leading-tight">
            <p className="text-lg font-semibold tracking-tight text-white">FinSecure Bank</p>
            <p className="hidden text-xs text-slate-400 sm:block">Digital banking, secured by voice</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="hidden items-center gap-2 rounded-full border border-slate-800 bg-slate-900 px-3 py-1.5 text-xs text-slate-300 lg:flex">
            <span className="relative flex h-2 w-2">
              <span className="fs-anim absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
            </span>
            Operational | 256-bit Encrypted
          </div>

          {userName ? (
            <>
              <div className="hidden items-center gap-3 sm:flex">
                <span className="flex h-9 w-9 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-300">
                  <Icon name="user" className="h-5 w-5" />
                </span>
                <p className="text-sm text-slate-300">
                  Welcome back, <span className="font-medium text-white">{userName}</span>
                </p>
              </div>
              <button
                onClick={onLogout}
                className="flex items-center gap-2 rounded-lg border border-slate-700 px-3.5 py-2 text-sm text-slate-200 hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
              >
                <Icon name="logout" className="h-4 w-4" />
                Log out
              </button>
            </>
          ) : (
            <div className="flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-300">
              <Icon name="shieldCheck" className="h-4 w-4" />
              <span className="hidden sm:inline">Biometrics Powered by Awaaz AI</span>
              <span className="sm:hidden">Awaaz AI</span>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

function Shell({ children, userName, onLogout }: { children: ReactNode; userName?: string; onLogout?: () => void }) {
  return (
    <div className="relative min-h-screen overflow-x-hidden bg-slate-950 text-slate-100">
      <Styles />
      <div className="pointer-events-none absolute inset-0" aria-hidden="true">
        <div className="absolute -left-40 -top-40 h-[480px] w-[480px] rounded-full bg-emerald-600/10 blur-3xl" />
        <div className="absolute -right-40 top-1/3 h-[420px] w-[420px] rounded-full bg-teal-500/10 blur-3xl" />
        <svg className="absolute inset-0 h-full w-full opacity-[0.04]" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <pattern id="fs-grid" width="44" height="44" patternUnits="userSpaceOnUse">
              <path d="M44 0H0v44" fill="none" stroke="white" strokeWidth="1" />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#fs-grid)" />
        </svg>
      </div>
      <div className="relative">
        <Header userName={userName} onLogout={onLogout} />
        {children}
        <footer className="mx-auto max-w-7xl px-4 pb-8 pt-4 text-xs text-slate-500 sm:px-6">
          FinSecure Bank is a demonstration platform built for an academic final-year project. No real funds move.
        </footer>
      </div>
    </div>
  );
}

// ───────────────────────── Page ───────────────────────────
export default function Page() {
  const [cnic, setCnic] = useState("3333333333333");
  const [authed, setAuthed] = useState(false);
  const [account, setAccount] = useState<Account | null>(null);
  const [tab, setTab] = useState<"voice" | "password">("voice");

  // voice login
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [digits, setDigits] = useState<string[]>([]);
  const [loadingChallenge, setLoadingChallenge] = useState(false);
  const [loggingIn, setLoggingIn] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // password login
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [pwError, setPwError] = useState<string | null>(null);

  // dashboard
  const [commandBusy, setCommandBusy] = useState(false);
  const [banner, setBanner] = useState<Banner>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showCvv, setShowCvv] = useState(false);
  const assistantRef = useRef<HTMLDivElement>(null);

  // recorder
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  useEffect(() => {
    if (!recording) {
      setSeconds(0);
      return;
    }
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [recording]);

  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(null), 4500);
    return () => clearTimeout(id);
  }, [notice]);

  const startRecording = async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    streamRef.current = stream;
    chunksRef.current = [];
    const mr = new MediaRecorder(stream);
    mr.ondataavailable = (e) => e.data.size > 0 && chunksRef.current.push(e.data);
    recorderRef.current = mr;
    mr.start();
    setRecording(true);
  };

  const stopRecording = () =>
    new Promise<{ blob: Blob; filename: string }>((resolve) => {
      const mr = recorderRef.current!;
      mr.onstop = async () => {
        streamRef.current?.getTracks().forEach((t) => t.stop());
        setRecording(false);
        const raw = new Blob(chunksRef.current, { type: mr.mimeType });
        try {
          resolve({ blob: await toWav(raw), filename: "voice.wav" });
        } catch {
          resolve({ blob: raw, filename: "voice.webm" });
        }
      };
      mr.stop();
    });

  const openSession = (data: any = {}) => {
    const bal = toNumber(data.balance ?? data.current_balance ?? data.account?.balance) ?? 50000;
    setAccount({
      name: data.name ?? data.full_name ?? data.account_holder ?? data.account?.name ?? "Test User",
      accountNumber: data.account_number ?? data.account?.account_number ?? `FSB-${cnic.slice(-6)}-001`,
      balance: bal,
      transactions: SEED_TXNS,
    });
    setAuthed(true);
    setSessionId(null);
    setDigits([]);
    setError(null);
    setPassword("");
  };

  // ── Voice login, step 1 ──
  const requestChallenge = async () => {
    setError(null);
    setLoadingChallenge(true);
    setSessionId(null);
    setDigits([]);
    try {
      const url = `${AWAAZ_URL}/authenticate/challenge`;
      let res = await fetch(url, { method: "POST" });
      if (res.status === 405) res = await fetch(url, { method: "GET" });
      if (!res.ok) throw new Error(await errorText(res, `Challenge request failed (${res.status}).`));
      const data = await res.json();
      const d = parseDigits(data);
      if (!data.session_id || d.length === 0) throw new Error("The challenge response was missing a session or digits.");
      setSessionId(data.session_id);
      setDigits(d);
    } catch (e: any) {
      setError(netErr(e, "voice service", 8000));
    } finally {
      setLoadingChallenge(false);
    }
  };

  // ── Voice login, step 2 ──
  const toggleLoginRecording = async () => {
    setError(null);
    if (!recording) {
      try {
        await startRecording();
      } catch {
        setError("Microphone access was blocked. Allow it in your browser settings and try again.");
      }
      return;
    }
    const { blob, filename } = await stopRecording();
    setLoggingIn(true);
    try {
      const fd = new FormData();
      fd.append("cnic", cnic);
      fd.append("session_id", sessionId ?? "");
      fd.append("audio", blob, filename);
      const res = await fetch(`${BANK_URL}/bank/login`, { method: "POST", body: fd });
      if (res.status === 401) {
        setError(await errorText(res, "Voice verification failed. Request a new challenge and try again."));
        setSessionId(null);
        setDigits([]);
        return;
      }
      if (!res.ok) throw new Error(await errorText(res, `Login failed (${res.status}).`));
      openSession(await res.json().catch(() => ({})));
    } catch (e: any) {
      setError(netErr(e, "bank service", 8001));
    } finally {
      setLoggingIn(false);
    }
  };

  // ── Password login (demo fallback) ──
  const passwordLogin = (e: FormEvent) => {
    e.preventDefault();
    setPwError(null);
    if (cnic.length !== 13) return setPwError("Enter your 13-digit CNIC.");
    if (password !== DEMO_PASSWORD) return setPwError("Incorrect CNIC or password. Try again.");
    openSession();
  };

  // ── Urdu voice command ──
  const toggleCommandRecording = async () => {
    if (!recording) {
      try {
        setBanner(null);
        await startRecording();
      } catch {
        setBanner({ kind: "err", text: "Microphone access was blocked. Allow it in your browser settings and try again." });
      }
      return;
    }
    const { blob, filename } = await stopRecording();
    setCommandBusy(true);
    try {
      const fd = new FormData();
      fd.append("cnic", cnic);
      fd.append("audio", blob, filename);
      const res = await fetch(`${BANK_URL}/bank/command`, { method: "POST", body: fd });
      if (!res.ok) throw new Error(await errorText(res, `Command failed (${res.status}).`));
      const data = await res.json();

      setAccount((prev) => {
        if (!prev) return prev;
        const t = data.transaction ?? {};
        const amtRaw = toNumber(t.amount ?? data.amount);
        const type = String(t.type ?? data.type ?? data.action ?? "").toLowerCase();
        const signed =
          amtRaw === null ? null : /credit|deposit|receive|income/.test(type) ? Math.abs(amtRaw) : /debit|withdraw|transfer|pay|send|minus/.test(type) ? -Math.abs(amtRaw) : amtRaw;

        let newBal = toNumber(data.new_balance ?? data.balance ?? data.current_balance);
        if (newBal === null && signed !== null) newBal = prev.balance + signed;

        const txn: Txn | null =
          signed !== null
            ? {
              id: `cmd-${Date.now()}`,
              recipient: t.recipient ?? t.description ?? data.recipient ?? data.description ?? "Voice command",
              category: (t.category as Category) in CATEGORY_META ? (t.category as Category) : signed >= 0 ? "income" : "transfer",
              date: t.date ?? todayLabel(),
              amount: signed,
            }
            : null;

        return {
          ...prev,
          balance: newBal ?? prev.balance,
          transactions: txn ? [txn, ...prev.transactions] : prev.transactions,
        };
      });

      setBanner({
        kind: "ok",
        text: data.message ?? data.result ?? "Command executed.",
        heard: data.transcript ?? data.transcription,
      });
    } catch (e: any) {
      setBanner({ kind: "err", text: netErr(e, "bank service", 8001) });
    } finally {
      setCommandBusy(false);
    }
  };

  const logout = () => {
    setAuthed(false);
    setAccount(null);
    setBanner(null);
    setNotice(null);
    setError(null);
    setSessionId(null);
    setDigits([]);
    setShowCvv(false);
  };

  // ═════════════════════ Login portal ═════════════════════
  if (!authed || !account) {
    const features: { icon: IconName; title: string; body: string }[] = [
      { icon: "fingerprint", title: "Zero-Password Biometric Auth", body: "Your voice replaces the password. Nothing to remember, nothing to phish." },
      { icon: "arrowUpRight", title: "Instant Interbank Transfers", body: "Send money to any bank account in Pakistan, around the clock." },
      { icon: "wave", title: "Native Urdu Voice Banking", body: "Check balances and send money by speaking naturally in Urdu." },
    ];

    return (
      <Shell>
        <main className="mx-auto grid max-w-7xl items-center gap-12 px-4 py-10 sm:px-6 lg:grid-cols-2 lg:py-16">
          {/* Hero */}
          <section>
            <h1 className="max-w-xl text-4xl font-semibold leading-[1.1] tracking-tight text-white sm:text-5xl">
              Banking that recognises you by your voice.
            </h1>
            <p className="mt-5 max-w-lg text-lg leading-relaxed text-slate-400">
              FinSecure replaces passwords with speaker verification, so only you can open your account, even over a phone line.
            </p>

            <ul className="mt-9 space-y-4">
              {features.map((f) => (
                <li key={f.title} className="flex gap-4 rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-emerald-500/15 text-emerald-300">
                    <Icon name={f.icon} className="h-6 w-6" />
                  </span>
                  <div>
                    <p className="font-medium text-white">{f.title}</p>
                    <p className="mt-0.5 text-sm text-slate-400">{f.body}</p>
                  </div>
                </li>
              ))}
            </ul>

            <ol className="mt-8 flex max-w-lg flex-wrap items-center gap-x-3 gap-y-2 text-sm text-slate-400">
              {["Coercion check", "Liveness check", "Voice match"].map((s, i) => (
                <li key={s} className="flex items-center gap-3">
                  <span className="flex items-center gap-2">
                    <span className="flex h-6 w-6 items-center justify-center rounded-full border border-emerald-500/40 text-xs text-emerald-300">
                      {i + 1}
                    </span>
                    {s}
                  </span>
                  {i < 2 && <span className="h-px w-6 bg-slate-700" />}
                </li>
              ))}
            </ol>
          </section>

          {/* Auth card */}
          <section className="w-full max-w-md justify-self-center rounded-3xl border border-slate-800 bg-slate-900/80 p-6 shadow-2xl shadow-black/40 backdrop-blur sm:p-8 lg:justify-self-end">
            <h2 className="text-xl font-semibold text-white">Sign in to your account</h2>
            <p className="mt-1 text-sm text-slate-400">Choose how you'd like to verify it's you.</p>

            <div role="tablist" className="mt-6 grid grid-cols-2 gap-1 rounded-xl border border-slate-800 bg-slate-950/70 p-1">
              {(
                [
                  { id: "voice", label: "Voice Biometrics", badge: "Recommended" },
                  { id: "password", label: "Standard Password" },
                ] as const
              ).map((t) => (
                <button
                  key={t.id}
                  role="tab"
                  aria-selected={tab === t.id}
                  disabled={recording}
                  onClick={() => setTab(t.id)}
                  className={`flex flex-col items-center justify-center gap-0.5 rounded-lg px-2 py-2.5 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:cursor-not-allowed ${tab === t.id ? "bg-slate-800 text-white" : "text-slate-400 hover:text-slate-200"
                    }`}
                >
                  {t.label}
                  {"badge" in t && (
                    <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-medium text-emerald-300">
                      {t.badge}
                    </span>
                  )}
                </button>
              ))}
            </div>

            {/* CNIC (shared) */}
            <label htmlFor="cnic" className="mt-6 block text-sm font-medium text-slate-300">
              CNIC number
            </label>
            <input
              id="cnic"
              value={fmtCnic(cnic)}
              onChange={(e) => setCnic(e.target.value.replace(/\D/g, "").slice(0, 13))}
              placeholder="33333-3333333-3"
              inputMode="numeric"
              autoComplete="off"
              className="mt-1.5 w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 tabular-nums tracking-wide text-white placeholder:text-slate-600 focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
            />

            {tab === "voice" ? (
              <div role="tabpanel">
                {error && (
                  <div role="alert" className="mt-5 flex items-start gap-3 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
                    <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>{error}</span>
                  </div>
                )}

                <button
                  onClick={requestChallenge}
                  disabled={loadingChallenge || recording || loggingIn || cnic.length !== 13}
                  className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl border border-slate-700 bg-slate-800 py-3 font-medium text-white hover:bg-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Icon name="refresh" className={`h-4 w-4 ${loadingChallenge ? "fs-anim animate-spin" : ""}`} />
                  {loadingChallenge ? "Requesting…" : "Step 1: Request Challenge"}
                </button>

                <div className="mt-4 rounded-2xl border border-emerald-500/30 bg-emerald-500/5 p-4 text-center" aria-live="polite">
                  {digits.length > 0 ? (
                    <>
                      <p className="text-sm text-emerald-200">Read these digits aloud when you record</p>
                      <div className="mt-3 flex justify-center gap-3">
                        {digits.map((d, i) => (
                          <span
                            key={i}
                            className="flex h-[72px] w-14 items-center justify-center rounded-xl border border-emerald-400/50 bg-slate-950 text-4xl font-bold tabular-nums text-emerald-300 shadow-[0_0_28px_rgba(16,185,129,0.25)]"
                          >
                            {d}
                          </span>
                        ))}
                      </div>
                    </>
                  ) : (
                    <p className="py-3 text-sm text-slate-500">Your three-digit challenge will appear here.</p>
                  )}
                </div>

                <button
                  onClick={toggleLoginRecording}
                  disabled={!sessionId || loggingIn}
                  className={`mt-4 flex w-full items-center justify-center gap-3 rounded-xl py-3 font-medium text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900 disabled:cursor-not-allowed disabled:opacity-50 ${recording
                    ? "bg-red-600 hover:bg-red-500 focus-visible:ring-red-400"
                    : "bg-emerald-600 hover:bg-emerald-500 focus-visible:ring-emerald-400"
                    }`}
                >
                  {recording ? (
                    <>
                      <span className="flex h-5 items-center gap-0.5" aria-hidden="true">
                        {[0, 1, 2, 3, 4].map((i) => (
                          <span
                            key={i}
                            className="fs-anim block h-5 w-1 origin-center rounded-full bg-white"
                            style={{ animation: `fsWave 0.9s ease-in-out ${i * 0.12}s infinite` }}
                          />
                        ))}
                      </span>
                      Recording {fmtTimer(seconds)}. Press to verify
                    </>
                  ) : loggingIn ? (
                    "Verifying your voice…"
                  ) : (
                    <>
                      <Icon name="mic" className="h-5 w-5" />
                      Step 2: Record Voice &amp; Verify
                    </>
                  )}
                </button>
              </div>
            ) : (
              <form role="tabpanel" onSubmit={passwordLogin}>
                {pwError && (
                  <div role="alert" className="mt-5 flex items-start gap-3 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
                    <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>{pwError}</span>
                  </div>
                )}
                <label htmlFor="pw" className="mt-5 block text-sm font-medium text-slate-300">
                  Password
                </label>
                <div className="relative mt-1.5">
                  <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-500">
                    <Icon name="lock" className="h-5 w-5" />
                  </span>
                  <input
                    id="pw"
                    type={showPw ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="current-password"
                    className="w-full rounded-xl border border-slate-700 bg-slate-950 py-3 pl-11 pr-12 text-white focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPw((v) => !v)}
                    aria-label={showPw ? "Hide password" : "Show password"}
                    className="absolute right-3 top-1/2 -translate-y-1/2 rounded p-1 text-slate-400 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                  >
                    <Icon name={showPw ? "eyeOff" : "eye"} className="h-5 w-5" />
                  </button>
                </div>
                <button
                  type="submit"
                  className="mt-5 w-full rounded-xl bg-emerald-600 py-3 font-medium text-white hover:bg-emerald-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900"
                >
                  Sign In
                </button>
                <p className="mt-3 text-center text-xs text-slate-500">
                  Demo fallback: use password <span className="font-mono text-slate-300">{DEMO_PASSWORD}</span>
                </p>
              </form>
            )}
          </section>
        </main>
      </Shell>
    );
  }

  // ═════════════════════ Dashboard ═════════════════════
  const quickActions: { key: string; label: string; icon: IconName }[] = [
    { key: "send", label: "Send Money", icon: "send" },
    { key: "bills", label: "Bill Payments", icon: "receipt" },
    { key: "statement", label: "Statement", icon: "file" },
    { key: "voice", label: "Voice Assistant", icon: "mic" },
  ];

  const onQuickAction = (key: string, label: string) => {
    if (key === "voice") {
      assistantRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    setNotice(`${label} is a preview screen in this demo. Use the voice assistant below to move money.`);
  };

  const wave = [14, 26, 38, 20, 44, 30, 18, 40, 24, 34, 16, 28, 42, 22, 36, 18, 30, 40, 20, 32, 26, 38, 16, 28];

  return (
    <Shell userName={account.name} onLogout={logout}>
      <main className="mx-auto max-w-7xl space-y-6 px-4 py-8 sm:px-6">
        {notice && (
          <div role="status" className="flex items-center gap-3 rounded-xl border border-slate-700 bg-slate-900 px-4 py-3 text-sm text-slate-200">
            <Icon name="alert" className="h-4 w-4 text-emerald-300" />
            {notice}
          </div>
        )}

        <div className="grid gap-6 lg:grid-cols-12">
          {/* Debit card */}
          <section className="lg:col-span-5" aria-label="Debit card">
            <div className="relative aspect-[1.586/1] w-full max-w-md overflow-hidden rounded-3xl border border-emerald-400/20 bg-gradient-to-br from-emerald-600 via-emerald-800 to-slate-900 p-6 shadow-2xl shadow-emerald-950/50">
              <div className="pointer-events-none absolute -right-16 -top-16 h-56 w-56 rounded-full border-[28px] border-white/5" />
              <div className="pointer-events-none absolute -bottom-24 -left-10 h-64 w-64 rounded-full border-[28px] border-white/5" />
              <div className="relative flex h-full flex-col justify-between">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-2">
                    <Logo size={26} />
                    <span className="font-semibold tracking-tight text-white">FinSecure</span>
                  </div>
                  <Icon name="contactless" className="h-7 w-7 text-white/80" />
                </div>

                <ChipIcon />

                <div>
                  <p className="text-xl tabular-nums tracking-[0.18em] text-white sm:text-2xl">•••• •••• •••• 8492</p>
                  <div className="mt-4 flex items-end justify-between text-white">
                    <div>
                      <p className="text-[11px] text-emerald-100/70">Cardholder</p>
                      <p className="text-sm font-medium">{account.name}</p>
                    </div>
                    <div>
                      <p className="text-[11px] text-emerald-100/70">Expires</p>
                      <p className="text-sm font-medium tabular-nums">09/29</p>
                    </div>
                    <div>
                      <p className="text-[11px] text-emerald-100/70">CVV</p>
                      <button
                        onClick={() => setShowCvv((v) => !v)}
                        aria-label={showCvv ? "Hide CVV" : "Show CVV"}
                        className="flex items-center gap-1.5 text-sm font-medium tabular-nums focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
                      >
                        {showCvv ? "417" : "•••"}
                        <Icon name={showCvv ? "eyeOff" : "eye"} className="h-3.5 w-3.5 text-white/70" />
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </section>

          {/* Balance + quick actions */}
          <div className="grid gap-6 lg:col-span-7">
            <section className="rounded-3xl border border-slate-800 bg-slate-900/70 p-6">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <p className="text-sm text-slate-400">Available balance</p>
                  <p className="mt-2 text-4xl font-semibold tabular-nums tracking-tight text-white sm:text-5xl">
                    {pkr(account.balance)}
                  </p>
                  <p className="mt-2 text-sm text-slate-500">
                    Account <span className="tabular-nums text-slate-300">{account.accountNumber}</span>
                  </p>
                </div>
                <span className="flex items-center gap-1.5 rounded-full bg-emerald-500/15 px-3 py-1.5 text-sm font-medium text-emerald-300">
                  <Icon name="trendUp" className="h-4 w-4" />
                  +2.4% this month
                </span>
              </div>
              <svg viewBox="0 0 400 70" className="mt-5 h-16 w-full" preserveAspectRatio="none" aria-hidden="true">
                <defs>
                  <linearGradient id="fs-spark" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0" stopColor="#10b981" stopOpacity=".35" />
                    <stop offset="1" stopColor="#10b981" stopOpacity="0" />
                  </linearGradient>
                </defs>
                <path d="M0 52 L45 46 L90 50 L135 36 L180 40 L225 28 L270 32 L315 18 L360 22 L400 10 L400 70 L0 70 Z" fill="url(#fs-spark)" />
                <path d="M0 52 L45 46 L90 50 L135 36 L180 40 L225 28 L270 32 L315 18 L360 22 L400 10" fill="none" stroke="#34d399" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </section>

            <section className="grid grid-cols-2 gap-3 sm:grid-cols-4" aria-label="Quick actions">
              {quickActions.map((a) => (
                <button
                  key={a.key}
                  onClick={() => onQuickAction(a.key, a.label)}
                  className="group flex flex-col items-center gap-3 rounded-2xl border border-slate-800 bg-slate-900/70 px-3 py-5 text-sm font-medium text-slate-200 hover:border-emerald-500/50 hover:bg-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                >
                  <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-emerald-500/15 text-emerald-300 group-hover:bg-emerald-500/25">
                    <Icon name={a.icon} className="h-6 w-6" />
                  </span>
                  {a.label}
                </button>
              ))}
            </section>
          </div>
        </div>

        {/* Urdu assistant */}
        <section
          ref={assistantRef}
          className="rounded-3xl border border-emerald-500/25 bg-slate-900/80 p-6 shadow-[0_0_60px_rgba(16,185,129,0.08)] sm:p-8"
          aria-label="Urdu voice assistant"
        >
          <div className="flex flex-col items-center gap-6 md:flex-row">
            <div className="relative flex h-28 w-28 shrink-0 items-center justify-center">
              {recording && (
                <>
                  <span className="fs-anim absolute inset-4 rounded-full bg-emerald-500/40" style={{ animation: "fsRing 1.6s ease-out infinite" }} />
                  <span className="fs-anim absolute inset-4 rounded-full bg-emerald-500/40" style={{ animation: "fsRing 1.6s ease-out .8s infinite" }} />
                </>
              )}
              <button
                onClick={toggleCommandRecording}
                disabled={commandBusy}
                aria-label={recording ? "Stop recording and send" : "Speak Urdu command"}
                className={`relative flex h-20 w-20 items-center justify-center rounded-full text-white transition-colors focus:outline-none focus-visible:ring-4 focus-visible:ring-emerald-300/60 disabled:opacity-60 ${recording
                  ? "bg-red-600 shadow-[0_0_45px_rgba(239,68,68,0.55)]"
                  : "bg-emerald-500 shadow-[0_0_45px_rgba(16,185,129,0.6)] hover:bg-emerald-400"
                  }`}
              >
                {recording ? (
                  <svg viewBox="0 0 24 24" className="h-7 w-7" fill="currentColor" aria-hidden="true">
                    <rect x="6" y="6" width="12" height="12" rx="2.500" />
                  </svg>
                ) : (
                  <Icon name="mic" className="h-9 w-9" />
                )}
              </button>
            </div>

            <div className="min-w-0 flex-1 text-center md:text-left">
              <h2 className="text-xl font-semibold text-white">
                {commandBusy ? "Processing your command…" : recording ? `Listening ${fmtTimer(seconds)}. Press to send` : "Speak Urdu Command"}
              </h2>
              <p className="mt-2 text-slate-400">Press the microphone and say what you need. For example:</p>
              <p dir="rtl" lang="ur" className="mt-3 inline-block rounded-xl border border-slate-700 bg-slate-950 px-4 py-2 text-lg leading-loose text-emerald-200" style={{ fontFamily: URDU_FONT }}>
                بولیں: 'پانچ سو روپے علی کو بھیجو'
              </p>
            </div>

            <div className="hidden h-12 items-center gap-[3px] lg:flex" aria-hidden="true">
              {wave.map((h, i) => (
                <span
                  key={i}
                  className="fs-anim block w-1 origin-center rounded-full bg-emerald-400"
                  style={{
                    height: h,
                    opacity: recording ? 1 : 0.25,
                    animation: recording ? `fsWave 1s ease-in-out ${(i % 8) * 0.09}s infinite` : undefined,
                  }}
                />
              ))}
            </div>
          </div>

          {banner && (
            <div
              role="status"
              className={`mt-6 flex items-start gap-3 rounded-xl border px-4 py-3 text-sm ${banner.kind === "ok"
                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-100"
                : "border-red-500/30 bg-red-500/10 text-red-200"
                }`}
            >
              <Icon name={banner.kind === "ok" ? "check" : "alert"} className="mt-0.5 h-4 w-4 shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="font-medium">{banner.kind === "ok" ? "Command executed" : "Command failed"}</p>
                <p className="mt-0.5 opacity-90">{banner.text}</p>
                {banner.heard && (
                  <p className="mt-1 opacity-75">
                    Heard:{" "}
                    <span dir="auto" lang="ur" style={{ fontFamily: URDU_FONT }}>
                      {banner.heard}
                    </span>
                  </p>
                )}
              </div>
              <button
                onClick={() => setBanner(null)}
                aria-label="Dismiss"
                className="rounded p-1 opacity-70 hover:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
              >
                <Icon name="x" className="h-4 w-4" />
              </button>
            </div>
          )}
        </section>

        {/* Transactions */}
        <section className="overflow-hidden rounded-3xl border border-slate-800 bg-slate-900/70">
          <div className="flex items-center justify-between border-b border-slate-800 px-6 py-4">
            <h2 className="text-lg font-semibold text-white">Recent transactions</h2>
            <p className="text-sm text-slate-500">{account.transactions.length} entries</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-left text-sm">
              <thead className="text-slate-400">
                <tr className="border-b border-slate-800">
                  <th scope="col" className="px-6 py-3 font-medium">Recipient</th>
                  <th scope="col" className="px-6 py-3 font-medium">Date</th>
                  <th scope="col" className="px-6 py-3 font-medium">Type</th>
                  <th scope="col" className="px-6 py-3 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/80">
                {account.transactions.map((t) => {
                  const meta = CATEGORY_META[t.category] ?? CATEGORY_META.transfer;
                  const credit = t.amount >= 0;
                  return (
                    <tr key={t.id} className="hover:bg-slate-800/40">
                      <td className="px-6 py-3.5">
                        <div className="flex items-center gap-3">
                          <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${meta.tone}`}>
                            <Icon name={meta.icon} className="h-5 w-5" />
                          </span>
                          <div>
                            <p className="font-medium text-white">{t.recipient}</p>
                            <p className="text-xs text-slate-500">{meta.label}</p>
                          </div>
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-6 py-3.5 text-slate-300">{t.date}</td>
                      <td className="px-6 py-3.5">
                        <span className={`inline-flex items-center gap-1 text-slate-300`}>
                          <Icon name={credit ? "arrowDownLeft" : "arrowUpRight"} className={`h-4 w-4 ${credit ? "text-emerald-400" : "text-rose-400"}`} />
                          {credit ? "Credit" : "Debit"}
                        </span>
                      </td>
                      <td className="px-6 py-3.5 text-right">
                        <span
                          className={`inline-block rounded-full px-3 py-1 font-semibold tabular-nums ${credit ? "bg-emerald-500/15 text-emerald-300" : "bg-rose-500/15 text-rose-300"
                            }`}
                        >
                          {credit ? "+" : "−"} {pkr(Math.abs(t.amount))}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </Shell>
  );
}
