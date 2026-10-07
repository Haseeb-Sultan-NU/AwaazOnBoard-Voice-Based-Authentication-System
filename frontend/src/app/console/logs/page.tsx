"use client";

import { useEffect, useState, type ElementType } from "react";
import {
  Shield,
  CheckCircle2,
  XCircle,
  Loader2,
  ScrollText,
  Clock,
  AlertTriangle,
  Activity,
  Fingerprint,
  Timer,
} from "lucide-react";

/* ── Types ─────────────────────────────────────────────────── */

interface AuthLogEntry {
  id: number;
  session_id: string;
  cnic: string;
  status: "PASS" | "FAIL" | string;
  liveness_score: number | null;
  match_confidence: number | null;
  failure_reason: string | null;
  latency_ms: number;
  timestamp: string | null;
}

/* ── Helpers ───────────────────────────────────────────────── */

function formatTimestamp(iso: string | null): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleString("en-PK", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
    });
  } catch {
    return iso;
  }
}

function formatCnic(raw: string): string {
  const digits = (raw ?? "").replace(/\D/g, "");
  if (digits.length === 13) {
    return `${digits.slice(0, 5)}-${digits.slice(5, 12)}-${digits.slice(12)}`;
  }
  return raw || "—";
}

function formatPercent(value: number | null): string {
  return value != null ? `${(value * 100).toFixed(1)}%` : "N/A";
}

/* ── Sub-components ────────────────────────────────────────── */

function StatusBadge({ pass }: { pass: boolean }) {
  return pass ? (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-green-500/40 bg-green-500/15 px-3 py-1 text-xs font-bold uppercase tracking-wider text-green-400">
      <CheckCircle2 className="h-3.5 w-3.5" />
      Pass
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-red-500/40 bg-red-500/15 px-3 py-1 text-xs font-bold uppercase tracking-wider text-red-400">
      <XCircle className="h-3.5 w-3.5" />
      Fail
    </span>
  );
}

function Metric({
  label,
  value,
  icon: Icon,
  muted,
}: {
  label: string;
  value: string;
  icon: ElementType;
  muted: boolean;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-neutral-800 bg-neutral-950/60 px-3 py-2.5">
      <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
        <Icon className="h-3 w-3" />
        {label}
      </span>
      <span
        className={`font-mono text-sm font-semibold ${
          muted ? "text-neutral-600" : "text-white"
        }`}
      >
        {value}
      </span>
    </div>
  );
}

function LogCard({ log }: { log: AuthLogEntry }) {
  const pass = log.status?.toUpperCase() === "PASS";

  return (
    <article
      id={`log-card-${log.id}`}
      className={`rounded-xl border bg-neutral-900 p-5 transition-colors hover:bg-neutral-900/70 ${
        pass
          ? "border-neutral-800 hover:border-green-500/30"
          : "border-neutral-800 hover:border-red-500/30"
      }`}
    >
      {/* Header: timestamp + badge */}
      <header className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2 text-sm text-neutral-400">
          <Clock className="h-3.5 w-3.5 text-neutral-600" />
          {formatTimestamp(log.timestamp)}
        </span>
        <StatusBadge pass={pass} />
      </header>

      {/* Body: CNIC + reason */}
      <div className="mt-4 flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-neutral-800 bg-neutral-800/50">
            <Shield className="h-3 w-3 text-neutral-500" />
          </div>
          <span className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
            CNIC
          </span>
          <span className="font-mono text-sm text-white">
            {formatCnic(log.cnic)}
          </span>
        </div>

        {!pass && log.failure_reason && (
          <div className="flex items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-400" />
            <p className="text-sm text-red-300">
              <span className="mr-1.5 text-[11px] font-semibold uppercase tracking-wider text-red-400/80">
                Reason
              </span>
              {log.failure_reason}
            </p>
          </div>
        )}
      </div>

      {/* Footer: 3-column metrics grid */}
      <footer className="mt-4 grid grid-cols-3 gap-2">
        <Metric
          label="Liveness"
          icon={Activity}
          value={formatPercent(log.liveness_score)}
          muted={log.liveness_score == null}
        />
        <Metric
          label="Biometric"
          icon={Fingerprint}
          value={formatPercent(log.match_confidence)}
          muted={log.match_confidence == null}
        />
        <Metric
          label="Latency"
          icon={Timer}
          value={log.latency_ms != null ? `${log.latency_ms} ms` : "N/A"}
          muted={log.latency_ms == null}
        />
      </footer>
    </article>
  );
}

/* ── Component ─────────────────────────────────────────────── */

export default function LogsPage() {
  const [logs, setLogs] = useState<AuthLogEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchLogs() {
      try {
        const stored = localStorage.getItem("awaaz_user");
        const parsed = stored ? JSON.parse(stored) : null;
        const currentCnic = parsed?.cnic || parsed?.user_id || "";
        const res = await fetch(`/api/logs?user_id=${encodeURIComponent(currentCnic)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        setLogs(data.logs ?? []);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to load audit logs"
        );
      } finally {
        setIsLoading(false);
      }
    }

    fetchLogs();
  }, []);

  return (
    <div className="p-8 lg:p-10">
      {/* ── Header ─────────────────────────────────────────── */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white">
          Security &amp; Verification Logs
        </h1>
        <p className="mt-1.5 text-sm text-neutral-500">
          Pipeline telemetry for every voice biometric verification attempt
        </p>
      </div>

      {/* Loading State */}
      {isLoading && (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-neutral-800 bg-neutral-900 py-16">
          <Loader2 className="h-6 w-6 animate-spin text-neutral-600" />
          <p className="text-sm text-neutral-500">Loading audit logs...</p>
        </div>
      )}

      {/* Error State */}
      {!isLoading && error && (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-neutral-800 bg-neutral-900 py-16">
          <XCircle className="h-6 w-6 text-red-500/60" />
          <p className="text-sm text-red-400">{error}</p>
          <p className="text-xs text-neutral-600">
            Make sure the backend is running on port 8000
          </p>
        </div>
      )}

      {/* Empty State */}
      {!isLoading && !error && logs.length === 0 && (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-neutral-800 bg-neutral-900 py-16">
          <div className="flex h-12 w-12 items-center justify-center rounded-full border border-neutral-800 bg-neutral-800/50">
            <ScrollText className="h-5 w-5 text-neutral-600" />
          </div>
          <p className="text-sm font-medium text-neutral-400">No logs found</p>
          <p className="text-xs text-neutral-600">
            Verification attempts will appear here automatically.
          </p>
        </div>
      )}

      {/* Log Cards */}
      {!isLoading && !error && logs.length > 0 && (
        <div id="log-card-stack" className="flex flex-col gap-4">
          {logs.map((log) => (
            <LogCard key={log.id} log={log} />
          ))}
        </div>
      )}
    </div>
  );
}
