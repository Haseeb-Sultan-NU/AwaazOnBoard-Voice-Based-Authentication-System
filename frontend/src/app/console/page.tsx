"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  Activity,
  ShieldCheck,
  CreditCard,
  TrendingUp,
  Mic,
  Fingerprint,
  ArrowRight,
  Clock,
  CheckCircle2,
  Loader2,
} from "lucide-react";

/* ── Types ─────────────────────────────────────────────────── */

interface SessionEntry {
  id: string;
  user_id: string;
  session_type: string;
  session_timestamp: string;
  status: string;
  biometric_score: number | null;
  liveness_passed: boolean | null;
  coercion_detected: boolean | null;
}

interface AwaazUser {
  cnic?: string;
  user_id?: string;
  full_name?: string;
}

/* ── Component ─────────────────────────────────────────────── */

export default function ConsoleDashboardPage() {
  const [sessions, setSessions] = useState<SessionEntry[]>([]);
  const [isEnrolled, setIsEnrolled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<AwaazUser | null>(null);

  /* Read user from localStorage (hydration-safe) */
  useEffect(() => {
    try {
      const stored = localStorage.getItem("awaaz_user");
      if (stored) setUser(JSON.parse(stored));
    } catch {
      // Invalid JSON
    }
  }, []);

  const currentCnic = user?.cnic || user?.user_id || "";

  /* Format CNIC: 1234567890123 → 12345-6789012-3 */
  const formatCnic = (raw: string): string => {
    const digits = raw.replace(/\D/g, "");
    if (digits.length !== 13) return raw;
    return `${digits.slice(0, 5)}-${digits.slice(5, 12)}-${digits.slice(12)}`;
  };

  useEffect(() => {
    if (!currentCnic) return;

    async function fetchDashboardData() {
      try {
        const sessionsRes = await fetch(`/api/authenticate/sessions?user_id=${encodeURIComponent(currentCnic)}`);
        if (sessionsRes.ok) {
          const data = await sessionsRes.json();
          setSessions(data.sessions ?? []);
        }
      } catch {
        // Backend offline
      }

      try {
        const enrollRes = await fetch("/api/enroll/status");
        if (enrollRes.ok) {
          const data = await enrollRes.json();
          setIsEnrolled(data.enrollment?.is_enrolled ?? false);
        }
      } catch {
        // Backend offline
      }

      setLoading(false);
    }

    fetchDashboardData();
  }, [currentCnic]);

  /* ── Derived Stats ─────────────────────────────────────── */

  const totalSessions = sessions.length;
  const successfulAuth = sessions.filter(
    (s) => s.status === "GRANTED"
  ).length;
  const successRate =
    totalSessions > 0
      ? `${Math.round((successfulAuth / totalSessions) * 100)}%`
      : "N/A";

  return (
    <div className="p-8 lg:p-10">
      {/* ── Header ───────────────────────────────────────────── */}
      <div className="mb-8">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold text-white">Dashboard</h1>
          {isEnrolled ? (
            <span className="rounded-full border border-green-500/40 bg-green-500/10 px-3 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-green-500">
              Enrolled
            </span>
          ) : (
            <span className="rounded-full border border-yellow-500/40 bg-yellow-500/10 px-3 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-yellow-500">
              Not Enrolled
            </span>
          )}
        </div>
        <p className="mt-1.5 font-mono text-sm text-neutral-500">
          CNIC: {currentCnic ? formatCnic(currentCnic) : "—"}
        </p>
      </div>

      {/* ── Enrollment Alert Banner (only if not enrolled) ──── */}
      {!isEnrolled && (
        <div className="mb-8 flex flex-col items-start gap-4 rounded-xl border border-neutral-800 bg-neutral-900 p-5 sm:flex-row sm:items-center">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-yellow-500/10">
            <AlertTriangle className="h-5 w-5 text-yellow-500" />
          </div>
          <div className="flex-1">
            <p className="text-sm font-medium text-white">
              Voice not enrolled
            </p>
            <p className="mt-0.5 text-sm text-neutral-500">
              Complete enrollment to use authentication &amp; transactions
            </p>
          </div>
          <Link
            href="/console/enrollment"
            className="inline-flex items-center gap-2 rounded-lg bg-cyan-500 px-5 py-2.5 text-sm font-semibold text-black transition-all hover:bg-cyan-400 hover:shadow-[0_0_20px_rgba(6,182,212,0.3)]"
          >
            Enroll Now
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      )}

      {/* ── Stats Grid ───────────────────────────────────────── */}
      <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon={<Activity className="h-5 w-5" />}
          label="Total Sessions"
          value={loading ? "—" : String(totalSessions)}
        />
        <StatCard
          icon={<ShieldCheck className="h-5 w-5" />}
          label="Successful Auth"
          value={loading ? "—" : String(successfulAuth)}
        />
        <StatCard
          icon={<CreditCard className="h-5 w-5" />}
          label="Transactions"
          value="0"
        />
        <StatCard
          icon={<TrendingUp className="h-5 w-5" />}
          label="Success Rate"
          value={loading ? "—" : successRate}
        />
      </div>

      {/* ── Bottom Section (2 Columns) ───────────────────────── */}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Left — Quick Actions */}
        <div>
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-neutral-400">
            Quick Actions
          </h2>
          <div className="space-y-3">
            <ActionCard
              href="/console/enrollment"
              icon={<Mic className="h-5 w-5" />}
              title="Voice Enrollment"
              description="Register your voice biometric template for authentication"
            />
            <ActionCard
              href="/console/authenticate"
              icon={<Fingerprint className="h-5 w-5" />}
              title="Authenticate"
              description="Verify your identity using voice biometric challenge"
            />
            <ActionCard
              href="/console/transactions"
              icon={<CreditCard className="h-5 w-5" />}
              title="Transactions"
              description="View and manage your authenticated transaction history"
            />
          </div>
        </div>

        {/* Right — Recent Sessions */}
        <div>
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-neutral-400">
            Recent Sessions
          </h2>
          {loading ? (
            <div className="flex h-[calc(100%-2rem)] min-h-[280px] flex-col items-center justify-center rounded-xl border border-neutral-800 bg-neutral-900 p-8">
              <Loader2 className="h-6 w-6 animate-spin text-neutral-600" />
              <p className="mt-3 text-xs text-neutral-600">Loading sessions...</p>
            </div>
          ) : sessions.length === 0 ? (
            <div className="flex h-[calc(100%-2rem)] min-h-[280px] flex-col items-center justify-center rounded-xl border border-neutral-800 bg-neutral-900 p-8">
              <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full border border-neutral-800 bg-neutral-800/50">
                <Clock className="h-5 w-5 text-neutral-600" />
              </div>
              <p className="text-sm font-medium text-neutral-400">
                No sessions yet
              </p>
              <p className="mt-1 text-xs text-neutral-600">
                Start by authenticating to see session history.
              </p>
            </div>
          ) : (
            <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-4">
              <div className="space-y-2">
                {sessions.slice(0, 8).map((s) => (
                  <div
                    key={s.id}
                    className="flex items-center justify-between rounded-lg border border-neutral-800/50 bg-black/40 px-4 py-3"
                  >
                    <div className="flex items-center gap-3">
                      <div
                        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border ${
                          s.status === "GRANTED"
                            ? "border-green-500/30 bg-green-500/10"
                            : "border-red-500/30 bg-red-500/10"
                        }`}
                      >
                        {s.status === "GRANTED" ? (
                          <CheckCircle2 className="h-4 w-4 text-green-400" />
                        ) : (
                          <AlertTriangle className="h-4 w-4 text-red-400" />
                        )}
                      </div>
                      <div>
                        <p className="text-xs font-medium text-white">
                          {s.session_type}
                        </p>
                        <p className="text-[10px] text-neutral-600">
                          {new Date(s.session_timestamp).toLocaleString()}
                        </p>
                      </div>
                    </div>
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
                        s.status === "GRANTED"
                          ? "border border-green-500/30 bg-green-500/10 text-green-400"
                          : "border border-red-500/30 bg-red-500/10 text-red-400"
                      }`}
                    >
                      {s.status}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Stat Card ─────────────────────────────────────────────── */

function StatCard({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-5">
      <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-lg border border-neutral-800 bg-neutral-800/50 text-green-500">
        {icon}
      </div>
      <p className="text-2xl font-bold text-white">{value}</p>
      <p className="mt-1 text-xs font-medium uppercase tracking-wider text-neutral-500">
        {label}
      </p>
    </div>
  );
}

/* ── Action Card ───────────────────────────────────────────── */

function ActionCard({
  href,
  icon,
  title,
  description,
}: {
  href: string;
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <Link
      href={href}
      className="group flex items-center gap-4 rounded-xl border border-neutral-800 bg-neutral-900 p-4 transition-all hover:border-neutral-700 hover:bg-neutral-800/70"
    >
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-neutral-800 bg-neutral-800/50 text-green-500 transition-colors group-hover:border-green-500/30 group-hover:bg-green-500/10">
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-white">{title}</p>
        <p className="mt-0.5 text-xs text-neutral-500 truncate">
          {description}
        </p>
      </div>
      <ArrowRight className="h-4 w-4 shrink-0 text-neutral-700 transition-all group-hover:translate-x-0.5 group-hover:text-neutral-400" />
    </Link>
  );
}
