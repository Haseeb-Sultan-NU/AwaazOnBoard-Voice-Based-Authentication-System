"use client";

import { useEffect, useState } from "react";
import { Shield, CheckCircle2, XCircle, Loader2, ScrollText } from "lucide-react";

/* ── Types ─────────────────────────────────────────────────── */

interface AuditLogEntry {
  id: number;
  user_id: string;
  attempt_time: string;
  coercion_detected: boolean;
  expected_challenge: string | null;
  transcribed_text: string | null;
  liveness_passed: boolean;
  biometric_score: number | null;
  status: string;
}

/* ── Helpers ───────────────────────────────────────────────── */

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString("en-PK", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

function formatCnic(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 13) {
    return `${digits.slice(0, 5)}-${digits.slice(5, 12)}-${digits.slice(12)}`;
  }
  return raw;
}

function isSuccess(status: string): boolean {
  const s = status.toUpperCase();
  return s === "GRANTED" || s === "SUCCESS";
}

/* ── Component ─────────────────────────────────────────────── */

export default function LogsPage() {
  const [logs, setLogs] = useState<AuditLogEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchLogs() {
      try {
        const res = await fetch("/api/authenticate/sessions");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        setLogs(data.sessions ?? []);
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
          Audit trail of all voice biometric verification attempts
        </p>
      </div>

      {/* ── Logs Table ─────────────────────────────────────── */}
      <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-6 sm:p-8">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-neutral-800">
                <th className="pb-3 pr-6 text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
                  Timestamp
                </th>
                <th className="pb-3 pr-6 text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
                  Request ID
                </th>
                <th className="pb-3 pr-6 text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
                  CNIC
                </th>
                <th className="pb-3 pr-6 text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
                  Match Confidence
                </th>
                <th className="pb-3 text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
                  Status
                </th>
              </tr>
            </thead>
            <tbody>
              {/* Loading State */}
              {isLoading && (
                <tr>
                  <td colSpan={5} className="py-16 text-center">
                    <div className="flex flex-col items-center gap-3">
                      <Loader2 className="h-6 w-6 animate-spin text-neutral-600" />
                      <p className="text-sm text-neutral-500">
                        Loading audit logs...
                      </p>
                    </div>
                  </td>
                </tr>
              )}

              {/* Error State */}
              {!isLoading && error && (
                <tr>
                  <td colSpan={5} className="py-16 text-center">
                    <div className="flex flex-col items-center gap-3">
                      <XCircle className="h-6 w-6 text-red-500/60" />
                      <p className="text-sm text-red-400">{error}</p>
                      <p className="text-xs text-neutral-600">
                        Make sure the backend is running on port 8000
                      </p>
                    </div>
                  </td>
                </tr>
              )}

              {/* Empty State */}
              {!isLoading && !error && logs.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-16 text-center">
                    <div className="flex flex-col items-center gap-3">
                      <div className="flex h-12 w-12 items-center justify-center rounded-full border border-neutral-800 bg-neutral-800/50">
                        <ScrollText className="h-5 w-5 text-neutral-600" />
                      </div>
                      <p className="text-sm font-medium text-neutral-400">
                        No logs found
                      </p>
                      <p className="text-xs text-neutral-600">
                        Verification attempts will appear here automatically.
                      </p>
                    </div>
                  </td>
                </tr>
              )}

              {/* Data Rows */}
              {!isLoading &&
                !error &&
                logs.map((log) => {
                  const success = isSuccess(log.status);
                  const confidence =
                    log.biometric_score != null
                      ? `${(log.biometric_score * 100).toFixed(1)}%`
                      : "—";

                  return (
                    <tr
                      key={log.id}
                      className="border-b border-neutral-800/50 transition-colors hover:bg-neutral-800/30"
                    >
                      {/* Timestamp */}
                      <td className="py-4 pr-6 text-sm text-neutral-400">
                        {formatTimestamp(log.attempt_time)}
                      </td>

                      {/* Request ID */}
                      <td className="py-4 pr-6">
                        <span className="rounded-md border border-neutral-800 bg-neutral-800/50 px-2 py-1 font-mono text-xs text-neutral-300">
                          req_{String(log.id).padStart(5, "0")}
                        </span>
                      </td>

                      {/* CNIC */}
                      <td className="py-4 pr-6">
                        <div className="flex items-center gap-2">
                          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-neutral-800 bg-neutral-800/50">
                            <Shield className="h-3 w-3 text-neutral-500" />
                          </div>
                          <span className="font-mono text-sm text-white">
                            {formatCnic(log.user_id)}
                          </span>
                        </div>
                      </td>

                      {/* Match Confidence */}
                      <td className="py-4 pr-6">
                        <span
                          className={`font-mono text-sm font-semibold ${
                            success ? "text-green-400" : "text-red-400"
                          }`}
                        >
                          {confidence}
                        </span>
                      </td>

                      {/* Status */}
                      <td className="py-4">
                        {success ? (
                          <span className="inline-flex items-center gap-1.5 rounded-full border border-green-500/30 bg-green-500/10 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-green-400">
                            <CheckCircle2 className="h-3 w-3" />
                            Success
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 rounded-full border border-red-500/30 bg-red-500/10 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-red-400">
                            <XCircle className="h-3 w-3" />
                            {log.status.replace("DENIED_", "")}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
