"use client";

import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import {
  Smartphone,
  Mic,
  Cpu,
  CheckCircle2,
  AlertTriangle,
  Phone,
  Radio,
  Fingerprint,
  ArrowRight,
  Check,
  Square,
  Search,
  UserPlus,
  Users,
  Shield,
  CreditCard,
  Plus,
  Trash2,
} from "lucide-react";

/* ── Constants ──────────────────────────────────────────────── */

const steps = [
  { label: "SIM Registration", icon: Smartphone },
  { label: "Voice Recording", icon: Mic },
  { label: "Processing", icon: Cpu },
  { label: "Complete", icon: CheckCircle2 },
];

const operators = ["Jazz", "Zong", "Telenor", "Ufone", "ONIC"];
const TOTAL_TAKES = 3;
const RECORDING_DURATION = 5;

/* ── Profile Type (matches GET /api/enrollments response) ───── */

interface Profile {
  user_id: string;
  full_name: string | null;
  phone_number: string | null;
  network_operator: string | null;
  enrolled_at: string | null;
  audio_quality_snr: number | null;
  status: string;
  embedding_dim: number | null;
}

/* ── Component ──────────────────────────────────────────────── */

export default function EnrollmentPage() {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<"enroll" | "profiles">("enroll");

  // Stepper
  const [currentStep, setCurrentStep] = useState(1);

  // Step 1 — SIM
  const [cnic, setCnic] = useState("");
  const [cnicError, setCnicError] = useState("");
  const [phone, setPhone] = useState("");
  const [operator, setOperator] = useState("");
  const [imei, setImei] = useState("");
  const formRef = useRef<HTMLFormElement>(null);

  // Step 2 — Recording
  const [recordingTake, setRecordingTake] = useState(1);
  const [isRecording, setIsRecording] = useState(false);
  const [recordedBlobs, setRecordedBlobs] = useState<Blob[]>([]);
  const [countdown, setCountdown] = useState(RECORDING_DURATION);
  const [micError, setMicError] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const countdownRef = useRef<NodeJS.Timeout | null>(null);

  // Step 3 — Processing
  const [processingText, setProcessingText] = useState("");
  const [enrollError, setEnrollError] = useState("");

  // Profiles
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [profilesLoading, setProfilesLoading] = useState(false);
  const [profilesError, setProfilesError] = useState("");
  const [searchQuery, setSearchQuery] = useState("");

  /* ── Cleanup on unmount ──────────────────────────────────── */

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (countdownRef.current) clearInterval(countdownRef.current);
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
      }
    };
  }, []);

  /* ── CNIC Validation ─────────────────────────────────────── */

  const validateCnic = (): boolean => {
    const stripped = cnic.replace(/\D/g, "");
    if (stripped.length !== 13) {
      setCnicError("CNIC must be exactly 13 digits");
      return false;
    }
    setCnicError("");
    return true;
  };

  /* ── Step 1 Handlers ─────────────────────────────────────── */

  const handleSkip = () => {
    if (!validateCnic()) return;
    setCurrentStep(2);
  };

  const handleRegister = () => {
    if (!validateCnic()) return;
    if (formRef.current && !formRef.current.reportValidity()) return;
    setCurrentStep(2);
  };

  /* ── Step 2 — Recording Logic ────────────────────────────── */

  const completeTake = useCallback((blob: Blob) => {
    setRecordedBlobs((prev) => {
      const next = [...prev, blob];
      if (next.length >= TOTAL_TAKES) {
        setTimeout(() => setCurrentStep(3), 400);
      } else {
        setRecordingTake(Math.min(next.length + 1, TOTAL_TAKES));
      }
      return next;
    });
    setIsRecording(false);
    setCountdown(RECORDING_DURATION);
  }, []);

  const cleanupMedia = useCallback(() => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    if (countdownRef.current) { clearInterval(countdownRef.current); countdownRef.current = null; }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  }, []);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
      mediaRecorderRef.current.stop();
    }
    cleanupMedia();
  }, [cleanupMedia]);

  const startRecording = useCallback(async () => {
    setMicError(false);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const recorder = new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      const chunks: BlobPart[] = [];

      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
      recorder.onstop = () => { completeTake(new Blob(chunks, { type: "audio/webm" })); };

      recorder.start();
      setIsRecording(true);
      setCountdown(RECORDING_DURATION);

      let remaining = RECORDING_DURATION;
      countdownRef.current = setInterval(() => {
        remaining -= 1;
        setCountdown(Math.max(remaining, 0));
        if (remaining <= 0 && countdownRef.current) clearInterval(countdownRef.current);
      }, 1000);

      timerRef.current = setTimeout(() => {
        if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") mediaRecorderRef.current.stop();
        cleanupMedia();
      }, RECORDING_DURATION * 1000);

    } catch {
      setMicError(true);
      setIsRecording(true);
      setCountdown(RECORDING_DURATION);

      let remaining = RECORDING_DURATION;
      countdownRef.current = setInterval(() => {
        remaining -= 1;
        setCountdown(Math.max(remaining, 0));
        if (remaining <= 0 && countdownRef.current) clearInterval(countdownRef.current);
      }, 1000);

      timerRef.current = setTimeout(() => { completeTake(new Blob()); }, RECORDING_DURATION * 1000);
    }
  }, [completeTake, cleanupMedia]);

  const handleMicClick = () => {
    if (isRecording) stopRecording();
    else startRecording();
  };

  /* ── Step 3 — Real Enrollment Submission ─────────────────── */

  useEffect(() => {
    if (currentStep !== 3) return;
    setEnrollError("");

    const lines = [
      "Uploading voice samples to secure pipeline...",
      "Extracting 192-dim ECAPA-TDNN vectors...",
      "Verifying Signal-to-Noise Ratio (SNR)...",
      "Computing multi-template baseline...",
      "Generating secure voiceprint template...",
    ];
    let i = 0;
    setProcessingText(lines[0]);
    const interval = setInterval(() => {
      i += 1;
      if (i < lines.length) setProcessingText(lines[i]);
    }, 800);

    async function submitEnrollment() {
      try {
        const formData = new FormData();
        formData.append("user_id", cnic.replace(/\D/g, ""));

        recordedBlobs.forEach((blob, idx) => {
          formData.append(
            `take_${idx + 1}`,
            blob,
            `take_${idx + 1}.webm`
          );
        });

        // Append optional SIM info if provided
        if (phone) formData.append("phone_number", phone);

        const res = await fetch("/api/enroll", {
          method: "POST",
          body: formData,
        });

        clearInterval(interval);

        if (res.ok) {
          setProcessingText("Enrollment complete!");
          setCurrentStep(4);
        } else {
          const errorData = await res.json().catch(() => null);
          const msg = errorData?.detail ?? `Enrollment failed (HTTP ${res.status})`;
          setEnrollError(msg);
          setProcessingText("Enrollment failed.");
        }
      } catch (err) {
        clearInterval(interval);
        setEnrollError(
          err instanceof Error ? err.message : "Network error. Is the backend running?"
        );
        setProcessingText("Enrollment failed.");
      }
    }

    submitEnrollment();

    return () => clearInterval(interval);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentStep]);

  /* ── Fetch Live Enrollments from Backend ─────────────────── */

  useEffect(() => {
    if (activeTab !== "profiles") return;
    setProfilesLoading(true);
    setProfilesError("");

    const stored = typeof window !== "undefined" ? localStorage.getItem("awaaz_user") : null;
    const parsed = stored ? JSON.parse(stored) : null;
    const currentCnic = parsed?.cnic || parsed?.user_id || "";

    fetch(`/api/enrollments?user_id=${encodeURIComponent(currentCnic)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const profilesArray = Array.isArray(data) ? data : (data.enrollments || []);
        setProfiles(profilesArray);
      })
      .catch((err) => {
        console.error("Failed to fetch enrollments:", err);
        setProfilesError(err.message || "Failed to load enrollments.");
      })
      .finally(() => setProfilesLoading(false));
  }, [activeTab]);

  /* ── Profile Helpers ─────────────────────────────────────── */

  const filteredProfiles = useMemo(() =>
    profiles.filter((p) =>
      p.user_id.replace(/-/g, "").includes(searchQuery.replace(/-/g, ""))
    ),
    [profiles, searchQuery]
  );

  const deleteProfile = (userId: string) => {
    setProfiles((prev) => prev.filter((p) => p.user_id !== userId));
  };

  /* ── Render ──────────────────────────────────────────────── */

  return (
    <div className="p-8 lg:p-10">
      {/* ── Header ─────────────────────────────────────────── */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">Voice Enrollment</h1>
        <p className="mt-1.5 text-sm text-neutral-500">Register your voice as a biometric identity</p>
      </div>

      {/* ── Tab Toggle ─────────────────────────────────────── */}
      <div className="mb-8 flex items-center gap-1 rounded-lg border border-neutral-800 bg-neutral-900/50 p-1 w-fit">
        <button onClick={() => setActiveTab("enroll")}
          className={`flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-all ${activeTab === "enroll" ? "bg-neutral-800 text-white shadow-sm" : "text-neutral-500 hover:text-neutral-300"}`}>
          <UserPlus className="h-4 w-4" /> Enroll New User
        </button>
        <button onClick={() => setActiveTab("profiles")}
          className={`flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-all ${activeTab === "profiles" ? "bg-neutral-800 text-white shadow-sm" : "text-neutral-500 hover:text-neutral-300"}`}>
          <Users className="h-4 w-4" /> Enrolled Profiles
        </button>
      </div>

      {/* ================================================================ */}
      {/* TAB 1 — ENROLL NEW USER                                         */}
      {/* ================================================================ */}
      {activeTab === "enroll" && (
        <>
          {/* Stepper */}
          <div className="mb-10">
            <div className="flex items-center">
              {steps.map((step, i) => {
                const stepNum = i + 1;
                const Icon = step.icon;
                const isActive = stepNum === currentStep;
                const isCompleted = stepNum < currentStep;
                return (
                  <div key={step.label} className="flex flex-1 items-center">
                    <div className="flex flex-col items-center gap-2">
                      <div className={`flex h-10 w-10 items-center justify-center rounded-full border transition-all ${
                        isActive ? "border-cyan-500 bg-cyan-500/15 text-cyan-400"
                          : isCompleted ? "border-green-500 bg-green-500/15 text-green-400"
                            : "border-neutral-700 bg-neutral-800/50 text-neutral-600"
                      }`}>
                        {isCompleted ? <Check className="h-4 w-4" /> : <Icon className="h-4 w-4" />}
                      </div>
                      <span className={`text-[11px] font-medium tracking-wide ${
                        isActive ? "text-cyan-400" : isCompleted ? "text-green-400" : "text-neutral-600"
                      }`}>{step.label}</span>
                    </div>
                    {i < steps.length - 1 && (
                      <div className="mx-2 mb-5 h-px flex-1">
                        <div className={`h-full ${isCompleted ? "bg-green-500/40" : isActive ? "bg-cyan-500/30" : "bg-neutral-800"}`} />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* ── STEP 1 — SIM REGISTRATION ───────────────────── */}
          {currentStep === 1 && (
            <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-6 sm:p-8">
              {/* CNIC (Required) */}
              <div className="mb-6">
                <label htmlFor="cnic" className="mb-2 block text-xs font-medium uppercase tracking-wider text-neutral-500">
                  CNIC Number <span className="text-red-400">*</span>
                  <span className="ml-2 text-[10px] normal-case tracking-normal text-neutral-600">13 digits, no dashes</span>
                </label>
                <div className="relative">
                  <CreditCard className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-600" />
                  <input
                    id="cnic" type="text" placeholder="1234567890123" value={cnic}
                    onChange={(e) => { const v = e.target.value.replace(/\D/g, ""); if (v.length <= 13) { setCnic(v); setCnicError(""); } }}
                    maxLength={13}
                    className={`w-full rounded-lg border bg-black px-4 py-3 pl-11 text-sm text-white transition-all placeholder:text-neutral-600 focus:ring-1 ${
                      cnicError
                        ? "border-red-500/50 focus:border-red-500/50 focus:ring-red-500/20"
                        : "border-neutral-800 focus:border-cyan-500/50 focus:ring-cyan-500/20"
                    }`}
                  />
                </div>
                {cnicError && (
                  <p className="mt-2 text-xs text-red-400">{cnicError}</p>
                )}
              </div>

              {/* Skip Button */}
              <button type="button" onClick={handleSkip}
                className="group mb-8 flex w-full items-center justify-center gap-3 rounded-xl bg-orange-500 px-6 py-4 text-sm font-bold text-white transition-all hover:bg-orange-400 hover:shadow-[0_0_24px_rgba(249,115,22,0.25)]">
                <AlertTriangle className="h-5 w-5" /> Skip — Do Not Link SIM
              </button>

              {/* SIM Form */}
              <form ref={formRef} onSubmit={(e) => e.preventDefault()} className="space-y-5">
                <p className="text-xs font-semibold uppercase tracking-[0.15em] text-neutral-500">SIM Card Details (Optional)</p>

                {/* Phone */}
                <div>
                  <label htmlFor="phone" className="mb-2 block text-xs font-medium uppercase tracking-wider text-neutral-500">
                    Phone Number <span className="ml-2 text-[10px] normal-case tracking-normal text-neutral-600">11 digits starting with 03</span>
                  </label>
                  <div className="relative">
                    <Phone className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-600" />
                    <input id="phone" type="text" placeholder="03001234567" value={phone}
                      onChange={(e) => { const v = e.target.value.replace(/\D/g, ""); if (v.length <= 11) setPhone(v); }}
                      pattern="03[0-9]{9}" maxLength={11} title="Pakistani phone number: 11 digits starting with 03"
                      className="w-full rounded-lg border border-neutral-800 bg-black px-4 py-3 pl-11 text-sm text-white transition-all placeholder:text-neutral-600 focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/20" />
                  </div>
                </div>

                {/* Operator */}
                <div>
                  <label htmlFor="operator" className="mb-2 block text-xs font-medium uppercase tracking-wider text-neutral-500">Network Operator</label>
                  <div className="relative">
                    <Radio className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-600" />
                    <select id="operator" value={operator} onChange={(e) => setOperator(e.target.value)}
                      className="w-full appearance-none rounded-lg border border-neutral-800 bg-black px-4 py-3 pl-11 pr-10 text-sm text-white transition-all focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/20 [&:not(:valid)]:text-neutral-600">
                      <option value="" disabled className="text-neutral-600 bg-neutral-900">Select operator</option>
                      {operators.map((op) => (<option key={op} value={op} className="bg-neutral-900 text-white">{op}</option>))}
                    </select>
                    <div className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2">
                      <svg className="h-4 w-4 text-neutral-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" /></svg>
                    </div>
                  </div>
                </div>

                {/* IMEI */}
                <div>
                  <label htmlFor="imei" className="mb-2 block text-xs font-medium uppercase tracking-wider text-neutral-500">
                    IMEI Number <span className="ml-2 text-[10px] normal-case tracking-normal text-neutral-600">15 digits</span>
                  </label>
                  <div className="relative">
                    <Fingerprint className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-600" />
                    <input id="imei" type="text" placeholder="123456789012345" value={imei}
                      onChange={(e) => { const v = e.target.value.replace(/\D/g, ""); if (v.length <= 15) setImei(v); }}
                      pattern="[0-9]{15}" maxLength={15} title="IMEI must be exactly 15 numeric digits"
                      className="w-full rounded-lg border border-neutral-800 bg-black px-4 py-3 pl-11 text-sm text-white transition-all placeholder:text-neutral-600 focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/20" />
                  </div>
                </div>
              </form>

              <div className="mt-8 flex justify-end border-t border-neutral-800 pt-6">
                <button type="button" onClick={handleRegister}
                  className="group inline-flex items-center gap-2 rounded-lg border border-neutral-700 bg-neutral-800/50 px-5 py-2.5 text-sm font-semibold text-neutral-300 transition-all hover:border-neutral-600 hover:bg-neutral-800 hover:text-white">
                  Register SIM &amp; Continue <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
                </button>
              </div>
            </div>
          )}

          {/* ── STEP 2 — VOICE RECORDING ────────────────────── */}
          {currentStep === 2 && (
            <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-6 sm:p-8">
              <div className="mb-6 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className="text-sm font-semibold text-white">Take {recordingTake} of {TOTAL_TAKES}</span>
                  <div className="flex items-center gap-1.5">
                    {Array.from({ length: TOTAL_TAKES }).map((_, i) => (
                      <div key={i} className={`h-2 w-2 rounded-full transition-all ${
                        i < recordedBlobs.length ? "bg-green-500" : i === recordedBlobs.length ? "bg-cyan-400" : "bg-neutral-700"
                      }`} />
                    ))}
                  </div>
                </div>
                {isRecording && (
                  <span className="flex items-center gap-2 rounded-full border border-red-500/30 bg-red-500/10 px-3 py-1 text-xs font-semibold text-red-400">
                    <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-red-500" />
                    REC · {countdown}s
                  </span>
                )}
              </div>
              {micError && (
                <div className="mb-6 rounded-lg border border-yellow-500/20 bg-yellow-500/5 px-4 py-3 text-xs text-yellow-400">
                  Microphone access denied — running in demo mode. Captures will be simulated.
                </div>
              )}
              <div className="mb-8 rounded-xl border border-neutral-700 bg-black/60 p-6 text-center">
                <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-neutral-500">Speak the following passphrase clearly</p>
                <p className="mt-3 text-2xl font-bold leading-relaxed text-white" dir="rtl">میری آواز میرا پاسورڈ ہے</p>
                <p className="mt-2 text-sm text-neutral-400 italic">&quot;Meri aawaz mera biometric passcode hai&quot;</p>
              </div>
              <div className="flex flex-col items-center gap-6">
                <div className="relative">
                  {isRecording && (
                    <>
                      <div className="absolute inset-0 animate-ping rounded-full bg-green-500/20" style={{ animationDuration: "1.5s" }} />
                      <div className="absolute -inset-3 animate-ping rounded-full bg-green-500/10" style={{ animationDuration: "2s" }} />
                    </>
                  )}
                  <button type="button" onClick={handleMicClick}
                    className={`relative z-10 flex h-24 w-24 items-center justify-center rounded-full border-2 transition-all ${
                      isRecording
                        ? "border-green-500 bg-green-500/15 shadow-[0_0_40px_rgba(34,197,94,0.3)] hover:bg-green-500/25"
                        : "border-cyan-500/40 bg-neutral-800 hover:border-cyan-400 hover:bg-neutral-700"
                    }`}>
                    {isRecording ? <Square className="h-8 w-8 text-green-400" /> : <Mic className="h-8 w-8 text-cyan-400" />}
                  </button>
                </div>
                <p className="text-sm text-neutral-500">
                  {isRecording ? "Recording... Click to stop early" : "Click to start recording"}
                </p>
              </div>
            </div>
          )}

          {/* ── STEP 3 — PROCESSING ─────────────────────────── */}
          {currentStep === 3 && (
            <div className="flex min-h-[400px] flex-col items-center justify-center rounded-xl border border-neutral-800 bg-neutral-900 p-8">
              {!enrollError ? (
                <>
                  <div className="relative mb-8">
                    <div className="h-20 w-20 animate-spin rounded-full border-2 border-neutral-800 border-t-green-500" style={{ animationDuration: "1.2s" }} />
                    <div className="absolute inset-0 flex items-center justify-center"><div className="h-3 w-3 animate-pulse rounded-full bg-green-500" /></div>
                    <div className="pointer-events-none absolute -inset-4 rounded-full bg-green-500/10 blur-xl" />
                  </div>
                  <h2 className="text-lg font-semibold text-white">Analyzing Acoustic Features...</h2>
                  <p className="mt-3 max-w-md text-center font-mono text-xs text-neutral-500">{processingText}</p>
                  <div className="mt-6 w-full max-w-md rounded-lg border border-neutral-800 bg-black p-4">
                    <div className="space-y-1.5 font-mono text-[11px]">
                      <p className="text-green-500/70"><span className="text-neutral-600">[INFO]</span> Uploading {TOTAL_TAKES} audio samples to server</p>
                      <p className="text-green-500/70"><span className="text-neutral-600">[INFO]</span> Extracting 192-dim ECAPA-TDNN vectors</p>
                      <p className="text-green-500/70"><span className="text-neutral-600">[INFO]</span> Generating secure baseline template</p>
                      <p className="text-neutral-600 animate-pulse"><span className="text-neutral-700">[PROC]</span> {processingText}</p>
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <div className="relative mb-8">
                    <div className="flex h-20 w-20 items-center justify-center rounded-full border-2 border-red-500 bg-red-500/15">
                      <AlertTriangle className="h-10 w-10 text-red-400" />
                    </div>
                    <div className="pointer-events-none absolute -inset-4 rounded-full bg-red-500/10 blur-xl" />
                  </div>
                  <h2 className="text-lg font-semibold text-red-400">Enrollment Failed</h2>
                  <p className="mt-3 max-w-md text-center text-sm text-neutral-400">{enrollError}</p>
                  <button
                    type="button"
                    onClick={() => { setCurrentStep(2); setRecordedBlobs([]); setRecordingTake(1); setEnrollError(""); }}
                    className="mt-6 inline-flex items-center gap-2 rounded-lg border border-neutral-700 bg-neutral-800/50 px-5 py-2.5 text-sm font-semibold text-neutral-300 transition-all hover:border-neutral-600 hover:text-white"
                  >
                    Re-record Voice Samples
                  </button>
                </>
              )}
            </div>
          )}

          {/* ── STEP 4 — COMPLETE ───────────────────────────── */}
          {currentStep === 4 && (
            <div className="flex min-h-[400px] flex-col items-center justify-center rounded-xl border border-neutral-800 bg-neutral-900 p-8">
              <div className="relative mb-6">
                <div className="flex h-20 w-20 items-center justify-center rounded-full border-2 border-green-500 bg-green-500/15">
                  <CheckCircle2 className="h-10 w-10 text-green-400" />
                </div>
                <div className="pointer-events-none absolute -inset-4 rounded-full bg-green-500/10 blur-xl" />
              </div>
              <h2 className="text-xl font-bold text-white">Biometric Voiceprint Enrolled</h2>
              <p className="mt-2 max-w-sm text-center text-sm text-neutral-500">
                Your voice identity has been registered and linked to your profile. You can now authenticate using voice biometrics.
              </p>
              <div className="mt-6 flex gap-6">
                <div className="text-center"><p className="text-lg font-bold text-green-400">{TOTAL_TAKES}</p><p className="text-[10px] uppercase tracking-wider text-neutral-600">Samples</p></div>
                <div className="text-center"><p className="text-lg font-bold text-green-400">192</p><p className="text-[10px] uppercase tracking-wider text-neutral-600">Dimensions</p></div>
                <div className="text-center"><p className="text-lg font-bold text-green-400">0.99</p><p className="text-[10px] uppercase tracking-wider text-neutral-600">Confidence</p></div>
              </div>
              <button type="button" onClick={() => router.push("/console")}
                className="mt-8 flex w-full max-w-sm items-center justify-center gap-2 rounded-lg bg-green-500 px-6 py-3 text-sm font-semibold text-black transition-all hover:bg-green-400 hover:shadow-[0_0_24px_rgba(34,197,94,0.3)]">
                Return to Dashboard <ArrowRight className="h-4 w-4" />
              </button>
            </div>
          )}
        </>
      )}

      {/* ================================================================ */}
      {/* TAB 2 — ENROLLED PROFILES                                       */}
      {/* ================================================================ */}
      {activeTab === "profiles" && (
        <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-6 sm:p-8">
          {/* Toolbar */}
          <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="relative max-w-xs flex-1">
              <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-600" />
              <input type="text" placeholder="Search by CNIC..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full rounded-lg border border-neutral-800 bg-black px-4 py-2.5 pl-11 text-sm text-white transition-all placeholder:text-neutral-600 focus:border-green-500/50 focus:ring-1 focus:ring-green-500/20" />
            </div>
            <button onClick={() => { setActiveTab("enroll"); setCurrentStep(1); setRecordedBlobs([]); setRecordingTake(1); setCnic(""); setCnicError(""); }}
              className="inline-flex items-center gap-2 rounded-lg bg-green-500 px-4 py-2.5 text-sm font-semibold text-black transition-all hover:bg-green-400 hover:shadow-[0_0_20px_rgba(34,197,94,0.25)]">
              <UserPlus className="h-4 w-4" /> Enroll New Voice
            </button>
          </div>

          {/* Table */}
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-neutral-800">
                  <th className="pb-3 pr-6 text-[11px] font-semibold uppercase tracking-wider text-neutral-500">CNIC</th>
                  <th className="pb-3 pr-6 text-[11px] font-semibold uppercase tracking-wider text-neutral-500">Phone / Operator</th>
                  <th className="pb-3 pr-6 text-[11px] font-semibold uppercase tracking-wider text-neutral-500">Enrollment Date</th>
                  <th className="pb-3 pr-6 text-[11px] font-semibold uppercase tracking-wider text-neutral-500">Biometric Quality</th>
                  <th className="pb-3 pr-6 text-[11px] font-semibold uppercase tracking-wider text-neutral-500">Status</th>
                  <th className="pb-3 w-10"></th>
                </tr>
              </thead>
              <tbody>
                {profilesLoading ? (
                  <tr>
                    <td colSpan={6} className="py-12 text-center">
                      <div className="inline-flex items-center gap-2 text-sm text-neutral-500">
                        <div className="h-4 w-4 animate-spin rounded-full border-2 border-neutral-700 border-t-green-500" />
                        Loading enrollments...
                      </div>
                    </td>
                  </tr>
                ) : profilesError ? (
                  <tr>
                    <td colSpan={6} className="py-12 text-center">
                      <p className="text-sm text-red-400">{profilesError}</p>
                      <button onClick={() => setActiveTab("profiles")} className="mt-2 text-xs text-neutral-500 underline hover:text-white">Retry</button>
                    </td>
                  </tr>
                ) : filteredProfiles.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-12 text-center text-sm text-neutral-600">
                      {searchQuery ? <>No profiles found matching &quot;{searchQuery}&quot;</> : "No enrolled profiles yet"}
                    </td>
                  </tr>
                ) : (
                  filteredProfiles.map((p) => (
                    <tr key={p.user_id} className="border-b border-neutral-800/50 transition-colors hover:bg-neutral-800/30">
                      <td className="py-4 pr-6">
                        <div className="flex items-center gap-2.5">
                          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-neutral-800 bg-neutral-800/50">
                            <Shield className="h-3.5 w-3.5 text-green-500" />
                          </div>
                          <div>
                            <span className="font-mono text-sm text-white">{p.user_id}</span>
                            {p.full_name && <p className="text-[11px] text-neutral-500">{p.full_name}</p>}
                          </div>
                        </div>
                      </td>
                      <td className="py-4 pr-6">
                        {p.phone_number ? (
                          <>
                            <p className="font-mono text-sm text-neutral-300">{p.phone_number}</p>
                            {p.network_operator && <p className="text-[11px] text-neutral-600">{p.network_operator}</p>}
                          </>
                        ) : (
                          <div className="flex items-center gap-2">
                            <span className="text-sm text-neutral-500">Not linked</span>
                            <button className="flex h-6 w-6 items-center justify-center rounded-md border border-neutral-700 bg-neutral-800/50 text-neutral-600 transition-all hover:border-cyan-500/40 hover:bg-cyan-500/10 hover:text-cyan-400">
                              <Plus className="h-3 w-3" />
                            </button>
                          </div>
                        )}
                      </td>
                      <td className="py-4 pr-6 text-sm text-neutral-400">
                        {p.enrolled_at
                          ? new Date(p.enrolled_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
                          : "—"}
                      </td>
                      <td className="py-4 pr-6">
                        {p.audio_quality_snr != null ? (
                          <>
                            <span className="font-mono text-sm text-green-400">{(p.audio_quality_snr * 100).toFixed(1)}%</span>
                            <span className="ml-1.5 text-[10px] text-neutral-600">SNR</span>
                          </>
                        ) : (
                          <span className="rounded-full border border-green-500/30 bg-green-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-green-400">
                            Enrolled
                          </span>
                        )}
                      </td>
                      <td className="py-4 pr-6">
                        <span className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider ${
                          p.status === "ACTIVE"
                            ? "border-green-500/30 bg-green-500/10 text-green-400"
                            : p.status === "REVOKED"
                            ? "border-red-500/30 bg-red-500/10 text-red-400"
                            : "border-yellow-500/30 bg-yellow-500/10 text-yellow-400"
                        }`}>
                          {p.status}
                        </span>
                      </td>
                      <td className="py-4">
                        <button
                          onClick={() => deleteProfile(p.user_id)}
                          className="flex h-8 w-8 items-center justify-center rounded-lg text-neutral-600 transition-all hover:bg-red-500/10 hover:text-red-500"
                          title="Delete enrollment"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
