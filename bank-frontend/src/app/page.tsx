"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import AudioVisualizer from "@/components/AudioVisualizer";

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

type CheckState = "pass" | "fail" | "skipped" | "not_evaluated" | "unknown";

/** Structured "why it failed" payload returned by the bank on biometric 401s. */
type Forensics = {
  channel: "login" | "command";
  similarity_score: number | null; // raw ECAPA cosine
  threshold: number;
  margin: number | null;
  liveness_passed: boolean;
  flags: string[];
  checks: { speech_present: CheckState; single_speaker: CheckState; replay_defence: CheckState; voiceprint: CheckState };
  primary_factor: string;
  explanation: string;
  awaaz_message?: string;
};

type PendingTx = { token: string; amount: number; recipient: string; named: boolean; prompt: string; expiresAt: number; ttlMs: number };

type Banner = {
  kind: "ok" | "err" | "info";
  text: string;
  heard?: string;
  biometric?: boolean;
  stepUp?: boolean;
  forensics?: Forensics;
} | null;

// ───────────────────────── Helpers ────────────────────────
const pkr = (n: number) => `PKR ${n.toLocaleString("en-US")}`;

const todayLabel = () =>
  new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

const fmtCnic = (d: string) => [d.slice(0, 5), d.slice(5, 12), d.slice(12, 13)].filter(Boolean).join("-");

type SectionId = "voice-section" | "transactions-section";

/** Smooth-scroll a dashboard section into view (instant for reduced-motion users). */
const scrollToSection = (id: SectionId) => {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  document.getElementById(id)?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
};

const fmtTimer = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

const ACCOUNT_HOLDER = "Haseeb Sultan";

const SEED_TXNS: Txn[] = [
  { id: "s1", recipient: "Careem Rides, Islamabad", category: "transport", date: "6 Oct 2026", amount: -1240 },
  { id: "s2", recipient: "Savour Foods, Blue Area", category: "dining", date: "6 Oct 2026", amount: -2180 },
  { id: "s3", recipient: "Raast P2P: Muhammad Usman", category: "transfer", date: "5 Oct 2026", amount: -15000 },
  { id: "s4", recipient: "Imtiaz Super Market, G-11", category: "groceries", date: "5 Oct 2026", amount: -11865 },
  { id: "s5", recipient: "IESCO Electricity Bill", category: "bills", date: "4 Oct 2026", amount: -14326 },
  { id: "s6", recipient: "SNGPL Gas Bill", category: "bills", date: "4 Oct 2026", amount: -3912 },
  { id: "s7", recipient: "Nayatel Fiber Internet", category: "bills", date: "3 Oct 2026", amount: -4999 },
  { id: "s8", recipient: "JazzCash Wallet Top-up", category: "transfer", date: "3 Oct 2026", amount: -5000 },
  { id: "s9", recipient: "Shell Pakistan, F-8 Markaz", category: "transport", date: "2 Oct 2026", amount: -9500 },
  { id: "s10", recipient: "IBFT In: Ali Raza (Meezan Bank)", category: "income", date: "2 Oct 2026", amount: 12000 },
  { id: "s11", recipient: "Salary Credit: Systems Limited", category: "income", date: "1 Oct 2026", amount: 165000 },
];

/** Pakistani IBAN layout: PK + 2 check digits + 4-letter bank code + 16-digit account. */
const ibanFor = (cnic: string) => {
  const acct = `0000${cnic.padStart(12, "0").slice(-12)}`;
  return `PK36 FSBL ${acct.match(/.{4}/g)!.join(" ")}`;
};

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

const AUTH_FALLBACK = "Voice authentication failed. Please try again.";

// Ordered by priority: a Gatekeeper rejection also lists the skipped stages
// ("… | Liveness FAIL: Skipped — no human speech detected. | Biometric FAIL: Skipped …"),
// so the specific security causes must be matched before the generic ones.
/** Index into AUTH_STEPS where a failure surfaces in the "Processing Biometrics" checklist. */
type AuthStage = 0 | 1 | 2 | 3;
type LoginFailure = { message: string; stage: AuthStage; forensics?: Forensics };

const AWAAZ_ERROR_RULES: { test: RegExp; message: string; stage: AuthStage }[] = [
  { test: /multiple speakers/i, message: "Security Alert: Multiple voices detected. Please authenticate in a quiet room.", stage: 1 },
  { test: /audio replay|replay attack/i, message: "Security Alert: Electronic audio replay detected. Live voice required.", stage: 1 },
  { test: /no human speech/i, message: "No speech detected. Please recite the digits clearly.", stage: 1 },
  { test: /biometric fail|similarity|did not match baseline/i, message: "Voice signature does not match the account owner.", stage: 3 },
  { test: /liveness fail|did not match the requested prompt/i, message: "The spoken digits didn't match the challenge. Request a new challenge and recite the digits shown.", stage: 1 },
  { test: /invalid or expired session/i, message: "Your challenge has expired. Request a new challenge and try again.", stage: 0 },
  { test: /template not found|no biometric enrollment/i, message: "No voiceprint is enrolled for this CNIC. Please complete voice enrollment first.", stage: 2 },
];

/** Map a technical Awaaz diagnostic string to a user-facing message and the step that failed. */
function classifyAwaazError(reason: string | undefined): LoginFailure {
  const rule = reason ? AWAAZ_ERROR_RULES.find((r) => r.test.test(reason)) : undefined;
  return rule ? { message: rule.message, stage: rule.stage } : { message: AUTH_FALLBACK, stage: 3 };
}

const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;

const asString = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);

/**
 * Turn a /bank/login 401 body into one clean sentence. Shapes handled:
 *   { detail: { message, awaaz: { message | detail } } }   Awaaz rejected the voice
 *   { detail: "Voice verified, but no bank account…" }     bank-side, already human-readable
 */
async function loginFailureMessage(res: Response): Promise<LoginFailure> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { message: AUTH_FALLBACK, stage: 3 };
  }
  const rec = asRecord(body);
  const forensics = parseForensics(rec?.forensics) ?? undefined;
  const detail = rec?.detail;

  // Current bank shape: { detail: "…", forensics, awaaz }; older: { detail: { message, awaaz } }.
  const awaaz = asRecord(rec?.awaaz) ?? asRecord(asRecord(detail)?.awaaz);
  if (awaaz) {
    const reason = asString(awaaz.message) ?? asString(awaaz.detail);
    return { ...classifyAwaazError(reason), forensics };
  }

  if (typeof detail === "string") {
    // Pass bank-authored messages through (e.g. "no bank account is linked" fails at the
    // final match step); only translate raw pipeline output.
    return /FAIL|REJECT|session|template/i.test(detail) ? { ...classifyAwaazError(detail), forensics } : { message: detail, stage: 3, forensics };
  }
  return { message: AUTH_FALLBACK, stage: 3, forensics };
}

const CHECK_STATES: CheckState[] = ["pass", "fail", "skipped", "not_evaluated", "unknown"];

/** Validate the bank's forensics object; anything malformed is dropped rather than rendered. */
function parseForensics(v: unknown): Forensics | null {
  const f = asRecord(v);
  const checks = asRecord(f?.checks);
  if (!f || !checks || typeof f.primary_factor !== "string") return null;
  const st = (x: unknown): CheckState => (CHECK_STATES.includes(x as CheckState) ? (x as CheckState) : "unknown");
  const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : null);
  return {
    channel: f.channel === "command" ? "command" : "login",
    similarity_score: num(f.similarity_score),
    threshold: num(f.threshold) ?? 0.2393,
    margin: num(f.margin),
    liveness_passed: f.liveness_passed === true,
    flags: Array.isArray(f.flags) ? f.flags.filter((x): x is string => typeof x === "string") : [],
    checks: {
      speech_present: st(checks.speech_present),
      single_speaker: st(checks.single_speaker),
      replay_defence: st(checks.replay_defence),
      voiceprint: st(checks.voiceprint),
    },
    primary_factor: f.primary_factor,
    explanation: typeof f.explanation === "string" ? f.explanation : "",
    awaaz_message: asString(f.awaaz_message),
  };
}

// ── "Processing Biometrics" sequence ──
const AUTH_STEPS = [
  "Securing audio payload...",
  "Liveness Check: Scanning for real human speech...",
  "Biometric Engine: Extracting vocal signature...",
  "Computing final security match...",
] as const;
const AUTH_STEP_MS = 800; // cadence of the automatic cascade
const AUTH_HOLD_STEP = 2; // "Extracting vocal signature" spins until the backend answers

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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
      @keyframes fsSpin { to { transform: rotate(360deg); } }
      @keyframes fsBreathe { 0%,100% { transform: scale(1); } 50% { transform: scale(1.06); } }
      @keyframes fsRise { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
      @media (prefers-reduced-motion: reduce) { .fs-anim { animation: none !important; } }
    `}</style>
  );
}

// ───────────────────────── Biometric Security Audit modal ──
const GAUGE_MIN = -0.5;
const GAUGE_MAX = 1;
const gaugePos = (v: number) => `${((Math.min(GAUGE_MAX, Math.max(GAUGE_MIN, v)) - GAUGE_MIN) / (GAUGE_MAX - GAUGE_MIN)) * 100}%`;

const CHECK_BADGE: Record<CheckState, { label: string; cls: string }> = {
  pass: { label: "Pass", cls: "border-emerald-400/40 bg-emerald-500/10 text-emerald-300" },
  fail: { label: "Fail", cls: "border-rose-400/50 bg-rose-500/15 text-rose-300" },
  skipped: { label: "Skipped", cls: "border-slate-600 bg-slate-800/60 text-slate-400" },
  not_evaluated: { label: "Not evaluated", cls: "border-slate-600 bg-slate-800/60 text-slate-400" },
  unknown: { label: "Unknown", cls: "border-slate-700 bg-slate-900 text-slate-500" },
};

function checkRows(f: Forensics): { key: keyof Forensics["checks"]; title: string; icon: IconName; detail: string }[] {
  return [
    { key: "speech_present", title: "Liveness · speech presence", icon: "wave", detail: "Gatekeeper confirms a live human voice is present" },
    { key: "single_speaker", title: "Single-speaker verification", icon: "user", detail: "pyannote diarization must find exactly one voice" },
    {
      key: "replay_defence",
      title: "Replay detection",
      icon: "shield",
      detail:
        f.channel === "login"
          ? "One-time random digit challenge, which a pre-recorded clip cannot contain"
          : "Per-command re-auth has no challenge; protected by the already-verified session",
    },
    { key: "voiceprint", title: "Voiceprint match", icon: "fingerprint", detail: "ECAPA-TDNN cosine similarity vs the EER threshold" },
  ];
}

function ForensicsModal({ data, onClose }: { data: Forensics; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      opener?.focus?.();
    };
  }, [onClose]);

  const sim = data.similarity_score;
  const t = data.threshold;
  const pass = sim != null && sim >= t;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-6" role="presentation">
      <div className="absolute inset-0 bg-black/75 backdrop-blur-sm" onClick={onClose} aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="audit-title"
        className="relative flex max-h-[92vh] w-full max-w-2xl flex-col overflow-hidden rounded-t-3xl border border-white/10 bg-gradient-to-b from-slate-900 via-slate-950 to-black shadow-[0_40px_120px_rgba(0,0,0,0.7)] sm:rounded-3xl"
        style={{ animation: "fsRise .3s ease-out both" }}
      >
        <div className="h-px w-full bg-gradient-to-r from-transparent via-amber-300/60 to-transparent" aria-hidden="true" />

        {/* Header */}
        <div className="flex items-start justify-between gap-4 border-b border-white/5 px-6 py-5 sm:px-8">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-amber-200/70">Awaaz Forensics</p>
            <h2 id="audit-title" className="mt-1 text-xl font-semibold text-white sm:text-2xl">Biometric Security Audit</h2>
            <p className="mt-1 text-xs text-slate-500">
              {data.channel === "login" ? "Challenge-response sign-in" : "Per-command continuous authentication"}
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close audit"
            className="rounded-full border border-white/10 p-2 text-slate-400 transition-colors hover:border-white/20 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-300/60"
          >
            <Icon name="x" className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-6 overflow-y-auto px-6 py-6 sm:px-8" style={{ scrollbarWidth: "thin", scrollbarColor: "rgba(148,163,184,0.25) transparent" }}>
          {/* Verdict */}
          <section className="rounded-2xl border border-rose-500/25 bg-gradient-to-br from-rose-500/10 to-transparent p-5">
            <p className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-rose-300/80">
              <Icon name="alert" className="h-3.5 w-3.5" />
              Blocking factor
            </p>
            <p className="mt-1.5 text-lg font-semibold text-white">{data.primary_factor}</p>
            <p className="mt-2 text-sm leading-relaxed text-slate-300">{data.explanation}</p>
            {data.flags.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2">
                {data.flags.map((flag) => (
                  <span key={flag} className="rounded-full border border-rose-400/30 bg-rose-500/10 px-2.5 py-0.5 text-xs font-medium text-rose-200">
                    {flag}
                  </span>
                ))}
              </div>
            )}
          </section>

          {/* Cosine gauge */}
          <section>
            <div className="flex items-baseline justify-between">
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Cosine similarity · ECAPA-TDNN</h3>
              <span className="font-mono text-xs text-slate-500">range {GAUGE_MIN} → {GAUGE_MAX}</span>
            </div>
            {sim == null ? (
              <div className="mt-3 rounded-xl border border-dashed border-slate-700 px-4 py-5 text-center text-sm text-slate-400">
                Not computed. The attempt was stopped by the Gatekeeper before the voiceprint was compared.
              </div>
            ) : (
              <>
                <div className="relative mt-8 h-3 rounded-full bg-gradient-to-r from-rose-600/70 via-amber-500/60 to-emerald-500/80">
                  {/* threshold */}
                  <div className="absolute -top-6 bottom-[-6px] w-px bg-amber-200" style={{ left: gaugePos(t) }}>
                    <span className="absolute -top-0.5 left-1/2 -translate-x-1/2 -translate-y-full whitespace-nowrap font-mono text-[10px] text-amber-200">
                      threshold {t.toFixed(4)}
                    </span>
                  </div>
                  {/* score */}
                  <div className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2" style={{ left: gaugePos(sim) }}>
                    <span className={`block h-5 w-5 rounded-full border-2 border-white shadow-lg ${pass ? "bg-emerald-500" : "bg-rose-500"}`} />
                  </div>
                </div>
                <div className="mt-1.5 flex justify-between font-mono text-[10px] text-slate-600">
                  <span>{GAUGE_MIN}</span>
                  <span>0</span>
                  <span>0.5</span>
                  <span>{GAUGE_MAX}</span>
                </div>
                <dl className="mt-4 grid grid-cols-3 gap-3">
                  {[
                    ["Your score", sim.toFixed(4), pass ? "text-emerald-300" : "text-rose-300"],
                    ["Required", `≥ ${t.toFixed(4)}`, "text-amber-200"],
                    ["Margin", `${(sim - t >= 0 ? "+" : "")}${(sim - t).toFixed(4)}`, pass ? "text-emerald-300" : "text-rose-300"],
                  ].map(([k, v, tone]) => (
                    <div key={k} className="rounded-xl border border-white/5 bg-white/[0.02] px-3 py-2.5">
                      <dt className="text-[10px] uppercase tracking-wider text-slate-500">{k}</dt>
                      <dd className={`mt-0.5 font-mono text-base font-semibold tabular-nums ${tone}`}>{v}</dd>
                    </div>
                  ))}
                </dl>
              </>
            )}
          </section>

          {/* Security checks */}
          <section>
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Security checks</h3>
            <ul className="mt-3 grid gap-2.5 sm:grid-cols-2">
              {checkRows(data).map((row) => {
                const state = data.checks[row.key];
                const badge = CHECK_BADGE[state];
                return (
                  <li key={row.key} className="rounded-xl border border-white/5 bg-white/[0.02] p-3.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex items-center gap-2 text-sm font-medium text-slate-200">
                        <Icon name={row.icon} className="h-4 w-4 text-slate-500" />
                        {row.title}
                      </span>
                      <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide ${badge.cls}`}>
                        {badge.label}
                      </span>
                    </div>
                    <p className="mt-1.5 text-xs leading-relaxed text-slate-500">{row.detail}</p>
                  </li>
                );
              })}
            </ul>
          </section>

          {data.awaaz_message && (
            <section>
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Identity provider verdict</h3>
              <p className="mt-2 break-words rounded-xl border border-white/5 bg-black/40 px-3 py-2.5 font-mono text-[11.5px] leading-relaxed text-slate-400">
                {data.awaaz_message}
              </p>
            </section>
          )}
        </div>

        <div className="flex justify-end border-t border-white/5 px-6 py-4 sm:px-8">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-white/10 bg-white/5 px-5 py-2 text-sm font-medium text-slate-200 transition-colors hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-300/60"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function InspectButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-current/30 px-2.5 py-1 text-xs font-semibold opacity-90 transition-opacity hover:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/50"
    >
      <Icon name="fingerprint" className="h-3.5 w-3.5" />
      Inspect Diagnostic Breakdown
    </button>
  );
}

const fmtCountdown = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

// ───────────────────────── Biometric verification view ─────
function MiniSpinner() {
  return (
    <svg viewBox="0 0 24 24" className="fs-anim h-4 w-4 text-emerald-300" style={{ animation: "fsSpin .8s linear infinite" }} aria-hidden="true">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity=".25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

/**
 * step: index of the active step (0–3), or AUTH_STEPS.length once every step passed.
 * result: null while running; "success" / "fail" once the backend has answered
 * (on "fail", `step` is the step that failed).
 */
function BiometricProgress({ step, result }: { step: number; result: "success" | "fail" | null }) {
  const fail = result === "fail";
  const success = result === "success";
  const accent = fail ? "#f43f5e" : "#10b981"; // rose-500 / emerald-500
  const title = success ? "Identity Verified" : fail ? "Verification Failed" : "Processing Biometrics";
  const subtitle = success
    ? "Welcome back. Opening your dashboard…"
    : fail
      ? "Returning you to sign-in…"
      : "Hold still for a moment while Awaaz verifies your voice.";
  const live = success ? title : fail ? `${title}: ${AUTH_STEPS[step] ?? ""}` : AUTH_STEPS[Math.min(step, AUTH_STEPS.length - 1)];

  return (
    <div className="flex flex-col items-center py-4 text-center" style={{ animation: "fsRise .45s ease-out both" }}>
      {/* Ring */}
      <div className="relative h-40 w-40">
        {!result && (
          <>
            <span className="fs-anim absolute inset-0 rounded-full border-2 border-emerald-400/40" style={{ animation: "fsRing 2.2s ease-out infinite" }} />
            <span className="fs-anim absolute inset-0 rounded-full border-2 border-teal-300/30" style={{ animation: "fsRing 2.2s ease-out 1.1s infinite" }} />
          </>
        )}
        <div
          className="fs-anim absolute inset-0 rounded-full transition-[background] duration-500"
          style={
            result
              ? { background: accent, boxShadow: `0 0 50px ${accent}99` }
              : {
                background: "conic-gradient(from 0deg, transparent 0deg, #10b981 110deg, #5eead4 190deg, transparent 270deg)",
                animation: "fsSpin 1.4s linear infinite",
              }
          }
        />
        <div className="absolute inset-[5px] rounded-full bg-slate-950" />
        <div
          className={`absolute inset-4 flex items-center justify-center rounded-full ring-1 transition-colors duration-500 ${fail ? "bg-rose-500/10 ring-rose-400/40 text-rose-300" : "bg-emerald-500/10 ring-emerald-400/30 text-emerald-300"
            }`}
        >
          <span className="fs-anim" style={result ? undefined : { animation: "fsBreathe 1.8s ease-in-out infinite" }}>
            <Icon name={success ? "check" : fail ? "x" : "fingerprint"} className="h-16 w-16" />
          </span>
        </div>
      </div>

      <h2 className={`mt-7 text-xl font-semibold ${fail ? "text-rose-200" : "text-white"}`}>{title}</h2>
      <p className="mt-1 text-sm text-slate-400">{subtitle}</p>
      <p className="sr-only" role="status" aria-live="polite">{live}</p>

      {/* Checklist */}
      <ol className="mt-7 w-full space-y-2.5 text-left">
        {AUTH_STEPS.map((label, i) => {
          const done = success || i < step;
          const failed = fail && i === step;
          const active = !result && i === step;
          const state = failed ? "failed" : done ? "done" : active ? "active" : "pending";
          return (
            <li
              key={label}
              className={`flex items-center gap-3 rounded-xl border px-4 py-3 text-sm transition-all duration-500 ${state === "active"
                ? "border-emerald-400/60 bg-emerald-500/10 text-white shadow-[0_0_24px_rgba(16,185,129,0.25)]"
                : state === "done"
                  ? "border-slate-800 bg-slate-950/50 text-slate-300"
                  : state === "failed"
                    ? "border-rose-500/50 bg-rose-500/10 text-rose-100 shadow-[0_0_24px_rgba(244,63,94,0.2)]"
                    : "border-slate-800/70 bg-transparent text-slate-500 opacity-40"
                }`}
            >
              <span className="flex h-5 w-5 shrink-0 items-center justify-center">
                {state === "active" ? (
                  <MiniSpinner />
                ) : state === "done" ? (
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500/20 text-emerald-300">
                    <Icon name="check" className="h-3.5 w-3.5" />
                  </span>
                ) : state === "failed" ? (
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-rose-500/20 text-rose-300">
                    <Icon name="x" className="h-3.5 w-3.5" />
                  </span>
                ) : (
                  <span className="h-2 w-2 rounded-full bg-slate-600" />
                )}
              </span>
              <span className="min-w-0 flex-1">{label}</span>
            </li>
          );
        })}
      </ol>
    </div>
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

        <div className="flex items-center gap-3 sm:gap-4">
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
    <div className="relative min-h-screen overflow-x-clip bg-slate-950 text-slate-100">
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
      </div>
    </div>
  );
}

// ───────────────────────── Page ───────────────────────────
export default function Page() {
  const [cnic, setCnic] = useState("");
  const [authed, setAuthed] = useState(false);
  const [account, setAccount] = useState<Account | null>(null);
  const [tab, setTab] = useState<"voice" | "password">("voice");

  // voice login
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [digits, setDigits] = useState<string[]>([]);
  const [loadingChallenge, setLoadingChallenge] = useState(false);
  const [loggingIn, setLoggingIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authStep, setAuthStep] = useState(0); // active AUTH_STEPS index; AUTH_STEPS.length = all passed
  const [authResult, setAuthResult] = useState<"success" | "fail" | null>(null);
  const [loginForensics, setLoginForensics] = useState<Forensics | null>(null);
  const [inspect, setInspect] = useState<Forensics | null>(null);
  const closeInspect = useCallback(() => setInspect(null), []);

  // password login
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [pwError, setPwError] = useState<string | null>(null);

  // dashboard
  const [commandBusy, setCommandBusy] = useState(false);
  const [banner, setBanner] = useState<Banner>(null);
  const [pendingTx, setPendingTx] = useState<PendingTx | null>(null);
  // Countdown clock for a pending step-up transfer. Starts at 0 (not Date.now()) so render
  // stays deterministic under cacheComponents prerendering; it is set to the real time in the
  // handler that creates pendingTx and ticked by the effect below, and only read while pending.
  const [clock, setClock] = useState(0);
  const [showCvv, setShowCvv] = useState(false);

  // recorder
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [audioStream, setAudioStream] = useState<MediaStream | null>(null); // drives the live visualizer
  const chunksRef = useRef<Blob[]>([]);

  useEffect(() => {
    if (!recording) {
      setSeconds(0);
      return;
    }
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [recording]);

  // Cascade steps 1 → 3 every AUTH_STEP_MS while /bank/login is in flight, then hold
  // on "Extracting vocal signature" until the handler reports the backend's answer.
  useEffect(() => {
    if (!loggingIn || authResult || authStep >= AUTH_HOLD_STEP) return;
    const id = setTimeout(() => setAuthStep((s) => (s < AUTH_HOLD_STEP ? s + 1 : s)), AUTH_STEP_MS);
    return () => clearTimeout(id);
  }, [loggingIn, authResult, authStep]);

  // Step-up window: tick the countdown and expire the pending transfer client-side
  // (the server token expires on its own at the same time).
  useEffect(() => {
    if (!pendingTx) return;
    const tick = setInterval(() => setClock(Date.now()), 1000);
    const expire = setTimeout(() => {
      setPendingTx(null);
      setBanner({ kind: "info", text: "The confirmation window closed. No money was moved; repeat the command to try again." });
    }, Math.max(0, pendingTx.expiresAt - Date.now()));
    return () => {
      clearInterval(tick);
      clearTimeout(expire);
    };
  }, [pendingTx]);

  const startRecording = async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    streamRef.current = stream;
    setAudioStream(stream);
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
        streamRef.current = null;
        setAudioStream(null);
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
      name: data.name ?? data.full_name ?? data.account_holder ?? data.account?.full_name ?? data.account?.name ?? ACCOUNT_HOLDER,
      accountNumber: data.account_number ?? data.account?.account_number ?? ibanFor(cnic),
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
    setLoginForensics(null);
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
    setLoginForensics(null);
    if (!recording) {
      try {
        await startRecording();
      } catch {
        setError("Microphone access was blocked. Allow it in your browser settings and try again.");
      }
      return;
    }
    const { blob, filename } = await stopRecording();
    const started = performance.now();
    setAuthResult(null);
    setAuthStep(0);
    setLoggingIn(true);

    type Outcome = { ok: true; data: unknown } | ({ ok: false; resetChallenge: boolean } & LoginFailure);
    let outcome: Outcome;
    try {
      const fd = new FormData();
      fd.append("cnic", cnic);
      fd.append("session_id", sessionId ?? "");
      fd.append("audio", blob, filename);
      const res = await fetch(`${BANK_URL}/bank/login`, { method: "POST", body: fd });
      if (res.status === 401) {
        outcome = { ok: false, resetChallenge: true, ...(await loginFailureMessage(res)) };
      } else if (!res.ok) {
        outcome = { ok: false, resetChallenge: false, stage: 3, message: await errorText(res, `Login failed (${res.status}).`) };
      } else {
        outcome = { ok: true, data: await res.json().catch(() => ({})) };
      }
    } catch (e: unknown) {
      outcome = { ok: false, resetChallenge: false, stage: 0, message: netErr(e, "bank service", 8001) };
    }

    // A fast response still plays the cascade up to the hold step, so it never reads as a glitch.
    await sleep(Math.max(0, AUTH_HOLD_STEP * AUTH_STEP_MS + 300 - (performance.now() - started)));

    if (outcome.ok) {
      setAuthStep(3); // "Computing final security match..."
      await sleep(750);
      setAuthResult("success");
      setAuthStep(AUTH_STEPS.length);
      await sleep(1000);
      openSession(outcome.data);
    } else {
      if (outcome.stage === 3) {
        setAuthStep(3);
        await sleep(650);
      } else {
        setAuthStep(outcome.stage); // mark the step that actually failed, not a fake pass
      }
      setAuthResult("fail");
      await sleep(1500);
      setError(outcome.message);
      setLoginForensics(outcome.forensics ?? null);
      if (outcome.resetChallenge) {
        setSessionId(null);
        setDigits([]);
      }
    }
    setLoggingIn(false);
    setAuthResult(null);
    setAuthStep(0);
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
    const confirming = pendingTx;
    setCommandBusy(true);
    try {
      const fd = new FormData();
      fd.append("cnic", cnic);
      fd.append("audio", blob, filename);
      if (confirming) fd.append("confirmation_token", confirming.token);
      const res = await fetch(`${BANK_URL}/bank/command`, { method: "POST", body: fd });
      const data = await res.json().catch(() => null);

      if (!res.ok) {
        // 401 → biometric block (with forensics); 410 → token expired/used; 422 → unclear reply.
        if (data?.pending_cleared || res.status === 410) setPendingTx(null);
        setBanner({
          kind: "err",
          text: typeof data?.detail === "string" ? data.detail : `Command failed (${res.status}).`,
          forensics: parseForensics(data?.forensics) ?? undefined,
        });
        return;
      }

      if (data?.status === "CONFIRMATION_REQUIRED") {
        const ttlMs = (toNumber(data.expires_in) ?? 120) * 1000;
        setPendingTx({
          token: String(data.token),
          amount: toNumber(data.pending_tx?.amount) ?? 0,
          recipient: String(data.pending_tx?.recipient ?? "Raast Transfer"),
          named: data.pending_tx?.named_recipient === true,
          prompt: String(data.prompt ?? ""),
          expiresAt: Date.now() + ttlMs,
          ttlMs,
        });
        setClock(Date.now());
        setBanner(null);
        return;
      }

      if (data?.status === "CANCELLED") {
        setPendingTx(null);
        setBanner({ kind: "info", text: data.message ?? "Transfer cancelled. No money was moved.", heard: data.transcript });
        return;
      }

      if (confirming) setPendingTx(null);

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
              recipient: t.recipient ?? t.description ?? data.recipient ?? data.description ?? "Raast Transfer",
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
        biometric: data.biometric?.verified === true,
        stepUp: data.step_up === true,
      });
    } catch (e: any) {
      setBanner({ kind: "err", text: netErr(e, "bank service", 8001) });
    } finally {
      setCommandBusy(false);
    }
  };

  const cancelPendingTx = () => {
    if (!pendingTx) return;
    const to = pendingTx.named ? ` to ${pendingTx.recipient}` : "";
    setPendingTx(null);
    setBanner({ kind: "info", text: `Transfer of ${pkr(pendingTx.amount)}${to} cancelled. No money was moved.` });
  };

  const logout = () => {
    setAuthed(false);
    setAccount(null);
    setBanner(null);
    setPendingTx(null);
    setInspect(null);
    setLoginForensics(null);
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
            {loggingIn ? (
              <BiometricProgress step={authStep} result={authResult} />
            ) : (
            <>
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
              placeholder="00000-0000000-0"
              inputMode="numeric"
              autoComplete="off"
              aria-describedby="cnic-help"
              className="mt-1.5 w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 tabular-nums tracking-wide text-white placeholder:text-slate-600 focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
            />
            <p id="cnic-help" className="mt-1.5 text-xs text-slate-500">
              Enter your 13-digit CNIC
            </p>

            {tab === "voice" ? (
              <div role="tabpanel">
                {error && (
                  <div role="alert" className="mt-5 flex items-start gap-3 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
                    <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" />
                    <div className="min-w-0">
                      <p>{error}</p>
                      {loginForensics && <InspectButton onClick={() => setInspect(loginForensics)} />}
                    </div>
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
            </>
            )}
          </section>
        </main>
        {inspect && <ForensicsModal data={inspect} onClose={closeInspect} />}
      </Shell>
    );
  }

  // ═════════════════════ Dashboard ═════════════════════
  const quickActions: { key: string; label: string; icon: IconName; target: SectionId }[] = [
    { key: "send", label: "Send Money", icon: "send", target: "voice-section" },
    { key: "bills", label: "Bill Payments", icon: "receipt", target: "transactions-section" },
    { key: "statement", label: "Statement", icon: "file", target: "transactions-section" },
    { key: "voice", label: "Voice Assistant", icon: "mic", target: "voice-section" },
  ];

  const wave = [14, 26, 38, 20, 44, 30, 18, 40, 24, 34, 16, 28, 42, 22, 36, 18, 30, 40, 20, 32, 26, 38, 16, 28];

  return (
    <Shell userName={account.name} onLogout={logout}>
      <main className="mx-auto max-w-7xl space-y-10 px-4 py-8 sm:px-6 lg:py-12">
        {/* ── Tier 1: Urdu voice agent (hero) ── */}
        <section
          id="voice-section"
          aria-label="Urdu voice assistant"
          className="relative scroll-mt-24 overflow-hidden rounded-[2rem] border border-emerald-500/30 bg-gradient-to-br from-slate-900 via-slate-900 to-emerald-950/70 px-6 py-10 shadow-[0_0_90px_rgba(16,185,129,0.14)] sm:px-10 sm:py-12 lg:px-14 lg:py-14"
        >
          <div className="pointer-events-none absolute -right-24 -top-24 h-80 w-80 rounded-full bg-emerald-500/15 blur-3xl" aria-hidden="true" />
          <div className="pointer-events-none absolute -bottom-32 left-1/3 h-72 w-72 rounded-full bg-teal-400/10 blur-3xl" aria-hidden="true" />

          <div className="relative grid items-center gap-10 lg:grid-cols-[auto_1fr] lg:gap-14">
            {/* Mic */}
            <div className="relative mx-auto flex h-44 w-44 items-center justify-center sm:h-52 sm:w-52">
              <span className="absolute inset-0 rounded-full border border-emerald-400/15" aria-hidden="true" />
              <span className="absolute inset-5 rounded-full border border-emerald-400/20" aria-hidden="true" />
              {recording && (
                <>
                  <span className="fs-anim absolute inset-10 rounded-full bg-emerald-500/35" style={{ animation: "fsRing 1.6s ease-out infinite" }} />
                  <span className="fs-anim absolute inset-10 rounded-full bg-emerald-500/35" style={{ animation: "fsRing 1.6s ease-out .8s infinite" }} />
                </>
              )}
              <button
                type="button"
                onClick={toggleCommandRecording}
                disabled={commandBusy}
                aria-label={recording ? "Stop recording and send" : pendingTx ? "Record voice confirmation" : "Speak Urdu command"}
                className={`relative flex h-28 w-28 items-center justify-center rounded-full text-white transition-colors focus:outline-none focus-visible:ring-4 focus-visible:ring-emerald-300/60 disabled:opacity-60 sm:h-32 sm:w-32 ${recording
                  ? "bg-red-600 shadow-[0_0_60px_rgba(239,68,68,0.6)]"
                  : "bg-emerald-500 shadow-[0_0_60px_rgba(16,185,129,0.65)] hover:bg-emerald-400"
                  }`}
              >
                {recording ? (
                  <svg viewBox="0 0 24 24" className="h-10 w-10" fill="currentColor" aria-hidden="true">
                    <rect x="6" y="6" width="12" height="12" rx="2.500" />
                  </svg>
                ) : commandBusy ? (
                  <Icon name="refresh" className="fs-anim h-11 w-11 animate-spin" />
                ) : (
                  <Icon name="mic" className="h-12 w-12" />
                )}
              </button>
            </div>

            {/* Copy + examples */}
            <div className="min-w-0 text-center lg:text-left">
              <span className="inline-flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-300">
                <Icon name="shieldCheck" className="h-3.5 w-3.5" />
                Voice Banking
                <span className="hidden sm:inline">· Every command re-verified by Awaaz biometrics</span>
              </span>

              <h1 className="mt-5 text-3xl font-semibold tracking-tight text-white sm:text-4xl lg:text-5xl" aria-live="polite">
                {commandBusy ? "Processing your command…" : recording ? `Listening… ${fmtTimer(seconds)}` : pendingTx ? "Confirm High-Value Transfer" : "Speak Urdu Command"}
              </h1>
              <p className="mx-auto mt-3 max-w-2xl text-base text-slate-400 sm:text-lg lg:mx-0">
                {recording
                  ? "Speak naturally, then press the button again to send."
                  : pendingTx
                    ? "Press the microphone and say your confirmation phrase. Your voiceprint is checked again before any money moves."
                    : "Press the microphone and tell your bank what you need, in Urdu or English."}
              </p>

              <div className={`mt-6 flex-wrap justify-center gap-3 lg:justify-start ${pendingTx ? "hidden" : "flex"}`}>
                {[
                  { label: "Send money", ur: "پانچ سو روپے علی کو بھیجو" },
                  { label: "Check balance", ur: "میرا بیلنس بتاؤ" },
                ].map((ex) => (
                  <div key={ex.label} className="rounded-2xl border border-slate-700/80 bg-slate-950/70 px-4 py-2.5 text-left">
                    <p className="text-[11px] font-medium uppercase tracking-wider text-slate-500">{ex.label}</p>
                    <p dir="rtl" lang="ur" className="text-lg leading-loose text-emerald-200" style={{ fontFamily: URDU_FONT }}>
                      {ex.ur}
                    </p>
                  </div>
                ))}
              </div>

              {recording && audioStream ? (
                <div className="mt-8 h-16 w-full max-w-xl lg:max-w-2xl">
                  <AudioVisualizer stream={audioStream} />
                </div>
              ) : (
                <div className="mt-8 hidden h-16 items-center gap-[3px] sm:flex lg:justify-start" aria-hidden="true">
                  {[...wave, ...wave].map((h, i) => (
                    <span
                      key={i}
                      className="block w-1 rounded-full bg-emerald-400"
                      style={{ height: h, opacity: 0.2 }}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>

          {pendingTx && (() => {
            const left = pendingTx.expiresAt - clock;
            const urgent = left < 30_000;
            return (
              <div
                role="region"
                aria-label="High-value transfer awaiting voice confirmation"
                className="relative mt-10 overflow-hidden rounded-2xl border border-amber-400/30 bg-gradient-to-br from-amber-500/[0.12] via-slate-950/70 to-slate-950/90 p-5 sm:p-6"
                style={{ animation: "fsRise .35s ease-out both" }}
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-200/80">
                    <Icon name="lock" className="h-3.5 w-3.5" />
                    Step-up authorization · High-value transfer
                  </p>
                  <span
                    className={`rounded-full border px-2.5 py-0.5 font-mono text-xs tabular-nums ${urgent ? "border-rose-400/40 bg-rose-500/10 text-rose-300" : "border-amber-300/30 bg-amber-400/10 text-amber-200"}`}
                    aria-label={`Expires in ${fmtCountdown(left)}`}
                  >
                    {fmtCountdown(left)}
                  </span>
                </div>

                <div className="mt-4 grid items-end gap-5 sm:grid-cols-[1fr_auto]">
                  <div className="min-w-0">
                    <p className="text-3xl font-semibold tabular-nums tracking-tight text-white sm:text-4xl">{pkr(pendingTx.amount)}</p>
                    <p className="mt-1 text-sm text-slate-400">
                      {pendingTx.named ? (
                        <>
                          to{" "}
                          <span dir="auto" className="font-medium text-slate-200" style={{ fontFamily: URDU_FONT }}>
                            {pendingTx.recipient}
                          </span>
                        </>
                      ) : (
                        "via Raast instant transfer"
                      )}
                    </p>
                    <div className="mt-4 flex flex-wrap items-center gap-2 text-sm text-slate-300">
                      <span className="text-slate-400">Say</span>
                      <span dir="rtl" lang="ur" className="rounded-lg border border-amber-300/30 bg-black/30 px-3 py-0.5 text-lg leading-loose text-amber-100" style={{ fontFamily: URDU_FONT }}>
                        ہاں کنفرم کرو
                      </span>
                      <span className="text-slate-500">or</span>
                      <span className="rounded-lg border border-amber-300/30 bg-black/30 px-3 py-1.5 font-medium text-amber-100">“Confirm transaction”</span>
                    </div>
                  </div>
                  <div className="flex gap-2 sm:flex-col">
                    <button
                      type="button"
                      onClick={toggleCommandRecording}
                      disabled={commandBusy}
                      className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-amber-400 px-5 py-3 text-sm font-semibold text-slate-950 transition-colors hover:bg-amber-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-200 disabled:opacity-60"
                    >
                      <Icon name="mic" className="h-4 w-4" />
                      {recording ? "Stop & confirm" : commandBusy ? "Verifying…" : "Record confirmation"}
                    </button>
                    <button
                      type="button"
                      onClick={cancelPendingTx}
                      disabled={commandBusy || recording}
                      className="flex-1 rounded-xl border border-white/10 px-5 py-3 text-sm font-medium text-slate-300 transition-colors hover:bg-white/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40 disabled:opacity-50"
                    >
                      Cancel transfer
                    </button>
                  </div>
                </div>

                <div className="absolute inset-x-0 bottom-0 h-1 bg-white/5" aria-hidden="true">
                  <div
                    className={`h-full transition-[width] duration-1000 ease-linear ${urgent ? "bg-rose-400" : "bg-amber-400"}`}
                    style={{ width: `${Math.max(0, Math.min(100, (left / pendingTx.ttlMs) * 100))}%` }}
                  />
                </div>
              </div>
            );
          })()}

          {banner && (
            <div
              role="status"
              className={`relative mt-10 flex items-start gap-3 rounded-2xl border px-5 py-4 text-sm ${banner.kind === "ok"
                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-100"
                : banner.kind === "info"
                  ? "border-slate-600 bg-slate-800/50 text-slate-200"
                  : "border-red-500/30 bg-red-500/10 text-red-200"
                }`}
            >
              <Icon name={banner.kind === "ok" ? "check" : banner.kind === "info" ? "x" : "alert"} className="mt-0.5 h-4 w-4 shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="font-medium">
                  {banner.kind === "ok"
                    ? banner.stepUp ? "Transfer authorized" : "Command executed"
                    : banner.kind === "info"
                      ? "Transfer cancelled"
                      : banner.forensics ? "Security check failed" : "Command failed"}
                </p>
                {banner.kind === "ok" && banner.biometric && (
                  <p className="mt-1 inline-flex items-center gap-1.5 rounded-full border border-emerald-400/30 bg-emerald-500/15 px-2.5 py-0.5 text-xs font-medium text-emerald-300">
                    <Icon name="shieldCheck" className="h-3.5 w-3.5" />
                    ✓ Biometric Signature Verified (ECAPA-TDNN)
                  </p>
                )}
                {banner.kind === "ok" && banner.stepUp && (
                  <p className="ml-2 mt-1 inline-flex items-center gap-1.5 rounded-full border border-amber-300/30 bg-amber-400/10 px-2.5 py-0.5 text-xs font-medium text-amber-200">
                    <Icon name="lock" className="h-3.5 w-3.5" />
                    Voice-confirmed high-value transfer
                  </p>
                )}
                <p className="mt-0.5 opacity-90">{banner.text}</p>
                {banner.forensics && <InspectButton onClick={() => setInspect(banner.forensics ?? null)} />}
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
                type="button"
                onClick={() => setBanner(null)}
                aria-label="Dismiss"
                className="rounded p-1 opacity-70 hover:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
              >
                <Icon name="x" className="h-4 w-4" />
              </button>
            </div>
          )}
        </section>

        {/* ── Tier 2: Account overview ── */}
        <section aria-labelledby="overview-heading" className="space-y-6">
          <h2 id="overview-heading" className="text-sm font-medium uppercase tracking-wider text-slate-400">
            Account overview
          </h2>

          <div className="grid gap-6 lg:grid-cols-12">
            {/* Balance */}
            <div className="flex flex-col justify-between rounded-3xl border border-slate-800 bg-slate-900/70 p-6 sm:p-8 lg:col-span-7">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <p className="text-sm text-slate-400">Available balance</p>
                  <p className="mt-2 text-4xl font-semibold tabular-nums tracking-tight text-white sm:text-5xl">
                    {pkr(account.balance)}
                  </p>
                  <p className="mt-2 text-sm text-slate-500">
                    IBAN <span className="tabular-nums text-slate-300">{account.accountNumber}</span>
                  </p>
                </div>
                <span className="flex items-center gap-1.5 rounded-full bg-emerald-500/15 px-3 py-1.5 text-sm font-medium text-emerald-300">
                  <Icon name="trendUp" className="h-4 w-4" />
                  +2.4% this month
                </span>
              </div>
              <svg viewBox="0 0 400 70" className="mt-6 h-20 w-full" preserveAspectRatio="none" aria-hidden="true">
                <defs>
                  <linearGradient id="fs-spark" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0" stopColor="#10b981" stopOpacity=".35" />
                    <stop offset="1" stopColor="#10b981" stopOpacity="0" />
                  </linearGradient>
                </defs>
                <path d="M0 52 L45 46 L90 50 L135 36 L180 40 L225 28 L270 32 L315 18 L360 22 L400 10 L400 70 L0 70 Z" fill="url(#fs-spark)" />
                <path d="M0 52 L45 46 L90 50 L135 36 L180 40 L225 28 L270 32 L315 18 L360 22 L400 10" fill="none" stroke="#34d399" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>

            {/* Debit card */}
            <div className="flex items-center justify-center lg:col-span-5" aria-label="Debit card">
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
                          type="button"
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
            </div>

            {/* Quick actions */}
            <nav className="grid grid-cols-2 gap-4 sm:grid-cols-4 lg:col-span-12" aria-label="Quick actions">
              {quickActions.map((a) => (
                <button
                  key={a.key}
                  type="button"
                  aria-controls={a.target}
                  onClick={() => scrollToSection(a.target)}
                  className="group flex items-center gap-4 rounded-2xl border border-slate-800 bg-slate-900/70 px-5 py-4 text-left text-sm font-medium text-slate-200 transition-colors hover:border-emerald-500/50 hover:bg-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                >
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-emerald-500/15 text-emerald-300 group-hover:bg-emerald-500/25">
                    <Icon name={a.icon} className="h-5 w-5" />
                  </span>
                  {a.label}
                </button>
              ))}
            </nav>
          </div>
        </section>

        {/* ── Tier 3: Transactions ── */}
        <section id="transactions-section" className="scroll-mt-24 overflow-hidden rounded-3xl border border-slate-800 bg-slate-900/70">
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
      {inspect && <ForensicsModal data={inspect} onClose={closeInspect} />}
    </Shell>
  );
}
