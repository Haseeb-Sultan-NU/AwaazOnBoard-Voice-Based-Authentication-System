"use client";

import { Fragment, useCallback, useEffect, useMemo, useState, type ElementType } from "react";
import {
  Activity,
  Check,
  ChevronRight,
  Copy,
  Fingerprint,
  Loader2,
  Mic,
  Radio,
  RefreshCw,
  ScrollText,
  Search,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  Timer,
  XCircle,
} from "lucide-react";

/* ── Types ─────────────────────────────────────────────────── */

type Verdict = "PASS" | "BLOCKED_BIOMETRIC" | "BLOCKED_LIVENESS" | "FAIL";
type Stage = "gatekeeper" | "liveness" | "biometric";
type Channel = "login" | "command";

interface AuthLogEntry {
  id: number;
  session_id: string;
  cnic: string;
  status: string;
  verdict?: Verdict;
  blocked_stage?: Stage | null;
  channel?: Channel;
  similarity_score?: number | null; // raw ECAPA cosine
  threshold?: number;
  similarity_margin?: number | null;
  match_confidence: number | null;
  liveness_score: number | null;
  failure_reason: string | null;
  latency_ms: number | null;
  timestamp: string | null;
}

const DEFAULT_THRESHOLD = 0.2393;
const LIVE_REFRESH_MS = 15_000;
const SLOW_LATENCY_MS = 8_000; // challenge logins on CPU Whisper-small are ~6 s; flag real outliers only

/* ── Formatting ────────────────────────────────────────────── */

const pad = (n: number) => String(n).padStart(2, "0");

/** CloudWatch-style absolute time: 2026-10-07 21:40:12 */
function isoStamp(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function relative(iso: string | null, now: number): string {
  if (!iso) return "";
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function formatCnic(raw: string): string {
  const d = (raw ?? "").replace(/\D/g, "");
  return d.length === 13 ? `${d.slice(0, 5)}-${d.slice(5, 12)}-${d.slice(12)}` : raw || "—";
}

const pct = (v: number | null | undefined) => (v == null ? "—" : `${(v * 100).toFixed(1)}%`);
const fixed = (v: number | null | undefined, n = 2) => (v == null ? "—" : v.toFixed(n));

function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

/** Fallbacks for rows served by an older backend without forensic fields. */
function verdictOf(log: AuthLogEntry): Verdict {
  if (log.verdict) return log.verdict;
  if (log.status?.toUpperCase() === "PASS") return "PASS";
  const r = (log.failure_reason ?? "").toLowerCase();
  if (/gatekeeper|replay|speaker|silence|liveness|digits/.test(r)) return "BLOCKED_LIVENESS";
  if (/biometric|mismatch/.test(r)) return "BLOCKED_BIOMETRIC";
  return "FAIL";
}

/* ── Verdict badge ─────────────────────────────────────────── */

const VERDICT_META: Record<Verdict, { label: string; icon: ElementType; cls: string; dot: string }> = {
  PASS: {
    label: "PASS",
    icon: ShieldCheck,
    cls: "border-emerald-500/40 bg-emerald-500/10 text-emerald-400",
    dot: "bg-emerald-400",
  },
  BLOCKED_BIOMETRIC: {
    label: "BLOCKED · Biometric",
    icon: ShieldX,
    cls: "border-red-500/40 bg-red-500/10 text-red-400",
    dot: "bg-red-400",
  },
  BLOCKED_LIVENESS: {
    label: "BLOCKED · Liveness",
    icon: ShieldAlert,
    cls: "border-orange-500/40 bg-orange-500/10 text-orange-400",
    dot: "bg-orange-400",
  },
  FAIL: {
    label: "FAIL",
    icon: XCircle,
    cls: "border-neutral-600 bg-neutral-800 text-neutral-300",
    dot: "bg-neutral-400",
  },
};

function VerdictBadge({ verdict }: { verdict: Verdict }) {
  const m = VERDICT_META[verdict];
  const Icon = m.icon;
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded border px-1.5 py-0.5 font-mono text-[10.5px] font-semibold uppercase tracking-wide ${m.cls}`}>
      <Icon className="h-3 w-3" />
      {m.label}
    </span>
  );
}

/* ── Similarity gauge: score vs threshold on a -1…1 track (zoomed to 0…1) ── */

function SimilarityCell({ log }: { log: AuthLogEntry }) {
  const sim = log.similarity_score;
  const t = log.threshold ?? DEFAULT_THRESHOLD;
  if (sim == null) {
    return <span className="whitespace-nowrap font-mono text-neutral-600" title="Not computed — attempt was blocked before biometric matching">— / {t.toFixed(2)}</span>;
  }
  const pass = sim >= t;
  const pos = (v: number) => `${Math.max(0, Math.min(1, v)) * 100}%`;
  return (
    <div className="flex items-center gap-2" title={`Cosine ${sim.toFixed(4)} vs threshold ${t.toFixed(4)} (margin ${(sim - t >= 0 ? "+" : "") + (sim - t).toFixed(4)})`}>
      <span className="whitespace-nowrap font-mono tabular-nums">
        <span className={pass ? "text-emerald-400" : "text-red-400"}>{sim.toFixed(2)}</span>
        <span className="text-neutral-600"> / {t.toFixed(2)}</span>
      </span>
      <span className="relative hidden h-1.5 w-16 rounded-full bg-neutral-800 xl:block" aria-hidden="true">
        <span className={`absolute inset-y-0 left-0 rounded-full ${pass ? "bg-emerald-500/70" : "bg-red-500/70"}`} style={{ width: pos(sim) }} />
        <span className="absolute -top-0.5 h-2.5 w-px bg-neutral-300" style={{ left: pos(t) }} />
      </span>
    </div>
  );
}

/* ── Forensic detail panel ─────────────────────────────────── */

type StageState = "pass" | "fail" | "skipped" | "n/a";

function pipelineStages(log: AuthLogEntry, verdict: Verdict): { name: string; engine: string; state: StageState; note: string }[] {
  const t = log.threshold ?? DEFAULT_THRESHOLD;
  const sim = log.similarity_score;
  const bioState: StageState = sim == null ? "skipped" : sim >= t ? "pass" : "fail";
  const command = log.channel === "command";
  const stage = log.blocked_stage ?? (verdict === "BLOCKED_BIOMETRIC" ? "biometric" : verdict === "BLOCKED_LIVENESS" ? "gatekeeper" : null);

  const gatekeeper: StageState = stage === "gatekeeper" ? "fail" : "pass";
  const liveness: StageState = command ? "n/a" : stage === "gatekeeper" ? "skipped" : stage === "liveness" ? "fail" : "pass";
  return [
    { name: "Gatekeeper", engine: "pyannote diarization", state: gatekeeper, note: gatekeeper === "fail" ? "Multi-speaker / replay / no-speech screen" : "Single live speaker" },
    { name: "Active liveness", engine: "Whisper ASR challenge", state: liveness, note: command ? "Not used for per-command re-auth" : `Challenge score ${pct(log.liveness_score)}` },
    { name: "Voiceprint match", engine: "ECAPA-TDNN cosine", state: bioState, note: sim == null ? "Not reached" : `${sim.toFixed(4)} vs ${t.toFixed(4)}` },
  ];
}

const STAGE_STYLE: Record<StageState, string> = {
  pass: "border-emerald-500/30 text-emerald-400",
  fail: "border-red-500/40 text-red-400",
  skipped: "border-neutral-800 text-neutral-600",
  "n/a": "border-neutral-800 text-neutral-500",
};

function DetailPanel({ log, verdict }: { log: AuthLogEntry; verdict: Verdict }) {
  const [copied, setCopied] = useState(false);
  const json = JSON.stringify(log, null, 2);
  const stages = pipelineStages(log, verdict);
  const t = log.threshold ?? DEFAULT_THRESHOLD;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(json);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable (insecure context) */
    }
  };

  return (
    <div className="grid gap-4 border-t border-neutral-800 bg-neutral-950/70 px-4 py-4 lg:grid-cols-[1.1fr_1fr]">
      <div className="space-y-4">
        {/* Pipeline trace */}
        <section>
          <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-neutral-500">Pipeline trace</h4>
          <ol className="grid gap-2 sm:grid-cols-3">
            {stages.map((s, i) => (
              <li key={s.name} className={`rounded-md border bg-neutral-900/60 px-3 py-2 ${STAGE_STYLE[s.state]}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-semibold text-neutral-200">
                    <span className="mr-1 font-mono text-neutral-600">{i}</span>
                    {s.name}
                  </span>
                  <span className="font-mono text-[10px] font-semibold uppercase">{s.state}</span>
                </div>
                <p className="mt-0.5 text-[10.5px] text-neutral-500">{s.engine}</p>
                <p className="mt-1 font-mono text-[10.5px] text-neutral-400">{s.note}</p>
              </li>
            ))}
          </ol>
        </section>

        {/* Key/value forensics */}
        <section>
          <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-neutral-500">Forensic breakdown</h4>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5 font-mono text-[11.5px] sm:grid-cols-3">
            {[
              ["Raw cosine", fixed(log.similarity_score, 4)],
              ["EER threshold", t.toFixed(4)],
              ["Margin", log.similarity_margin == null ? "—" : `${log.similarity_margin >= 0 ? "+" : ""}${log.similarity_margin.toFixed(4)}`],
              ["Calibrated score", pct(log.match_confidence)], // display scale: ≥80% = match, ≤79% = non-match
              ["Liveness score", pct(log.liveness_score)],
              ["Latency", log.latency_ms == null ? "—" : `${log.latency_ms.toLocaleString()} ms`],
              ["Channel", log.channel === "command" ? "Voice command (step-up)" : "Challenge login"],
              ["Session", log.session_id],
              ["Event ID", `#${log.id}`],
            ].map(([k, v]) => (
              <div key={k} className="min-w-0">
                <dt className="text-[10px] uppercase tracking-wider text-neutral-600">{k}</dt>
                <dd className="truncate text-neutral-200" title={v}>{v}</dd>
              </div>
            ))}
          </dl>
          {log.failure_reason && (
            <p className="mt-3 rounded-md border border-neutral-800 bg-neutral-900/60 px-3 py-2 font-mono text-[11.5px] text-neutral-300">
              <span className="mr-2 text-[10px] uppercase tracking-wider text-neutral-600">reason</span>
              {log.failure_reason}
            </p>
          )}
        </section>
      </div>

      {/* Raw event */}
      <section className="min-w-0">
        <div className="mb-2 flex items-center justify-between">
          <h4 className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500">Raw event JSON</h4>
          <button
            type="button"
            onClick={copy}
            className="inline-flex items-center gap-1 rounded border border-neutral-800 px-2 py-0.5 text-[10.5px] text-neutral-400 hover:border-neutral-700 hover:text-neutral-200"
          >
            {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <pre className="max-h-72 overflow-auto rounded-md border border-neutral-800 bg-black/60 p-3 font-mono text-[11px] leading-relaxed text-neutral-300">
          {json}
        </pre>
      </section>
    </div>
  );
}

/* ── KPI strip ─────────────────────────────────────────────── */

function Kpi({ label, value, sub, icon: Icon, tone = "text-white" }: { label: string; value: string; sub?: string; icon: ElementType; tone?: string }) {
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-3">
      <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
        <Icon className="h-3 w-3" />
        {label}
      </p>
      <p className={`mt-1 font-mono text-xl font-semibold tabular-nums ${tone}`}>{value}</p>
      {sub && <p className="mt-0.5 text-[11px] text-neutral-500">{sub}</p>}
    </div>
  );
}

/* ── Data ──────────────────────────────────────────────────── */

async function requestLogs(): Promise<AuthLogEntry[]> {
  const stored = localStorage.getItem("awaaz_user");
  const parsed = stored ? JSON.parse(stored) : null;
  const currentCnic = parsed?.cnic || parsed?.user_id || "";
  const res = await fetch(`/api/logs?user_id=${encodeURIComponent(currentCnic)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return data.logs ?? [];
}

/* ── Page ──────────────────────────────────────────────────── */

const VERDICT_FILTERS: { key: "ALL" | Verdict; label: string }[] = [
  { key: "ALL", label: "All" },
  { key: "PASS", label: "Pass" },
  { key: "BLOCKED_BIOMETRIC", label: "Biometric" },
  { key: "BLOCKED_LIVENESS", label: "Liveness" },
];

export default function LogsPage() {
  const [logs, setLogs] = useState<AuthLogEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [live, setLive] = useState(true);
  const [query, setQuery] = useState("");
  const [verdictFilter, setVerdictFilter] = useState<"ALL" | Verdict>("ALL");
  const [channelFilter, setChannelFilter] = useState<"ALL" | Channel>("ALL");
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());

  // State is only written in promise callbacks, i.e. after the network round-trip.
  const load = useCallback(
    () =>
      requestLogs()
        .then((next) => {
          setLogs(next);
          setError(null);
          setUpdatedAt(Date.now());
        })
        .catch((err: unknown) => setError(err instanceof Error ? err.message : "Failed to load audit logs"))
        .finally(() => {
          setIsLoading(false);
          setRefreshing(false);
        }),
    [],
  );

  const refresh = useCallback(() => {
    setRefreshing(true);
    void load();
  }, [load]);

  useEffect(() => {
    void load();
  }, [load]);

  // Live tail: poll while enabled, and tick relative timestamps.
  useEffect(() => {
    if (!live) return;
    const poll = setInterval(refresh, LIVE_REFRESH_MS);
    return () => clearInterval(poll);
  }, [live, refresh]);

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(tick);
  }, []);

  const rows = useMemo(() => logs.map((log) => ({ log, verdict: verdictOf(log) })), [logs]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase().replace(/-/g, "");
    return rows.filter(({ log, verdict }) => {
      if (verdictFilter !== "ALL" && verdict !== verdictFilter) return false;
      if (channelFilter !== "ALL" && (log.channel ?? "login") !== channelFilter) return false;
      if (!q) return true;
      return [log.cnic, log.session_id, log.failure_reason, String(log.id)]
        .filter(Boolean)
        .some((f) => String(f).toLowerCase().replace(/-/g, "").includes(q));
    });
  }, [rows, query, verdictFilter, channelFilter]);

  const stats = useMemo(() => {
    const total = rows.length;
    const pass = rows.filter((r) => r.verdict === "PASS").length;
    const bio = rows.filter((r) => r.verdict === "BLOCKED_BIOMETRIC").length;
    const live_ = rows.filter((r) => r.verdict === "BLOCKED_LIVENESS").length;
    const lat = rows.map((r) => r.log.latency_ms).filter((v): v is number => v != null).sort((a, b) => a - b);
    return { total, pass, bio, live: live_, p50: percentile(lat, 50), p95: percentile(lat, 95) };
  }, [rows]);

  const toggle = (id: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="p-6 lg:p-8">
      {/* ── Header ── */}
      <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">Verification Audit Log</h1>
          <p className="mt-1 text-sm text-neutral-500">Forensic telemetry for every voice biometric decision</p>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span className="font-mono text-neutral-500">{updatedAt ? `Updated ${relative(new Date(updatedAt).toISOString(), now)}` : ""}</span>
          <button
            type="button"
            onClick={() => setLive((v) => !v)}
            aria-pressed={live}
            className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 font-medium ${live ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400" : "border-neutral-800 bg-neutral-900 text-neutral-400"}`}
          >
            <Radio className={`h-3.5 w-3.5 ${live ? "animate-pulse" : ""}`} />
            {live ? "Live" : "Paused"}
          </button>
          <button
            type="button"
            onClick={refresh}
            className="inline-flex items-center gap-1.5 rounded-md border border-neutral-800 bg-neutral-900 px-2.5 py-1.5 font-medium text-neutral-300 hover:border-neutral-700"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
            Refresh
          </button>
        </div>
      </div>

      {/* ── KPIs ── */}
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Kpi label="Attempts" value={String(stats.total)} icon={Activity} />
        <Kpi label="Pass rate" value={stats.total ? `${((stats.pass / stats.total) * 100).toFixed(1)}%` : "—"} sub={`${stats.pass} verified`} icon={ShieldCheck} tone="text-emerald-400" />
        <Kpi label="Blocked · Biometric" value={String(stats.bio)} sub="Voiceprint below threshold" icon={Fingerprint} tone="text-red-400" />
        <Kpi label="Blocked · Liveness" value={String(stats.live)} sub="Gatekeeper / challenge" icon={ShieldAlert} tone="text-orange-400" />
        <Kpi label="Latency p50 / p95" value={stats.p50 == null ? "—" : `${(stats.p50 / 1000).toFixed(1)}s`} sub={stats.p95 == null ? undefined : `p95 ${(stats.p95 / 1000).toFixed(1)}s`} icon={Timer} />
      </div>

      {/* ── Toolbar ── */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <label className="relative min-w-[220px] flex-1">
          <span className="sr-only">Search logs</span>
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-neutral-500" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by CNIC, session ID, reason or event #"
            className="w-full rounded-md border border-neutral-800 bg-neutral-900 py-1.5 pl-8 pr-3 font-mono text-xs text-neutral-200 placeholder:font-sans placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none"
          />
        </label>
        <div className="flex rounded-md border border-neutral-800 bg-neutral-900 p-0.5 text-xs" role="group" aria-label="Verdict filter">
          {VERDICT_FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              aria-pressed={verdictFilter === f.key}
              onClick={() => setVerdictFilter(f.key)}
              className={`rounded px-2.5 py-1 font-medium ${verdictFilter === f.key ? "bg-neutral-700 text-white" : "text-neutral-400 hover:text-neutral-200"}`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="flex rounded-md border border-neutral-800 bg-neutral-900 p-0.5 text-xs" role="group" aria-label="Channel filter">
          {(["ALL", "login", "command"] as const).map((c) => (
            <button
              key={c}
              type="button"
              aria-pressed={channelFilter === c}
              onClick={() => setChannelFilter(c)}
              className={`rounded px-2.5 py-1 font-medium ${channelFilter === c ? "bg-neutral-700 text-white" : "text-neutral-400 hover:text-neutral-200"}`}
            >
              {c === "ALL" ? "All channels" : c === "login" ? "Login" : "Command"}
            </button>
          ))}
        </div>
        <span className="ml-auto font-mono text-[11px] text-neutral-500">
          {filtered.length} / {rows.length} events
        </span>
      </div>

      {/* ── States ── */}
      {isLoading && (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-neutral-800 bg-neutral-900 py-16">
          <Loader2 className="h-6 w-6 animate-spin text-neutral-600" />
          <p className="text-sm text-neutral-500">Loading audit logs...</p>
        </div>
      )}

      {!isLoading && error && logs.length === 0 && (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-neutral-800 bg-neutral-900 py-16">
          <XCircle className="h-6 w-6 text-red-500/60" />
          <p className="text-sm text-red-400">{error}</p>
          <p className="text-xs text-neutral-600">Make sure the backend is running on port 8000</p>
        </div>
      )}

      {!isLoading && !error && logs.length === 0 && (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-neutral-800 bg-neutral-900 py-16">
          <ScrollText className="h-5 w-5 text-neutral-600" />
          <p className="text-sm font-medium text-neutral-400">No logs found</p>
          <p className="text-xs text-neutral-600">Verification attempts will appear here automatically.</p>
        </div>
      )}

      {/* ── Table ── */}
      {!isLoading && logs.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-neutral-800 bg-neutral-900">
          {error && <p className="border-b border-neutral-800 bg-red-500/5 px-4 py-1.5 text-xs text-red-400">Refresh failed ({error}) — showing last loaded data.</p>}
          <div className="max-h-[calc(100vh-22rem)] min-h-64 overflow-auto">
            <table className="w-full min-w-[960px] border-collapse text-left text-[12.5px]">
              <thead className="sticky top-0 z-10 bg-neutral-900 text-[10px] font-semibold uppercase tracking-wider text-neutral-500 shadow-[0_1px_0_#262626]">
                <tr>
                  <th className="w-8 px-3 py-2" aria-label="Expand" />
                  <th className="px-3 py-2">Timestamp</th>
                  <th className="px-3 py-2">Verdict</th>
                  <th className="px-3 py-2">Subject CNIC</th>
                  <th className="px-3 py-2">Channel</th>
                  <th className="px-3 py-2">Similarity / Thr.</th>
                  <th className="px-3 py-2 text-right">Liveness</th>
                  <th className="px-3 py-2 text-right">Latency</th>
                  <th className="px-3 py-2">Reason</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={9} className="px-3 py-10 text-center text-xs text-neutral-500">
                      No events match the current filters.
                    </td>
                  </tr>
                )}
                {filtered.map(({ log, verdict }) => {
                  const open = expanded.has(log.id);
                  const slow = (log.latency_ms ?? 0) > SLOW_LATENCY_MS;
                  return (
                    <Fragment key={log.id}>
                      <tr
                        onClick={() => toggle(log.id)}
                        className={`cursor-pointer border-t border-neutral-800/80 transition-colors hover:bg-neutral-800/40 ${open ? "bg-neutral-800/30" : ""}`}
                      >
                        <td className="relative px-3 py-1.5">
                          <span className={`absolute inset-y-0 left-0 w-0.5 ${VERDICT_META[verdict].dot}`} aria-hidden="true" />
                          <button
                            type="button"
                            aria-expanded={open}
                            aria-label={open ? "Hide details" : "View details"}
                            onClick={(e) => {
                              e.stopPropagation();
                              toggle(log.id);
                            }}
                            className="flex h-5 w-5 items-center justify-center rounded text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
                          >
                            <ChevronRight className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-90" : ""}`} />
                          </button>
                        </td>
                        <td className="whitespace-nowrap px-3 py-1.5 font-mono tabular-nums text-neutral-300">
                          {isoStamp(log.timestamp)}
                          <span className="ml-2 text-[10.5px] text-neutral-600">{relative(log.timestamp, now)}</span>
                        </td>
                        <td className="px-3 py-1.5">
                          <VerdictBadge verdict={verdict} />
                        </td>
                        <td className="whitespace-nowrap px-3 py-1.5 font-mono text-neutral-200">{formatCnic(log.cnic)}</td>
                        <td className="whitespace-nowrap px-3 py-1.5 text-neutral-400">
                          <span className="inline-flex items-center gap-1">
                            {log.channel === "command" ? <Mic className="h-3 w-3" /> : <Fingerprint className="h-3 w-3" />}
                            {log.channel === "command" ? "Command" : "Login"}
                          </span>
                        </td>
                        <td className="px-3 py-1.5">
                          <SimilarityCell log={log} />
                        </td>
                        <td className="px-3 py-1.5 text-right font-mono tabular-nums text-neutral-300">{pct(log.liveness_score)}</td>
                        <td className={`whitespace-nowrap px-3 py-1.5 text-right font-mono tabular-nums ${slow ? "text-amber-400" : "text-neutral-300"}`}>
                          {log.latency_ms == null ? "—" : `${log.latency_ms.toLocaleString()} ms`}
                        </td>
                        <td className="max-w-[260px] truncate px-3 py-1.5 text-neutral-400" title={log.failure_reason ?? ""}>
                          {log.failure_reason ?? <span className="text-neutral-600">—</span>}
                        </td>
                      </tr>
                      {open && (
                        <tr>
                          <td colSpan={9} className="p-0">
                            <DetailPanel log={log} verdict={verdict} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
