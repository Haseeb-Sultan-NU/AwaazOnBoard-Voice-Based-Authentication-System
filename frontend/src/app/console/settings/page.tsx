"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  Shield,
  Crown,
  User,
  CreditCard,
  Phone,
  Mail,
  Wifi,
  Fingerprint,
  Settings,
  Save,
  Loader2,
  CheckCircle2,
  Lock,
  AlertTriangle,
  Mic,
  Trash2,
  AlertCircle,
  Square,
  Upload,
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
  is_enrolled: boolean;
  enrollment_status: string | null;
  audio_quality_snr: number | null;
  enrolled_at: string | null;
}

/* ── Helpers ───────────────────────────────────────────────── */

const SUPER_ADMIN_CNIC = "0000000000000";

const OPERATORS = ["Jazz", "Zong", "Telenor", "Ufone", "ONIC", "SCO"];

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

  /* ── Profile State ─────────────────────────────────────── */
  const [cnic, setCnic] = useState("");
  const [fullName, setFullName] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [email, setEmail] = useState("");
  const [networkOperator, setNetworkOperator] = useState("");

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [profileMsg, setProfileMsg] = useState({ type: "", text: "" });

  /* ── Password State ────────────────────────────────────── */
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [savingPassword, setSavingPassword] = useState(false);
  const [passwordMsg, setPasswordMsg] = useState({ type: "", text: "" });

  /* ── Voice Profile State ───────────────────────────────── */
  const [isEnrolled, setIsEnrolled] = useState(false);
  const [enrollmentStatus, setEnrollmentStatus] = useState<string | null>(null);
  const [audioSnr, setAudioSnr] = useState<number | null>(null);
  const [enrolledAt, setEnrolledAt] = useState<string | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [voiceMsg, setVoiceMsg] = useState({ type: "", text: "" });
  const [deletingAccount, setDeletingAccount] = useState(false);

  /* ── Enrollment Recording State ────────────────────────── */
  const TOTAL_TAKES = 3;
  const RECORDING_DURATION = 5;

  const [enrollTake, setEnrollTake] = useState(1);
  const [enrollRecording, setEnrollRecording] = useState(false);
  const [enrollCountdown, setEnrollCountdown] = useState(RECORDING_DURATION);
  const [enrollBlobs, setEnrollBlobs] = useState<Blob[]>([]);
  const [enrollMicError, setEnrollMicError] = useState(false);
  const [enrollSubmitting, setEnrollSubmitting] = useState(false);

  const enrollRecorderRef = useRef<MediaRecorder | null>(null);
  const enrollStreamRef = useRef<MediaStream | null>(null);
  const enrollTimerRef = useRef<NodeJS.Timeout | null>(null);
  const enrollCountdownRef = useRef<NodeJS.Timeout | null>(null);

  const isAdmin = isSuperAdmin(cnic);
  const allTakesRecorded = enrollBlobs.length >= TOTAL_TAKES;

  /* ── Load profile on mount ─────────────────────────────── */
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
        setNetworkOperator(data.network_operator || "");
        setIsEnrolled(data.is_enrolled);
        setEnrollmentStatus(data.enrollment_status);
        setAudioSnr(data.audio_quality_snr);
        setEnrolledAt(data.enrolled_at);
      })
      .catch((err) => {
        console.error("Failed to load profile:", err);
        setFullName(stored?.full_name || "");
      })
      .finally(() => setLoading(false));
  }, []);

  /* ── Save Profile ──────────────────────────────────────── */
  const handleSaveProfile = async () => {
    setSaving(true);
    setProfileMsg({ type: "", text: "" });

    try {
      const res = await fetch("/api/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: cnic,
          phone_number: phoneNumber,
          email,
          network_operator: networkOperator || null,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || `Save failed (HTTP ${res.status})`);
      }

      const data = await res.json();

      try {
        const raw = localStorage.getItem("awaaz_user");
        const existing: AwaazUser = raw ? JSON.parse(raw) : {};
        existing.full_name = data.full_name;
        localStorage.setItem("awaaz_user", JSON.stringify(existing));
      } catch {
        // no-op
      }

      setProfileMsg({ type: "success", text: "Profile updated successfully!" });
      router.refresh();
    } catch (err) {
      setProfileMsg({ type: "error", text: (err as Error).message });
    } finally {
      setSaving(false);
    }
  };

  /* ── Change Password ───────────────────────────────────── */
  const handleChangePassword = async () => {
    setPasswordMsg({ type: "", text: "" });

    if (newPassword.length < 8) {
      setPasswordMsg({ type: "error", text: "New password must be at least 8 characters." });
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordMsg({ type: "error", text: "New passwords do not match." });
      return;
    }

    setSavingPassword(true);

    try {
      const res = await fetch("/api/profile/password", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: cnic,
          current_password: currentPassword,
          new_password: newPassword,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || `Password change failed (HTTP ${res.status})`);
      }

      setPasswordMsg({ type: "success", text: "Password updated successfully!" });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (err) {
      setPasswordMsg({ type: "error", text: (err as Error).message });
    } finally {
      setSavingPassword(false);
    }
  };

  /* ── Revoke Voice Profile ──────────────────────────────── */
  const handleRevokeVoice = async () => {
    if (!confirm("Are you sure you want to revoke your voice profile? You will need to re-enroll to use voice authentication.")) {
      return;
    }

    setRevoking(true);
    setVoiceMsg({ type: "", text: "" });

    try {
      const res = await fetch(`/api/enroll?user_id=${encodeURIComponent(cnic)}`, {
        method: "DELETE",
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || `Revocation failed (HTTP ${res.status})`);
      }

      setIsEnrolled(false);
      setEnrollmentStatus(null);
      setAudioSnr(null);
      setEnrolledAt(null);
      setVoiceMsg({ type: "success", text: "Voice profile revoked successfully." });
    } catch (err) {
      setVoiceMsg({ type: "error", text: (err as Error).message });
    } finally {
      setRevoking(false);
    }
  };

  /* ── Enrollment Recording Logic ────────────────────────── */

  useEffect(() => {
    return () => {
      if (enrollTimerRef.current) clearTimeout(enrollTimerRef.current);
      if (enrollCountdownRef.current) clearInterval(enrollCountdownRef.current);
      if (enrollStreamRef.current) {
        enrollStreamRef.current.getTracks().forEach((t) => t.stop());
      }
    };
  }, []);

  const enrollCompleteTake = useCallback((blob: Blob) => {
    setEnrollBlobs((prev) => {
      const next = [...prev, blob];
      if (next.length < TOTAL_TAKES) {
        setEnrollTake(next.length + 1);
      }
      return next;
    });
    setEnrollRecording(false);
    setEnrollCountdown(RECORDING_DURATION);
  }, []);

  const enrollCleanupMedia = useCallback(() => {
    if (enrollTimerRef.current) { clearTimeout(enrollTimerRef.current); enrollTimerRef.current = null; }
    if (enrollCountdownRef.current) { clearInterval(enrollCountdownRef.current); enrollCountdownRef.current = null; }
    if (enrollStreamRef.current) {
      enrollStreamRef.current.getTracks().forEach((t) => t.stop());
      enrollStreamRef.current = null;
    }
  }, []);

  const enrollStopRecording = useCallback(() => {
    if (enrollRecorderRef.current && enrollRecorderRef.current.state === "recording") {
      enrollRecorderRef.current.stop();
    }
    enrollCleanupMedia();
  }, [enrollCleanupMedia]);

  const enrollStartRecording = useCallback(async () => {
    setEnrollMicError(false);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      enrollStreamRef.current = stream;
      const recorder = new MediaRecorder(stream);
      enrollRecorderRef.current = recorder;
      const chunks: BlobPart[] = [];

      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
      recorder.onstop = () => { enrollCompleteTake(new Blob(chunks, { type: "audio/webm" })); };

      recorder.start();
      setEnrollRecording(true);
      setEnrollCountdown(RECORDING_DURATION);

      let remaining = RECORDING_DURATION;
      enrollCountdownRef.current = setInterval(() => {
        remaining -= 1;
        setEnrollCountdown(Math.max(remaining, 0));
        if (remaining <= 0 && enrollCountdownRef.current) clearInterval(enrollCountdownRef.current);
      }, 1000);

      enrollTimerRef.current = setTimeout(() => {
        if (enrollRecorderRef.current && enrollRecorderRef.current.state === "recording") enrollRecorderRef.current.stop();
        enrollCleanupMedia();
      }, RECORDING_DURATION * 1000);
    } catch {
      setEnrollMicError(true);
    }
  }, [enrollCompleteTake, enrollCleanupMedia]);

  const handleEnrollMicClick = () => {
    if (enrollRecording) enrollStopRecording();
    else enrollStartRecording();
  };

  const handleEnrollReset = () => {
    enrollStopRecording();
    setEnrollBlobs([]);
    setEnrollTake(1);
    setEnrollCountdown(RECORDING_DURATION);
    setEnrollMicError(false);
    setVoiceMsg({ type: "", text: "" });
  };

  const handleSubmitVoiceprint = async () => {
    if (enrollBlobs.length < TOTAL_TAKES) return;
    setEnrollSubmitting(true);
    setVoiceMsg({ type: "", text: "" });

    try {
      const formData = new FormData();
      formData.append("user_id", cnic);
      enrollBlobs.forEach((blob, idx) => {
        formData.append(`take_${idx + 1}`, blob, `take_${idx + 1}.webm`);
      });

      const res = await fetch("/api/enroll", {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || `Enrollment failed (HTTP ${res.status})`);
      }

      setIsEnrolled(true);
      setEnrollmentStatus("ACTIVE");
      setEnrolledAt(new Date().toISOString());
      setVoiceMsg({ type: "success", text: "Voice profile enrolled successfully!" });
      // Reset recording state
      setEnrollBlobs([]);
      setEnrollTake(1);
    } catch (err) {
      setVoiceMsg({ type: "error", text: (err as Error).message });
    } finally {
      setEnrollSubmitting(false);
    }
  };

  /* ── Shared input class ────────────────────────────────── */
  const inputClass =
    "w-full rounded-lg border border-neutral-800 bg-black px-4 py-3 pl-11 text-sm text-white transition-all placeholder:text-neutral-600 focus:border-green-500/50 focus:ring-1 focus:ring-green-500/20 focus:outline-none";
  const readOnlyClass =
    "w-full rounded-lg border border-neutral-800 bg-neutral-950 px-4 py-3 pl-11 text-sm font-mono tracking-wide text-neutral-500 cursor-not-allowed";
  const iconClass =
    "pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-600";
  const labelClass =
    "mb-2 block text-xs font-medium uppercase tracking-wider text-neutral-500";

  /* ── Render ─────────────────────────────────────────────── */
  return (
    <div className="p-8 lg:p-10">
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold text-white">Account Settings</h1>
        </div>
        <p className="mt-1.5 text-sm text-neutral-500">
          View and manage your account profile, security, and voice biometrics
        </p>
      </div>

      {loading ? (
        <div className="flex min-h-[300px] items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-neutral-600" />
        </div>
      ) : (
        <div className="max-w-2xl space-y-8">
          {/* ═══ Profile Header Card ═══ */}
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

          {/* ═══ Profile Information Card ═══ */}
          <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-6 sm:p-8">
            <h3 className="mb-6 text-sm font-semibold uppercase tracking-wider text-neutral-400">
              Profile Information
            </h3>

            <div className="space-y-5">
              {/* CNIC — Read Only */}
              <div>
                <label className={labelClass}>
                  CNIC
                  <span className="ml-2 text-[10px] normal-case tracking-normal text-neutral-600">
                    Read-only
                  </span>
                </label>
                <div className="relative">
                  <CreditCard className={`${iconClass} !text-neutral-700`} />
                  <input type="text" value={cnic ? formatCnic(cnic) : "—"} disabled className={readOnlyClass} />
                </div>
              </div>

              {/* Full Name — Read Only */}
              <div>
                <label className={labelClass}>
                  Full Name
                  <span className="ml-2 text-[10px] normal-case tracking-normal text-neutral-600">
                    Read-only
                  </span>
                </label>
                <div className="relative">
                  <User className={`${iconClass} !text-neutral-700`} />
                  <input
                    type="text"
                    value={fullName || "—"}
                    disabled
                    className="w-full rounded-lg border border-neutral-800 bg-neutral-950 px-4 py-3 pl-11 text-sm text-neutral-500 cursor-not-allowed"
                  />
                </div>
              </div>

              {/* Phone Number */}
              <div>
                <label htmlFor="phone" className={labelClass}>Phone Number</label>
                <div className="relative">
                  <Phone className={iconClass} />
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
                    className={inputClass}
                  />
                </div>
              </div>

              {/* Email */}
              <div>
                <label htmlFor="email" className={labelClass}>Email</label>
                <div className="relative">
                  <Mail className={iconClass} />
                  <input
                    id="email"
                    type="email"
                    placeholder="user@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className={inputClass}
                  />
                </div>
              </div>

              {/* Network Operator */}
              <div>
                <label htmlFor="operator" className={labelClass}>Network Operator</label>
                <div className="relative">
                  <Wifi className={iconClass} />
                  <select
                    id="operator"
                    value={networkOperator}
                    onChange={(e) => setNetworkOperator(e.target.value)}
                    className="w-full appearance-none rounded-lg border border-neutral-800 bg-black px-4 py-3 pl-11 text-sm text-white transition-all focus:border-green-500/50 focus:ring-1 focus:ring-green-500/20 focus:outline-none"
                  >
                    <option value="">Select operator</option>
                    {OPERATORS.map((op) => (
                      <option key={op} value={op}>{op}</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>

            {/* Profile Messages */}
            {profileMsg.text && (
              <div className={`mt-5 flex items-center gap-2 rounded-lg border px-4 py-3 ${profileMsg.type === "success"
                  ? "border-green-500/30 bg-green-500/5"
                  : "border-red-500/30 bg-red-500/5"
                }`}>
                {profileMsg.type === "success" ? (
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-green-400" />
                ) : (
                  <AlertCircle className="h-4 w-4 shrink-0 text-red-400" />
                )}
                <p className={`text-sm font-medium ${profileMsg.type === "success" ? "text-green-400" : "text-red-400"}`}>
                  {profileMsg.text}
                </p>
              </div>
            )}

            {/* Save Button */}
            <div className="mt-6 flex justify-end border-t border-neutral-800 pt-6">
              <button
                onClick={handleSaveProfile}
                disabled={saving}
                className="inline-flex items-center gap-2 rounded-lg bg-green-500 px-6 py-2.5 text-sm font-semibold text-black transition-all hover:bg-green-400 hover:shadow-[0_0_24px_rgba(34,197,94,0.25)] disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                {saving ? "Saving..." : "Save Changes"}
              </button>
            </div>
          </div>

          {/* ═══ Security Card — Change Password ═══ */}
          <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-6 sm:p-8">
            <div className="mb-6 flex items-center gap-2">
              <Lock className="h-4 w-4 text-neutral-400" />
              <h3 className="text-sm font-semibold uppercase tracking-wider text-neutral-400">
                Security
              </h3>
            </div>

            <div className="space-y-4">
              {/* Current Password */}
              <div>
                <label htmlFor="currentPw" className={labelClass}>Current Password</label>
                <div className="relative">
                  <Lock className={iconClass} />
                  <input
                    id="currentPw"
                    type="password"
                    placeholder="••••••••••"
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    className={inputClass}
                  />
                </div>
              </div>

              {/* New Password */}
              <div>
                <label htmlFor="newPw" className={labelClass}>New Password (min. 8 characters)</label>
                <div className="relative">
                  <Lock className={iconClass} />
                  <input
                    id="newPw"
                    type="password"
                    placeholder="••••••••••"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    className={inputClass}
                  />
                </div>
              </div>

              {/* Confirm New Password */}
              <div>
                <label htmlFor="confirmPw" className={labelClass}>Confirm New Password</label>
                <div className="relative">
                  <Lock className={iconClass} />
                  <input
                    id="confirmPw"
                    type="password"
                    placeholder="••••••••••"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    className={inputClass}
                  />
                </div>
                {confirmPassword && newPassword !== confirmPassword && (
                  <p className="mt-1.5 text-xs text-red-400">Passwords do not match.</p>
                )}
              </div>
            </div>

            {/* Password Messages */}
            {passwordMsg.text && (
              <div className={`mt-5 flex items-center gap-2 rounded-lg border px-4 py-3 ${passwordMsg.type === "success"
                  ? "border-green-500/30 bg-green-500/5"
                  : "border-red-500/30 bg-red-500/5"
                }`}>
                {passwordMsg.type === "success" ? (
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-green-400" />
                ) : (
                  <AlertCircle className="h-4 w-4 shrink-0 text-red-400" />
                )}
                <p className={`text-sm font-medium ${passwordMsg.type === "success" ? "text-green-400" : "text-red-400"}`}>
                  {passwordMsg.text}
                </p>
              </div>
            )}

            <div className="mt-6 flex justify-end border-t border-neutral-800 pt-6">
              <button
                onClick={handleChangePassword}
                disabled={savingPassword || !currentPassword || !newPassword || !confirmPassword}
                className="inline-flex items-center gap-2 rounded-lg bg-green-500 px-6 py-2.5 text-sm font-semibold text-black transition-all hover:bg-green-400 hover:shadow-[0_0_24px_rgba(34,197,94,0.25)] disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {savingPassword ? <Loader2 className="h-4 w-4 animate-spin" /> : <Lock className="h-4 w-4" />}
                {savingPassword ? "Updating..." : "Update Password"}
              </button>
            </div>
          </div>

          {/* ═══ Voice Biometrics Card ═══ */}
          <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-6 sm:p-8">
            <div className="mb-6 flex items-center gap-2">
              <Mic className="h-4 w-4 text-neutral-400" />
              <h3 className="text-sm font-semibold uppercase tracking-wider text-neutral-400">
                Voice Biometrics
              </h3>
            </div>

            {isEnrolled ? (
              <div className="space-y-4">
                {/* Status Row */}
                <div className="flex items-center justify-between rounded-lg border border-neutral-800/50 bg-black/40 px-4 py-3">
                  <div className="flex items-center gap-3">
                    <div className="flex h-8 w-8 items-center justify-center rounded-full bg-green-500/10">
                      <Fingerprint className="h-4 w-4 text-green-400" />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-white">Voice Profile</p>
                      <p className="text-xs text-neutral-500">
                        Status:{" "}
                        <span className="font-semibold text-green-400">
                          {enrollmentStatus || "ACTIVE"}
                        </span>
                      </p>
                    </div>
                  </div>
                  <div className="rounded-full border border-green-500/30 bg-green-500/10 px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-green-400">
                    Enrolled
                  </div>
                </div>

                {/* Metadata Grid */}
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-lg border border-neutral-800/50 bg-black/40 px-4 py-3">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-neutral-600">
                      Audio Quality (SNR)
                    </p>
                    <p className="mt-1 text-sm font-medium text-white">
                      {audioSnr !== null ? `${audioSnr.toFixed(1)} dB` : "—"}
                    </p>
                  </div>
                  <div className="rounded-lg border border-neutral-800/50 bg-black/40 px-4 py-3">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-neutral-600">
                      Enrolled On
                    </p>
                    <p className="mt-1 text-sm font-medium text-white">
                      {enrolledAt
                        ? new Date(enrolledAt).toLocaleDateString("en-PK", {
                          year: "numeric",
                          month: "short",
                          day: "numeric",
                        })
                        : "—"}
                    </p>
                  </div>
                </div>

                {/* Revoke */}
                <div className="rounded-lg border border-red-500/10 bg-red-500/5 p-4">
                  <div className="flex items-start gap-3">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
                    <div className="flex-1">
                      <p className="text-sm font-medium text-red-400">Danger Zone</p>
                      <p className="mt-1 text-xs text-neutral-500">
                        Revoking your voice profile will permanently delete your biometric
                        template. You will need to re-enroll to use voice authentication.
                      </p>
                      <button
                        onClick={handleRevokeVoice}
                        disabled={revoking}
                        className="mt-3 inline-flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-xs font-semibold text-red-400 transition-all hover:bg-red-500/20 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {revoking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                        {revoking ? "Revoking..." : "Revoke Voice Profile"}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="space-y-5">
                {/* ── Take Progress ── */}
                <div className="flex items-center gap-3">
                  {Array.from({ length: TOTAL_TAKES }).map((_, i) => {
                    const done = i < enrollBlobs.length;
                    const active = i === enrollBlobs.length && !allTakesRecorded;
                    return (
                      <div key={i} className="flex items-center gap-2">
                        <div
                          className={`flex h-8 w-8 items-center justify-center rounded-full border text-xs font-bold transition-all ${done
                              ? "border-green-500/50 bg-green-500/10 text-green-400"
                              : active
                                ? "border-green-500/40 bg-green-500/5 text-green-300 ring-2 ring-green-500/20"
                                : "border-neutral-800 bg-neutral-900 text-neutral-600"
                            }`}
                        >
                          {done ? <CheckCircle2 className="h-4 w-4" /> : i + 1}
                        </div>
                        {i < TOTAL_TAKES - 1 && (
                          <div className={`h-px w-6 ${done ? "bg-green-500/30" : "bg-neutral-800"
                            }`} />
                        )}
                      </div>
                    );
                  })}
                  <span className="ml-auto text-xs font-medium text-neutral-500">
                    {allTakesRecorded ? "All samples captured" : `Take ${enrollTake} of ${TOTAL_TAKES}`}
                  </span>
                </div>

                {/* ── Recording Area ── */}
                {!allTakesRecorded ? (
                  <div className="flex flex-col items-center gap-4 rounded-lg border border-dashed border-neutral-800 bg-black/20 px-6 py-8">
                    {/* Mic Button */}
                    <button
                      onClick={handleEnrollMicClick}
                      disabled={enrollMicError}
                      className={`group relative flex h-20 w-20 items-center justify-center rounded-full border-2 transition-all ${enrollRecording
                          ? "border-red-500 bg-red-500/10 shadow-[0_0_30px_rgba(239,68,68,0.15)]"
                          : "border-green-500/50 bg-green-500/5 hover:border-green-400 hover:bg-green-500/10 hover:shadow-[0_0_30px_rgba(34,197,94,0.15)]"
                        } disabled:opacity-40 disabled:cursor-not-allowed`}
                    >
                      {enrollRecording ? (
                        <Square className="h-7 w-7 text-red-400" />
                      ) : (
                        <Mic className="h-7 w-7 text-green-400 transition-transform group-hover:scale-110" />
                      )}
                      {/* Pulse ring when recording */}
                      {enrollRecording && (
                        <span className="absolute inset-0 animate-ping rounded-full border-2 border-red-500/30" />
                      )}
                    </button>

                    {/* Status Text */}
                    {enrollRecording ? (
                      <div className="text-center">
                        <p className="text-sm font-semibold text-red-400">
                          Recording Take {enrollTake}…
                        </p>
                        <p className="mt-1 font-mono text-2xl font-bold tabular-nums text-white">
                          {enrollCountdown}s
                        </p>
                      </div>
                    ) : (
                      <div className="text-center">
                        <p className="text-sm font-medium text-neutral-400">
                          {enrollMicError ? "Microphone access denied" : `Tap to record Take ${enrollTake}`}
                        </p>
                        <p className="mt-1 text-xs text-neutral-600">
                          {enrollMicError
                            ? "Please allow microphone access in your browser settings."
                            : "Speak naturally for 5 seconds. Say any sentence in Urdu."}
                        </p>
                      </div>
                    )}

                    {/* Reset Button */}
                    {enrollBlobs.length > 0 && !enrollRecording && (
                      <button
                        onClick={handleEnrollReset}
                        className="text-xs font-medium text-neutral-500 transition-colors hover:text-neutral-300"
                      >
                        Reset all takes
                      </button>
                    )}
                  </div>
                ) : (
                  /* ── All Takes Done — Submit ── */
                  <div className="flex flex-col items-center gap-4 rounded-lg border border-green-500/20 bg-green-500/5 px-6 py-8">
                    <div className="flex h-12 w-12 items-center justify-center rounded-full bg-green-500/10">
                      <CheckCircle2 className="h-6 w-6 text-green-400" />
                    </div>
                    <div className="text-center">
                      <p className="text-sm font-semibold text-green-400">
                        All 3 voice samples captured
                      </p>
                      <p className="mt-1 text-xs text-neutral-500">
                        Submit to generate your secure biometric voiceprint.
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      <button
                        onClick={handleEnrollReset}
                        className="inline-flex items-center gap-2 rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-2.5 text-xs font-semibold text-neutral-400 transition-all hover:bg-neutral-800 hover:text-white"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        Re-record
                      </button>
                      <button
                        onClick={handleSubmitVoiceprint}
                        disabled={enrollSubmitting}
                        className="inline-flex items-center gap-2 rounded-lg bg-green-500 px-6 py-2.5 text-sm font-semibold text-black transition-all hover:bg-green-400 hover:shadow-[0_0_24px_rgba(34,197,94,0.25)] disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {enrollSubmitting ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Upload className="h-4 w-4" />
                        )}
                        {enrollSubmitting ? "Enrolling…" : "Submit Voiceprint"}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Voice Messages */}
            {voiceMsg.text && (
              <div className={`mt-5 flex items-center gap-2 rounded-lg border px-4 py-3 ${voiceMsg.type === "success"
                  ? "border-green-500/30 bg-green-500/5"
                  : "border-red-500/30 bg-red-500/5"
                }`}>
                {voiceMsg.type === "success" ? (
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-green-400" />
                ) : (
                  <AlertCircle className="h-4 w-4 shrink-0 text-red-400" />
                )}
                <p className={`text-sm font-medium ${voiceMsg.type === "success" ? "text-green-400" : "text-red-400"}`}>
                  {voiceMsg.text}
                </p>
              </div>
            )}
          </div>

          {/* ═══ Admin Capabilities ═══ */}
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

          {/* ═══ Danger Zone ═══ */}
          <div className="rounded-xl border border-red-500/30 bg-red-500/5 p-6">
            <p className="mb-1 text-xs font-bold uppercase tracking-wider text-red-400">
              <AlertTriangle className="mr-1.5 inline h-3.5 w-3.5" />
              Danger Zone
            </p>
            <p className="mb-4 text-xs text-neutral-500">
              Permanently deletes your account, your voice profile, and all customers you enrolled. This action cannot be undone.
            </p>
            <button
              onClick={async () => {
                if (!window.confirm(
                  "Are you absolutely sure? This will permanently delete your account and all associated customer data. This cannot be undone."
                )) return;
                setDeletingAccount(true);
                try {
                  const res = await fetch("/api/profile", { method: "DELETE" });
                  if (!res.ok) {
                    const err = await res.json().catch(() => ({}));
                    alert(err.detail || "Deletion failed. Please try again.");
                    setDeletingAccount(false);
                    return;
                  }
                  localStorage.removeItem("awaaz_user");
                  window.location.href = "/login";
                } catch {
                  alert("Network error. Please try again.");
                  setDeletingAccount(false);
                }
              }}
              disabled={deletingAccount}
              className="inline-flex items-center gap-2 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-2.5 text-xs font-semibold text-red-400 transition-all hover:bg-red-500/20 hover:border-red-500/60 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {deletingAccount ? (
                <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Deleting…</>
              ) : (
                <><Trash2 className="h-3.5 w-3.5" /> Delete Account Permanently</>
              )}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
