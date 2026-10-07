"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { Noto_Nastaliq_Urdu } from "next/font/google";
import {
  Fingerprint,
  Lock,
  ShieldCheck,
  ArrowRight,
  RotateCcw,
  User,
  Mic,
  MicOff,
  Loader2,
  Radio,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Activity,
  AudioLines,
  ScanFace,
} from "lucide-react";

/* ── Types ─────────────────────────────────────────────────── */

type PageState =
  | "idle"        // CNIC input
  | "locked"      // Target confirmed, ready to initiate challenge
  | "challenge"   // Challenge digits fetched, waiting for recording
  | "recording"   // Mic active, capturing audio
  | "recorded"    // Blob captured, ready for verify submission
  | "verifying"   // POST in-flight, ML models processing
  | "verified";   // Final scorecard

interface ChallengeResponse {
  session_id: string;
  challenge: number[];
  sim_swap_warning: boolean;
}

interface VerifyResponse {
  authenticated: boolean;
  similarity_score: number;   // ECAPA-TDNN voice match (UX-scaled 0–1)
  liveness_score: number;     // Whisper ASR liveness confidence (0–1)
  gatekeeper_score: number;   // Pyannote diarization check (0 or 1)
  risk_score: number;         // Composite risk factor
  session_id: string;
  message: string;            // Denial reason or "Identity Verified."
}

/* ── Constants ─────────────────────────────────────────────── */

const API = "/api";

const nastaliq = Noto_Nastaliq_Urdu({ subsets: ["arabic"], weight: ["400", "700"] });

const DIGIT_WORDS: Record<number, string> = {
  0: "Zero", 1: "One", 2: "Two", 3: "Three", 4: "Four",
  5: "Five", 6: "Six", 7: "Seven", 8: "Eight", 9: "Nine",
};

const URDU_NUMERALS: Record<number, string> = {
  0: "۰", 1: "۱", 2: "۲", 3: "۳", 4: "۴",
  5: "۵", 6: "۶", 7: "۷", 8: "۸", 9: "۹",
};

const URDU_WORDS: Record<number, string> = {
  0: "صفر", 1: "ایک", 2: "دو", 3: "تین", 4: "چار",
  5: "پانچ", 6: "چھ", 7: "سات", 8: "آٹھ", 9: "نو",
};

/* ── Loading pipeline steps ────────────────────────────────── */

const PIPELINE_STEPS = [
  "Uploading audio payload…",
  "Running Pyannote Diarization — Gatekeeper check…",
  "Transcribing with Whisper ASR — Liveness validation…",
  "Extracting ECAPA-TDNN embedding — Voice comparison…",
  "Computing final verdict…",
];

/* ── Component ─────────────────────────────────────────────── */

export default function AuthenticatePage() {
  /* ── Core State ──────────────────────────────────────────── */
  const [state, setState] = useState<PageState>("idle");
  const [cnic, setCnic] = useState("");
  const [cnicError, setCnicError] = useState("");
  const [lockedCnic, setLockedCnic] = useState("");
  const [lockInLoading, setLockInLoading] = useState(false);

  /* ── Challenge State ─────────────────────────────────────── */
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [challengeDigits, setChallengeDigits] = useState<number[]>([]);
  const [challengeLoading, setChallengeLoading] = useState(false);
  const [challengeError, setChallengeError] = useState("");

  /* ── Recording State ─────────────────────────────────────── */
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [micError, setMicError] = useState("");

  /* ── Verify State ────────────────────────────────────────── */
  const [verifyResult, setVerifyResult] = useState<VerifyResponse | null>(null);
  const [verifyError, setVerifyError] = useState("");
  const [pipelineStep, setPipelineStep] = useState(0);

  /* ── Refs ─────────────────────────────────────────────────── */
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const pipelineTimerRef = useRef<NodeJS.Timeout | null>(null);

  /* ── Format CNIC: 1234567890123 → 12345-6789012-3 ──────── */
  const formatCnic = (raw: string): string => {
    const digits = raw.replace(/\D/g, "");
    if (digits.length <= 5) return digits;
    if (digits.length <= 12) return `${digits.slice(0, 5)}-${digits.slice(5)}`;
    return `${digits.slice(0, 5)}-${digits.slice(5, 12)}-${digits.slice(12, 13)}`;
  };

  /* ── Cleanup helpers ─────────────────────────────────────── */
  const stopStream = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  }, []);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const clearPipelineTimer = useCallback(() => {
    if (pipelineTimerRef.current) {
      clearInterval(pipelineTimerRef.current);
      pipelineTimerRef.current = null;
    }
  }, []);

  /* ── CNIC Input Handler ──────────────────────────────────── */
  const handleCnicChange = useCallback((value: string) => {
    const digits = value.replace(/\D/g, "").slice(0, 13);
    setCnic(digits);
    setCnicError("");
  }, []);

  /* ── Lock In Target (with server-side enrollment check) ─── */
  const handleLockIn = useCallback(async () => {
    const digits = cnic.replace(/\D/g, "");
    if (digits.length !== 13) {
      setCnicError("CNIC must be exactly 13 digits.");
      return;
    }

    setLockInLoading(true);
    setCnicError("");

    try {
      const res = await fetch(`${API}/enroll/check/${digits}`);
      if (!res.ok) {
        throw new Error(`Enrollment check failed (${res.status})`);
      }
      const data = await res.json();

      if (!data.enrolled) {
        setCnicError(
          "No voice profile found for this CNIC. Please enroll the customer first."
        );
        setLockInLoading(false);
        return;
      }

      // Enrollment confirmed — proceed
      setLockedCnic(digits);
      setState("locked");
    } catch (err) {
      setCnicError(
        (err as Error).message || "Failed to verify enrollment. Please try again."
      );
    } finally {
      setLockInLoading(false);
    }
  }, [cnic]);

  /* ── Initiate Challenge (API Call) ───────────────────────── */
  const handleInitiateChallenge = useCallback(async () => {
    setChallengeLoading(true);
    setChallengeError("");

    try {
      const res = await fetch(`${API}/authenticate/challenge`, { method: "POST" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || `Challenge fetch failed (${res.status})`);
      }

      const data: ChallengeResponse = await res.json();
      setSessionId(data.session_id);
      setChallengeDigits(data.challenge);
      setState("challenge");
    } catch (err) {
      setChallengeError((err as Error).message);
    } finally {
      setChallengeLoading(false);
    }
  }, []);

  /* ── Start Recording ─────────────────────────────────────── */
  const handleStartRecording = useCallback(async () => {
    setMicError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      audioChunksRef.current = [];

      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";

      const recorder = new MediaRecorder(stream, { mimeType });

      recorder.ondataavailable = (e: BlobEvent) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      mediaRecorderRef.current = recorder;
      recorder.start();
      setState("recording");
      setRecordingSeconds(0);

      // Start elapsed timer
      timerRef.current = setInterval(() => {
        setRecordingSeconds((prev) => prev + 1);
      }, 1000);
    } catch (err) {
      setMicError(
        (err as Error).message.includes("Permission")
          ? "Microphone access denied. Please allow mic permissions."
          : `Microphone error: ${(err as Error).message}`
      );
    }
  }, []);

  /* ── Stop Recording ──────────────────────────────────────── */
  const handleStopRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === "inactive") return;

    recorder.onstop = () => {
      const blob = new Blob(audioChunksRef.current, { type: recorder.mimeType });
      audioChunksRef.current = [];
      setAudioBlob(blob);
      setState("recorded");
      stopStream();
      clearTimer();
    };

    recorder.stop();
  }, [stopStream, clearTimer]);

  /* ── Verify Identity (POST to backend) ───────────────────── */
  const handleVerify = useCallback(async () => {
    if (!audioBlob || !sessionId) return;

    setState("verifying");
    setVerifyError("");
    setPipelineStep(0);

    // Animate through pipeline steps
    let step = 0;
    pipelineTimerRef.current = setInterval(() => {
      step += 1;
      if (step < PIPELINE_STEPS.length) {
        setPipelineStep(step);
      }
    }, 2200);

    try {
      const formData = new FormData();
      formData.append("session_id", sessionId);
      formData.append("user_id", lockedCnic);
      formData.append("voice", audioBlob, "audio.webm");

      const res = await fetch(`${API}/authenticate/verify`, {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || `Verification failed (${res.status})`);
      }

      const data: VerifyResponse = await res.json();
      clearPipelineTimer();
      setVerifyResult(data);
      setState("verified");
    } catch (err) {
      clearPipelineTimer();
      setVerifyError((err as Error).message);
      setState("recorded"); // Fall back so user can retry
    }
  }, [audioBlob, sessionId, lockedCnic, clearPipelineTimer]);

  /* ── Full Reset ──────────────────────────────────────────── */
  const handleReset = useCallback(() => {
    stopStream();
    clearTimer();
    clearPipelineTimer();
    setState("idle");
    setCnic("");
    setLockedCnic("");
    setCnicError("");
    setSessionId(null);
    setChallengeDigits([]);
    setChallengeLoading(false);
    setChallengeError("");
    setRecordingSeconds(0);
    setAudioBlob(null);
    setMicError("");
    setVerifyResult(null);
    setVerifyError("");
    setPipelineStep(0);
    setLockInLoading(false);
  }, [stopStream, clearTimer, clearPipelineTimer]);

  /* ── Cleanup on unmount ──────────────────────────────────── */
  useEffect(() => {
    return () => {
      stopStream();
      clearTimer();
      clearPipelineTimer();
    };
  }, [stopStream, clearTimer, clearPipelineTimer]);

  /* ── Derived ─────────────────────────────────────────────── */
  const isValid = cnic.replace(/\D/g, "").length === 13;
  const formattedTime = `${Math.floor(recordingSeconds / 60)
    .toString()
    .padStart(2, "0")}:${(recordingSeconds % 60).toString().padStart(2, "0")}`;

  /* ── Header Badge ────────────────────────────────────────── */
  const badgeConfig: Record<PageState, { label: string; classes: string }> = {
    idle:      { label: "Awaiting Target",  classes: "border-neutral-700 bg-neutral-800/50 text-neutral-500" },
    locked:    { label: "Target Locked",    classes: "border-green-500/40 bg-green-500/10 text-green-500" },
    challenge: { label: "Challenge Active", classes: "border-cyan-500/40 bg-cyan-500/10 text-cyan-400" },
    recording: { label: "Recording",        classes: "border-red-500/40 bg-red-500/10 text-red-400" },
    recorded:  { label: "Ready to Verify",  classes: "border-amber-500/40 bg-amber-500/10 text-amber-400" },
    verifying: { label: "Processing",       classes: "border-violet-500/40 bg-violet-500/10 text-violet-400" },
    verified:  {
      label: verifyResult?.authenticated ? "Authenticated" : "Denied",
      classes: verifyResult?.authenticated
        ? "border-green-500/40 bg-green-500/10 text-green-500"
        : "border-red-500/40 bg-red-500/10 text-red-400",
    },
  };

  const badge = badgeConfig[state];

  return (
    <div className="p-8 lg:p-10">
      {/* ── Header ───────────────────────────────────────────── */}
      <div className="mb-8">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold text-white">Authenticate</h1>
          <span
            className={`rounded-full border px-3 py-0.5 text-[11px] font-semibold uppercase tracking-wider transition-colors ${badge.classes}`}
          >
            {badge.label}
          </span>
        </div>
        <p className="mt-1.5 text-sm text-neutral-500">
          {state === "idle"
            ? "Lock in a customer CNIC to begin voice biometric challenge."
            : `Target: ${formatCnic(lockedCnic)}`}
        </p>
      </div>

      {/* ── Main Card ────────────────────────────────────────── */}
      <div className={`mx-auto ${state === "verified" ? "max-w-2xl" : "max-w-xl"}`}>
        <div className="rounded-2xl border border-neutral-800 bg-neutral-900 overflow-hidden">
          {/* Card Header */}
          <div className="flex items-center gap-3 border-b border-neutral-800/60 px-6 py-4">
            <div
              className={`flex h-9 w-9 items-center justify-center rounded-lg border transition-colors ${
                state === "idle"
                  ? "border-neutral-800 bg-neutral-800/50"
                  : state === "recording"
                  ? "border-red-500/30 bg-red-500/10"
                  : state === "verifying"
                  ? "border-violet-500/30 bg-violet-500/10"
                  : state === "verified" && !verifyResult?.authenticated
                  ? "border-red-500/30 bg-red-500/10"
                  : "border-green-500/30 bg-green-500/10"
              }`}
            >
              {state === "recording" ? (
                <Radio className="h-4 w-4 text-red-400 animate-pulse" />
              ) : state === "verifying" ? (
                <Loader2 className="h-4 w-4 text-violet-400 animate-spin" />
              ) : state === "idle" ? (
                <Fingerprint className="h-4 w-4 text-neutral-500" />
              ) : state === "verified" && !verifyResult?.authenticated ? (
                <XCircle className="h-4 w-4 text-red-400" />
              ) : (
                <ShieldCheck className="h-4 w-4 text-green-400" />
              )}
            </div>
            <div>
              <p className="text-sm font-semibold text-white">
                {state === "idle" && "Target Customer Lookup"}
                {state === "locked" && "Target Confirmed"}
                {state === "challenge" && "Voice Challenge"}
                {state === "recording" && "Recording in Progress"}
                {state === "recorded" && "Audio Captured"}
                {state === "verifying" && "Processing Biometrics"}
                {state === "verified" && (verifyResult?.authenticated ? "Verification Complete" : "Verification Failed")}
              </p>
              <p className="text-xs text-neutral-500">
                {state === "idle" && "Enter the customer's 13-digit CNIC to proceed"}
                {state === "locked" && "Initiate a voice biometric challenge"}
                {state === "challenge" && "Ask the customer to read the digits aloud"}
                {state === "recording" && "Capturing microphone input…"}
                {state === "recorded" && "Ready to submit for verification"}
                {state === "verifying" && "Running ML pipeline — this may take a moment"}
                {state === "verified" && `Session: ${verifyResult?.session_id?.slice(0, 8)}…`}
              </p>
            </div>
          </div>

          {/* Card Body */}
          <div className="p-6">
            {/* ────────────── IDLE: CNIC Input ────────────────── */}
            {state === "idle" && (
              <div>
                <label
                  htmlFor="target-cnic"
                  className="mb-2 block text-[11px] font-semibold uppercase tracking-[0.15em] text-neutral-500"
                >
                  Target Customer CNIC
                </label>
                <div className="relative">
                  <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-4">
                    <User className="h-4 w-4 text-neutral-600" />
                  </div>
                  <input
                    id="target-cnic"
                    type="text"
                    inputMode="numeric"
                    placeholder="XXXXX-XXXXXXX-X"
                    value={formatCnic(cnic)}
                    onChange={(e) => handleCnicChange(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && isValid) handleLockIn();
                    }}
                    className={`w-full rounded-xl border bg-black/40 py-3.5 pl-11 pr-4 font-mono text-sm text-white placeholder-neutral-700 outline-none transition-all focus:ring-1 ${
                      cnicError
                        ? "border-red-500/50 focus:border-red-500 focus:ring-red-500/30"
                        : "border-neutral-800 focus:border-green-500/50 focus:ring-green-500/20"
                    }`}
                    autoComplete="off"
                  />
                </div>
                {cnicError && (
                  <p className="mt-2 text-xs font-medium text-red-400">{cnicError}</p>
                )}
                <p className="mt-3 text-[11px] text-neutral-600">
                  13-digit National Identity Number without dashes
                </p>
                <button
                  onClick={handleLockIn}
                  disabled={!isValid || lockInLoading}
                  className={`mt-6 flex w-full items-center justify-center gap-2.5 rounded-xl px-5 py-3.5 text-sm font-semibold transition-all ${
                    isValid && !lockInLoading
                      ? "bg-green-500 text-black hover:bg-green-400 hover:shadow-[0_0_24px_rgba(34,197,94,0.25)] active:scale-[0.98]"
                      : "cursor-not-allowed bg-neutral-800 text-neutral-600"
                  }`}
                >
                  {lockInLoading ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Verifying Enrollment…
                    </>
                  ) : (
                    <>
                      <Lock className="h-4 w-4" />
                      Lock In Target
                      <ArrowRight className="h-4 w-4" />
                    </>
                  )}
                </button>
              </div>
            )}

            {/* ────────────── LOCKED: Initiate Challenge ──────── */}
            {state === "locked" && (
              <div className="text-center">
                <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl border border-green-500/20 bg-green-500/10">
                  <ShieldCheck className="h-8 w-8 text-green-400" />
                </div>
                <h3 className="text-lg font-bold text-white">Target Locked</h3>
                <p className="mt-1.5 text-sm text-neutral-500">
                  Ready for voice biometric challenge.
                </p>

                {/* Locked CNIC Display */}
                <div className="mt-5 inline-flex items-center gap-2.5 rounded-xl border border-neutral-800 bg-black/40 px-5 py-3">
                  <User className="h-4 w-4 text-neutral-600" />
                  <span className="font-mono text-sm font-medium text-green-400">
                    {formatCnic(lockedCnic)}
                  </span>
                  <span className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-green-500 animate-pulse" />
                </div>

                {/* Error from challenge fetch */}
                {challengeError && (
                  <div className="mt-4 flex items-center justify-center gap-2 text-xs text-red-400">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    {challengeError}
                  </div>
                )}

                {/* Initiate Challenge Button */}
                <button
                  onClick={handleInitiateChallenge}
                  disabled={challengeLoading}
                  className="mt-6 inline-flex items-center gap-2.5 rounded-xl bg-cyan-500 px-6 py-3.5 text-sm font-semibold text-black transition-all hover:bg-cyan-400 hover:shadow-[0_0_24px_rgba(6,182,212,0.3)] active:scale-[0.98] disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {challengeLoading ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Generating Challenge…
                    </>
                  ) : (
                    <>
                      <Fingerprint className="h-4 w-4" />
                      Initiate Challenge
                      <ArrowRight className="h-4 w-4" />
                    </>
                  )}
                </button>

                {/* Change target */}
                <div className="mt-4">
                  <button
                    onClick={handleReset}
                    className="inline-flex items-center gap-2 text-[11px] font-medium text-neutral-600 transition-colors hover:text-neutral-400"
                  >
                    <RotateCcw className="h-3 w-3" />
                    Change Target
                  </button>
                </div>
              </div>
            )}

            {/* ────── CHALLENGE / RECORDING / RECORDED ────────── */}
            {(state === "challenge" || state === "recording" || state === "recorded") && (
              <div className="text-center">
                {/* Target CNIC mini-badge */}
                <div className="mb-6 inline-flex items-center gap-2 rounded-lg border border-neutral-800 bg-black/30 px-3 py-1.5">
                  <User className="h-3 w-3 text-neutral-600" />
                  <span className="font-mono text-[11px] text-neutral-400">
                    {formatCnic(lockedCnic)}
                  </span>
                </div>

                {/* ── Challenge Digits Display ──────────────────── */}
                <p className="mb-3 text-[10px] font-semibold uppercase tracking-[0.2em] text-neutral-600">
                  Challenge Prompt — Read Aloud in Urdu
                </p>
                <div className="flex items-center justify-center gap-3 mb-4">
                  {challengeDigits.map((digit, idx) => (
                    <div
                      key={idx}
                      className="flex h-36 w-24 flex-col items-center justify-center gap-3 rounded-2xl border border-cyan-500/30 bg-cyan-500/10 py-4 px-3"
                    >
                      <span className={`${nastaliq.className} text-6xl font-bold leading-none text-cyan-400`} dir="rtl">
                        {URDU_NUMERALS[digit]}
                      </span>
                      <span className={`${nastaliq.className} text-lg leading-none text-cyan-500/70`} dir="rtl">
                        {URDU_WORDS[digit]}
                      </span>
                    </div>
                  ))}
                </div>
                <p className="mb-6 text-[11px] text-neutral-600">
                  Session: <span className="font-mono text-neutral-500">{sessionId?.slice(0, 8)}…</span>
                </p>

                {/* ── CHALLENGE STATE: Start Recording ──────────── */}
                {state === "challenge" && (
                  <div className="flex flex-col items-center gap-4">
                    {micError && (
                      <div className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-2 text-xs text-red-400">
                        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                        {micError}
                      </div>
                    )}
                    <button
                      onClick={handleStartRecording}
                      className="group relative flex h-20 w-20 items-center justify-center rounded-full border border-green-500/30 bg-green-500/10 transition-all hover:border-green-500/50 hover:bg-green-500/20 active:scale-95"
                    >
                      <Mic className="h-7 w-7 text-green-400" />
                      <span className="absolute inset-0 animate-ping rounded-full bg-green-500/10" />
                    </button>
                    <p className="text-xs text-neutral-500">
                      Tap to <span className="font-semibold text-green-400">start recording</span> — then read the digits aloud
                    </p>
                  </div>
                )}

                {/* ── RECORDING STATE: Live capture ─────────────── */}
                {state === "recording" && (
                  <div className="flex flex-col items-center gap-4">
                    {/* Pulsing red mic button */}
                    <button
                      onClick={handleStopRecording}
                      className="group relative flex h-20 w-20 items-center justify-center rounded-full border border-red-500/30 bg-red-500/10 transition-all hover:border-red-500/50 hover:bg-red-500/20 active:scale-95"
                    >
                      <MicOff className="h-7 w-7 text-red-400" />
                      <span className="absolute inset-0 animate-ping rounded-full bg-red-500/10" />
                    </button>

                    {/* Recording timer */}
                    <div className="flex items-center gap-2">
                      <span className="inline-block h-2 w-2 rounded-full bg-red-500 animate-pulse" />
                      <span className="font-mono text-lg font-bold text-red-400">
                        {formattedTime}
                      </span>
                    </div>

                    <p className="text-xs text-neutral-500">
                      🔴 Recording… Tap to <span className="font-semibold text-red-400">stop</span>
                    </p>
                  </div>
                )}

                {/* ── RECORDED STATE: Ready to verify ───────────── */}
                {state === "recorded" && (
                  <div className="flex flex-col items-center gap-4">
                    {/* Success indicator */}
                    <div className="flex h-16 w-16 items-center justify-center rounded-2xl border border-green-500/20 bg-green-500/10">
                      <CheckCircle2 className="h-8 w-8 text-green-400" />
                    </div>

                    <div>
                      <p className="text-sm font-semibold text-white">
                        Audio Captured Successfully
                      </p>
                      <p className="mt-1 text-xs text-neutral-500">
                        {audioBlob
                          ? `${(audioBlob.size / 1024).toFixed(1)} KB · ${formattedTime} elapsed`
                          : "Processing…"}
                      </p>
                    </div>

                    {/* Verify error */}
                    {verifyError && (
                      <div className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-2 text-xs text-red-400">
                        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                        {verifyError}
                      </div>
                    )}

                    {/* Verify Identity Button */}
                    <button
                      onClick={handleVerify}
                      className="flex items-center gap-2.5 rounded-xl bg-green-500 px-8 py-3.5 text-sm font-semibold text-black transition-all hover:bg-green-400 hover:shadow-[0_0_24px_rgba(34,197,94,0.25)] active:scale-[0.98]"
                    >
                      <ShieldCheck className="h-4 w-4" />
                      Verify Identity
                      <ArrowRight className="h-4 w-4" />
                    </button>

                    {/* Re-record option */}
                    <button
                      onClick={() => {
                        setAudioBlob(null);
                        setRecordingSeconds(0);
                        setVerifyError("");
                        setState("challenge");
                      }}
                      className="inline-flex items-center gap-2 text-[11px] font-medium text-neutral-600 transition-colors hover:text-neutral-400"
                    >
                      <RotateCcw className="h-3 w-3" />
                      Re-record Audio
                    </button>
                  </div>
                )}

                {/* Change target link — always available in challenge states */}
                <div className="mt-6 border-t border-neutral-800/50 pt-4">
                  <button
                    onClick={handleReset}
                    className="inline-flex items-center gap-2 text-[11px] font-medium text-neutral-600 transition-colors hover:text-neutral-400"
                  >
                    <RotateCcw className="h-3 w-3" />
                    Reset Session
                  </button>
                </div>
              </div>
            )}

            {/* ────────────── VERIFYING: Loading ──────────────── */}
            {state === "verifying" && (
              <div className="flex flex-col items-center gap-6 py-4">
                {/* Animated spinner */}
                <div className="relative flex h-20 w-20 items-center justify-center">
                  <div className="absolute inset-0 rounded-full border-2 border-violet-500/20" />
                  <div className="absolute inset-0 animate-spin rounded-full border-2 border-transparent border-t-violet-500" style={{ animationDuration: "1.5s" }} />
                  <Fingerprint className="h-8 w-8 text-violet-400" />
                </div>

                <div className="text-center">
                  <h3 className="text-lg font-bold text-white">Processing Biometrics</h3>
                  <p className="mt-1.5 text-sm text-neutral-500">
                    Running verification pipeline…
                  </p>
                </div>

                {/* Pipeline steps */}
                <div className="w-full max-w-sm space-y-2">
                  {PIPELINE_STEPS.map((step, idx) => (
                    <div
                      key={idx}
                      className={`flex items-center gap-3 rounded-lg px-4 py-2.5 text-xs transition-all duration-500 ${
                        idx < pipelineStep
                          ? "bg-green-500/5 text-green-400"
                          : idx === pipelineStep
                          ? "bg-violet-500/10 text-violet-300 border border-violet-500/20"
                          : "text-neutral-700"
                      }`}
                    >
                      {idx < pipelineStep ? (
                        <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-green-500" />
                      ) : idx === pipelineStep ? (
                        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-violet-400" />
                      ) : (
                        <div className="h-3.5 w-3.5 shrink-0 rounded-full border border-neutral-800" />
                      )}
                      <span className="font-medium">{step}</span>
                    </div>
                  ))}
                </div>

                {/* CNIC indicator */}
                <div className="inline-flex items-center gap-2 rounded-lg border border-neutral-800 bg-black/30 px-3 py-1.5">
                  <User className="h-3 w-3 text-neutral-600" />
                  <span className="font-mono text-[11px] text-neutral-400">
                    {formatCnic(lockedCnic)}
                  </span>
                </div>
              </div>
            )}

            {/* ────────────── VERIFIED: Scorecard ─────────────── */}
            {state === "verified" && verifyResult && (() => {
              /* Parse pipe-delimited engine reasons from backend message */
              const reasons = verifyResult.message.split(" | ");
              const gatekeeperDetail = reasons.find((r) => r.startsWith("Gatekeeper FAIL:"))?.replace("Gatekeeper FAIL: ", "")
                || (verifyResult.gatekeeper_score >= 1.0 ? "Single-speaker audio confirmed. No splicing detected." : "Check failed.");
              const livenessDetail = reasons.find((r) => r.startsWith("Liveness FAIL:"))?.replace("Liveness FAIL: ", "")
                || (verifyResult.liveness_score >= 0.8 ? "Spoken digits matched the challenge sequence." : "Digit sequence mismatch.");
              const biometricDetail = reasons.find((r) => r.startsWith("Biometric FAIL:"))?.replace("Biometric FAIL: ", "")
                || (verifyResult.similarity_score >= 0.8 ? "Voiceprint matches enrolled baseline." : "Voice did not match baseline.");

              return (
              <div>
                {/* ── Verdict Banner ─────────────────────────────── */}
                <div
                  className={`mb-6 flex items-center gap-4 rounded-xl border p-5 ${
                    verifyResult.authenticated
                      ? "border-green-500/30 bg-green-500/5"
                      : "border-red-500/30 bg-red-500/5"
                  }`}
                >
                  <div
                    className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border ${
                      verifyResult.authenticated
                        ? "border-green-500/30 bg-green-500/10"
                        : "border-red-500/30 bg-red-500/10"
                    }`}
                  >
                    {verifyResult.authenticated ? (
                      <CheckCircle2 className="h-6 w-6 text-green-400" />
                    ) : (
                      <XCircle className="h-6 w-6 text-red-400" />
                    )}
                  </div>
                  <div>
                    <p
                      className={`text-lg font-bold ${
                        verifyResult.authenticated ? "text-green-400" : "text-red-400"
                      }`}
                    >
                      {verifyResult.authenticated
                        ? "Authentication Successful"
                        : "Authentication Failed"}
                    </p>
                    <p className="mt-0.5 text-xs text-neutral-500">
                      {verifyResult.authenticated
                        ? "All biometric checks passed. Identity verified."
                        : "One or more verification checks did not pass. See details below."}
                    </p>
                  </div>
                </div>

                {/* ── 3-Panel Scorecard ──────────────────────────── */}
                <div className="grid gap-3 sm:grid-cols-3">
                  {/* Card 1: Gatekeeper / Liveness (Pyannote) */}
                  <ScoreCard
                    icon={<Activity className="h-5 w-5" />}
                    label="Gatekeeper"
                    sublabel="Pyannote Diarization"
                    score={verifyResult.gatekeeper_score}
                    passed={verifyResult.gatekeeper_score >= 1.0}
                    detail={gatekeeperDetail}
                  />

                  {/* Card 2: ASR Match (Whisper Liveness) */}
                  <ScoreCard
                    icon={<AudioLines className="h-5 w-5" />}
                    label="ASR Liveness"
                    sublabel="Whisper Transcription"
                    score={verifyResult.liveness_score}
                    passed={verifyResult.liveness_score >= 0.8}
                    detail={livenessDetail}
                  />

                  {/* Card 3: Voice Similarity (ECAPA-TDNN) */}
                  <ScoreCard
                    icon={<ScanFace className="h-5 w-5" />}
                    label="Voice Match"
                    sublabel="ECAPA-TDNN Cosine"
                    score={verifyResult.similarity_score}
                    passed={verifyResult.similarity_score >= 0.8}
                    detail={biometricDetail}
                  />
                </div>

                {/* ── Risk Score ─────────────────────────────────── */}
                <div className="mt-4 flex items-center justify-between rounded-xl border border-neutral-800 bg-black/30 px-5 py-3">
                  <div className="flex items-center gap-2">
                    <AlertTriangle className={`h-4 w-4 ${verifyResult.risk_score > 0.5 ? "text-red-400" : "text-green-400"}`} />
                    <span className="text-xs font-semibold uppercase tracking-wider text-neutral-400">
                      Risk Score
                    </span>
                  </div>
                  <span
                    className={`font-mono text-sm font-bold ${
                      verifyResult.risk_score > 0.5 ? "text-red-400" : "text-green-400"
                    }`}
                  >
                    {(verifyResult.risk_score * 100).toFixed(0)}%
                  </span>
                </div>

                {/* ── Session Info ───────────────────────────────── */}
                <div className="mt-3 flex flex-wrap items-center justify-center gap-x-6 gap-y-1 text-[10px] text-neutral-600">
                  <span>
                    CNIC: <span className="font-mono text-neutral-500">{formatCnic(lockedCnic)}</span>
                  </span>
                  <span>
                    Session: <span className="font-mono text-neutral-500">{verifyResult.session_id?.slice(0, 8)}…</span>
                  </span>
                  <span>
                    Challenge: <span className="font-mono text-neutral-500">{challengeDigits.join(" — ")}</span>
                  </span>
                </div>

                {/* ── New Authentication Button ──────────────────── */}
                <button
                  onClick={handleReset}
                  className="mt-6 flex w-full items-center justify-center gap-2.5 rounded-xl border border-neutral-800 bg-neutral-800/50 px-5 py-3.5 text-sm font-semibold text-neutral-300 transition-all hover:border-neutral-700 hover:bg-neutral-800 hover:text-white"
                >
                  <RotateCcw className="h-4 w-4" />
                  New Authentication
                </button>
              </div>
              );
            })()}
          </div>
        </div>

        {/* ── Info Footer ──────────────────────────────────────── */}
        {state !== "verified" && (
          <div className="mt-4 flex items-start gap-3 rounded-xl border border-neutral-800/50 bg-neutral-900/30 px-5 py-4">
            <Lock className="mt-0.5 h-4 w-4 shrink-0 text-neutral-700" />
            <p className="text-[11px] leading-relaxed text-neutral-600">
              This module performs speaker verification against the enrolled
              voiceprint for the specified CNIC. The target customer must have
              completed voice enrollment before authentication can proceed.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Score Card Sub-Component ──────────────────────────────── */

function ScoreCard({
  icon,
  label,
  sublabel,
  score,
  passed,
  detail,
}: {
  icon: React.ReactNode;
  label: string;
  sublabel: string;
  score: number;
  passed: boolean;
  detail: string;
}) {
  const percentage = Math.round(score * 100);

  return (
    <div className="rounded-xl border border-neutral-800 bg-black/30 p-4">
      {/* Header */}
      <div className="mb-3 flex items-center justify-between">
        <div
          className={`flex h-9 w-9 items-center justify-center rounded-lg border ${
            passed
              ? "border-green-500/30 bg-green-500/10 text-green-400"
              : "border-red-500/30 bg-red-500/10 text-red-400"
          }`}
        >
          {icon}
        </div>
        <span
          className={`rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider ${
            passed
              ? "border-green-500/30 bg-green-500/10 text-green-400"
              : "border-red-500/30 bg-red-500/10 text-red-400"
          }`}
        >
          {passed ? "Pass" : "Fail"}
        </span>
      </div>

      {/* Score */}
      <p
        className={`text-2xl font-bold ${
          passed ? "text-green-400" : "text-red-400"
        }`}
      >
        {percentage}
        <span className="text-sm font-medium text-neutral-600">%</span>
      </p>

      {/* Labels */}
      <p className="mt-1 text-xs font-semibold text-neutral-300">{label}</p>
      <p className="text-[10px] text-neutral-600">{sublabel}</p>

      {/* Progress bar */}
      <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-neutral-800">
        <div
          className={`h-full rounded-full transition-all duration-700 ${
            passed ? "bg-green-500" : "bg-red-500"
          }`}
          style={{ width: `${percentage}%` }}
        />
      </div>

      {/* Engine detail / reason */}
      <p
        className={`mt-3 text-[10px] leading-relaxed ${
          passed ? "text-green-500/70" : "text-red-400/80"
        }`}
      >
        {detail}
      </p>
    </div>
  );
}
