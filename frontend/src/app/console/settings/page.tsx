"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Shield,
  Crown,
  User,
  CreditCard,
  Phone,
  Mail,
  Fingerprint,
  Settings,
  Save,
  Loader2,
  CheckCircle2,
} from "lucide-react";

/* ── Types ─────────────────────────────────────────────────── */

interface AwaazUser {
  cnic?: string;
  user_id?: string;
  full_name?: string;
  [key: string]: unknown;
}

interface ProfileData {
  user_id: string;
  cnic: string;
  full_name: string | null;
  phone_number: string | null;
  email: string | null;
  network_operator: string | null;
}

/* ── Helpers ───────────────────────────────────────────────── */

const SUPER_ADMIN_CNIC = "0000000000000";

function normalizeCnic(raw: string): string {
  return raw.replace(/[-\s]/g, "").trim();
}

function formatCnic(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length !== 13) return raw;
  return `${digits.slice(0, 5)}-${digits.slice(5, 12)}-${digits.slice(12)}`;
}

function isSuperAdmin(cnic: string): boolean {
  return normalizeCnic(cnic) === SUPER_ADMIN_CNIC;
}

/* ── Component ─────────────────────────────────────────────── */

export default function AccountSettingsPage() {
  const router = useRouter();

  /* ── State ──────────────────────────────────────────────── */
  const [cnic, setCnic] = useState("");
  const [fullName, setFullName] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [email, setEmail] = useState("");

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [successMsg, setSuccessMsg] = useState("");
  const [errorMsg, setErrorMsg] = useState("");

  const isAdmin = isSuperAdmin(cnic);

  /* ── Load profile from backend on mount ─────────────────── */
  useEffect(() => {
    let stored: AwaazUser | null = null;
    try {
      const raw = localStorage.getItem("awaaz_user");
      if (raw) stored = JSON.parse(raw);
    } catch {
      // no-op
    }

    const userId = stored?.cnic || stored?.user_id || "";
    if (!userId) {
      setLoading(false);
      return;
    }

    setCnic(normalizeCnic(userId));

    fetch(`/api/profile?user_id=${encodeURIComponent(userId)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: ProfileData = await res.json();
        setFullName(data.full_name || "");
        setPhoneNumber(data.phone_number || "");
        setEmail(data.email || "");
      })
      .catch((err) => {
        console.error("Failed to load profile:", err);
        // Fallback to localStorage values
        setFullName(stored?.full_name || "");
      })
      .finally(() => setLoading(false));
  }, []);

  /* ── Save profile ───────────────────────────────────────── */
  const handleSave = async () => {
    setSaving(true);
    setSuccessMsg("");
    setErrorMsg("");

    try {
      const res = await fetch("/api/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: cnic,
          full_name: fullName,
          phone_number: phoneNumber,
          email: email,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || `Save failed (HTTP ${res.status})`);
      }

      const data = await res.json();

      // Update localStorage so sidebar + navbar pick up the new name
      try {
        const raw = localStorage.getItem("awaaz_user");
        const existing: AwaazUser = raw ? JSON.parse(raw) : {};
        existing.full_name = data.full_name;
        localStorage.setItem("awaaz_user", JSON.stringify(existing));
      } catch {
        // no-op
      }

      setSuccessMsg("Profile updated successfully!");

      // Force sidebar re-read by triggering a shallow navigation
      router.refresh();
    } catch (err) {
      setErrorMsg((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  /* ── Render ─────────────────────────────────────────────── */
  return (
    <div className="p-8 lg:p-10">
      {/* ── Header ───────────────────────────────────────────── */}
      <div className="mb-8">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold text-white">Account Settings</h1>
        </div>
        <p className="mt-1.5 text-sm text-neutral-500">
          View and manage your account profile
        </p>
      </div>

      {loading ? (
        <div className="flex min-h-[300px] items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-neutral-600" />
        </div>
      ) : (
        <div className="max-w-2xl space-y-8">
          {/* ── Profile Header ──────────────────────────────── */}
          <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-6 sm:p-8">
            <div className="mb-6 flex items-center gap-5">
              <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl border border-neutral-700 bg-neutral-800/60">
                {isAdmin ? (
                  <Crown className="h-7 w-7 text-amber-400" />
                ) : (
                  <User className="h-7 w-7 text-green-400" />
                )}
              </div>
              <div>
                <h2 className="text-lg font-bold text-white">
                  {fullName || "User"}
                </h2>
                {isAdmin ? (
                  <span className="mt-1.5 inline-flex items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-amber-400">
                    <Crown className="h-3 w-3" />
                    Super Admin
                  </span>
                ) : (
                  <span className="mt-1.5 inline-flex items-center gap-1.5 rounded-full border border-green-500/40 bg-green-500/10 px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-green-400">
                    <Shield className="h-3 w-3" />
                    Enterprise User
                  </span>
                )}
              </div>
            </div>

            {/* Auth Provider (read-only info) */}
            <div className="flex items-center gap-4 rounded-lg border border-neutral-800/50 bg-black/40 px-4 py-3">
              <Fingerprint className="h-4 w-4 text-neutral-600" />
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wider text-neutral-600">
                  Auth Provider
                </p>
                <p className="mt-0.5 text-sm font-medium text-white">
                  Voice Biometric (ECAPA-TDNN)
                </p>
              </div>
            </div>
          </div>

          {/* ── Editable Profile Form ───────────────────────── */}
          <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-6 sm:p-8">
            <h3 className="mb-6 text-sm font-semibold uppercase tracking-wider text-neutral-400">
              Profile Information
            </h3>

            <div className="space-y-5">
              {/* CNIC — Read Only */}
              <div>
                <label className="mb-2 block text-xs font-medium uppercase tracking-wider text-neutral-500">
                  CNIC
                  <span className="ml-2 text-[10px] normal-case tracking-normal text-neutral-600">
                    Read-only
                  </span>
                </label>
                <div className="relative">
                  <CreditCard className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-700" />
                  <input
                    type="text"
                    value={cnic ? formatCnic(cnic) : "—"}
                    disabled
                    className="w-full rounded-lg border border-neutral-800 bg-neutral-950 px-4 py-3 pl-11 text-sm font-mono tracking-wide text-neutral-500 cursor-not-allowed"
                  />
                </div>
              </div>

              {/* Full Name */}
              <div>
                <label
                  htmlFor="fullName"
                  className="mb-2 block text-xs font-medium uppercase tracking-wider text-neutral-500"
                >
                  Full Name
                </label>
                <div className="relative">
                  <User className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-600" />
                  <input
                    id="fullName"
                    type="text"
                    placeholder="Enter your full name"
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    className="w-full rounded-lg border border-neutral-800 bg-black px-4 py-3 pl-11 text-sm text-white transition-all placeholder:text-neutral-600 focus:border-green-500/50 focus:ring-1 focus:ring-green-500/20 focus:outline-none"
                  />
                </div>
              </div>

              {/* Phone Number */}
              <div>
                <label
                  htmlFor="phone"
                  className="mb-2 block text-xs font-medium uppercase tracking-wider text-neutral-500"
                >
                  Phone Number
                </label>
                <div className="relative">
                  <Phone className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-600" />
                  <input
                    id="phone"
                    type="text"
                    placeholder="03001234567"
                    value={phoneNumber}
                    onChange={(e) => {
                      const v = e.target.value.replace(/\D/g, "");
                      if (v.length <= 11) setPhoneNumber(v);
                    }}
                    maxLength={11}
                    className="w-full rounded-lg border border-neutral-800 bg-black px-4 py-3 pl-11 text-sm text-white transition-all placeholder:text-neutral-600 focus:border-green-500/50 focus:ring-1 focus:ring-green-500/20 focus:outline-none"
                  />
                </div>
              </div>

              {/* Email */}
              <div>
                <label
                  htmlFor="email"
                  className="mb-2 block text-xs font-medium uppercase tracking-wider text-neutral-500"
                >
                  Email
                </label>
                <div className="relative">
                  <Mail className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-600" />
                  <input
                    id="email"
                    type="email"
                    placeholder="user@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full rounded-lg border border-neutral-800 bg-black px-4 py-3 pl-11 text-sm text-white transition-all placeholder:text-neutral-600 focus:border-green-500/50 focus:ring-1 focus:ring-green-500/20 focus:outline-none"
                  />
                </div>
              </div>
            </div>

            {/* Messages */}
            {successMsg && (
              <div className="mt-5 flex items-center gap-2 rounded-lg border border-green-500/30 bg-green-500/5 px-4 py-3">
                <CheckCircle2 className="h-4 w-4 shrink-0 text-green-400" />
                <p className="text-sm font-medium text-green-400">
                  {successMsg}
                </p>
              </div>
            )}
            {errorMsg && (
              <div className="mt-5 rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-3">
                <p className="text-sm font-medium text-red-400">{errorMsg}</p>
              </div>
            )}

            {/* Save Button */}
            <div className="mt-6 flex justify-end border-t border-neutral-800 pt-6">
              <button
                onClick={handleSave}
                disabled={saving}
                className="inline-flex items-center gap-2 rounded-lg bg-green-500 px-6 py-2.5 text-sm font-semibold text-black transition-all hover:bg-green-400 hover:shadow-[0_0_24px_rgba(34,197,94,0.25)] disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {saving ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Save className="h-4 w-4" />
                )}
                {saving ? "Saving..." : "Save Changes"}
              </button>
            </div>
          </div>

          {/* ── Admin Capabilities ──────────────────────────── */}
          {isAdmin && (
            <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-6">
              <p className="mb-3 text-xs font-bold uppercase tracking-wider text-amber-400">
                <Settings className="mr-1.5 inline h-3.5 w-3.5" />
                Super Admin Privileges
              </p>
              <ul className="space-y-1.5 text-xs text-neutral-400">
                <li>
                  • View{" "}
                  <strong className="text-neutral-300">all</strong> enrolled
                  profiles across the platform
                </li>
                <li>
                  • Access{" "}
                  <strong className="text-neutral-300">full</strong> audit log
                  history for all users
                </li>
                <li>
                  • Manage API keys and enterprise integrations
                </li>
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
