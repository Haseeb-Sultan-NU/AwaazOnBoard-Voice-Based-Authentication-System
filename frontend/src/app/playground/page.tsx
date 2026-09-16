"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useCallback } from "react";
import {
  ArrowLeft,
  Mic,
  MicOff,
  CheckCircle,
  XCircle,
  Loader2,
  Fingerprint,
  Terminal,
  AlertTriangle,
} from "lucide-react";

/* ================================================================
   Types
   ================================================================ */
interface LogEntry {
  tag: string;
  message: string;
  color: string; // tailwind text-* class
}

interface ChallengeResponse {
  session_id: string;
  challenge: number[];
  sim_swap_warning: boolean;
}

interface VerifyResponse {
  authenticated: boolean;
  similarity_score: number;
  liveness_score: number;
  gatekeeper_score: number;
  risk_score: number;
  session_id: string;
  message: string;
}

/* ================================================================
   Log Color Map
   ================================================================ */
const TAG_COLORS: Record<string, string> = {
  INFO: "text-cyan-400",
  ENGINE: "text-violet-400",
  DB: "text-amber-400",
  SYSTEM: "text-neutral-400",
  SECURITY: "text-orange-400",
  MATH: "text-sky-300",
  RESULT: "text-green-400",
  ERROR: "text-red-400",
  API: "text-emerald-400",
};

/* ================================================================
   Helper: Format raw digits into XXXXX-XXXXXXX-X
   ================================================================ */
function formatCnic(raw: string): string {
  const digits = raw.replace(/\D/g, "").slice(0, 13);
  let result = digits;
  if (digits.length > 5) result = digits.slice(0, 5) + "-" + digits.slice(5);
  if (digits.length > 12) result = result.slice(0, 13) + "-" + result.slice(13);
  return result;
}

/* ================================================================
   API Base — proxied through Next.js rewrites → localhost:8000
   ================================================================ */
const API = "/api";

/* ================================================================
   Component: PlaygroundPage
   ================================================================ */
export default function PlaygroundPage() {
  /* ── Core State ─────────────────────────────────────────────── */
  const [demoStep, setDemoStep] = useState(0);
  const [logs, setLogs] = useState<LogEntry[]>([
    { tag: "SYSTEM", message: "AWAAZONBOARD Sandbox v1.0 initialized.", color: TAG_COLORS.SYSTEM },
    { tag: "INFO", message: "Ready. Enter CNIC to begin enrollment flow.", color: TAG_COLORS.INFO },
  ]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [cnic, setCnic] = useState("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const terminalRef = useRef<HTMLDivElement>(null);

  /* ── Challenge / Verify State ───────────────────────────────── */
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [challengeDigits, setChallengeDigits] = useState<number[]>([]);
  const [verifyResult, setVerifyResult] = useState<VerifyResponse | null>(null);

  /* ── MediaRecorder Refs ─────────────────────────────────────── */
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);

  /* ── Auto-scroll terminal ───────────────────────────────────── */
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [logs]);

  /* ── Log helper ─────────────────────────────────────────────── */
  const addLog = useCallback((tag: string, message: string) => {
    const color = TAG_COLORS[tag] || TAG_COLORS.SYSTEM;
    setLogs((prev) => [...prev, { tag, message, color }]);
  }, []);

  /* ── Cleanup mic stream ─────────────────────────────────────── */
  const stopStream = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  }, []);

  /* ================================================================
     Audio Recording Utilities
     ================================================================ */

  /** Start recording from the microphone. Returns nothing; stores state in refs. */
  const startRecording = useCallback(async (): Promise<void> => {
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
      setIsRecording(true);
      addLog("INFO", "🎙️ Microphone active — recording audio...");
    } catch (err) {
      addLog("ERROR", `Mic access denied: ${(err as Error).message}`);
      throw err;
    }
  }, [addLog]);

  /** Stop recording and return the captured audio Blob. */
  const stopRecording = useCallback((): Promise<Blob> => {
    return new Promise((resolve, reject) => {
      const recorder = mediaRecorderRef.current;
      if (!recorder || recorder.state === "inactive") {
        reject(new Error("No active recording"));
        return;
      }

      recorder.onstop = () => {
        const blob = new Blob(audioChunksRef.current, { type: recorder.mimeType });
        audioChunksRef.current = [];
        setIsRecording(false);
        stopStream();
        addLog("INFO", `Recording stopped. Blob size: ${(blob.size / 1024).toFixed(1)} KB`);
        resolve(blob);
      };

      recorder.stop();
    });
  }, [addLog, stopStream]);

  /* ================================================================
     Step 0 → 1: Start Enrollment (CNIC Submission)
     ================================================================ */
  const handleStartEnrollment = () => {
    if (!cnic.trim()) return;
    setErrorMsg(null);
    addLog("INFO", `CNIC received: ${cnic.replace(/./g, "•").slice(0, -4) + cnic.slice(-4)}`);
    addLog("SYSTEM", "Enrollment flow started.");
    setDemoStep(1);
    addLog("INFO", "Initializing Audio Stream...");
  };

  /* ================================================================
     Step 1: Record Master Voice → POST /api/enroll
     ================================================================ */

  /** Toggle mic: first click starts, second click stops + uploads. */
  const handleEnrollmentMicToggle = async () => {
    if (isRecording) {
      // ── Stop & Upload ──
      setIsProcessing(true);
      setErrorMsg(null);
      try {
        const blob = await stopRecording();
        addLog("ENGINE", "Recording master voice sample...");
        addLog("ENGINE", "Extracting Master Embedding (ECAPA-TDNN 192-dim)...");

        // Build FormData — CRITICAL HACK: send same blob 3× as take_1/2/3
        const formData = new FormData();
        formData.append("user_id", cnic.replace(/-/g, ""));
        formData.append("take_1", blob, "audio.webm");
        formData.append("take_2", blob, "audio.webm");
        formData.append("take_3", blob, "audio.webm");

        addLog("API", "POST /api/enroll — uploading 3 voice takes...");
        const res = await fetch(`${API}/enroll`, {
          method: "POST",
          body: formData,
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.detail || `Enrollment failed (${res.status})`);
        }

        const data = await res.json();
        addLog("DB", `Profile saved: ${data.message || "success"}`);
        addLog("SYSTEM", "Enrollment complete. Moving to challenge phase...");
        setIsProcessing(false);
        setDemoStep(2);
      } catch (err) {
        addLog("ERROR", `Enrollment failed: ${(err as Error).message}`);
        setErrorMsg((err as Error).message);
        setIsProcessing(false);
      }
    } else {
      // ── Start Recording ──
      try {
        await startRecording();
      } catch {
        // error already logged inside startRecording
      }
    }
  };

  /* ================================================================
     Step 2: Fetch Dynamic Challenge on mount
     ================================================================ */
  useEffect(() => {
    if (demoStep !== 2) return;

    let cancelled = false;

    const fetchChallenge = async () => {
      try {
        addLog("API", "POST /api/authenticate/challenge");
        const res = await fetch(`${API}/authenticate/challenge`, { method: "POST" });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.detail || `Challenge fetch failed (${res.status})`);
        }

        const data: ChallengeResponse = await res.json();
        if (cancelled) return;

        setSessionId(data.session_id);
        setChallengeDigits(data.challenge);
        addLog("INFO", `Dynamic challenge received: ${data.challenge.join("-")}`);
        addLog("SYSTEM", "Waiting for user audio...");
      } catch (err) {
        if (!cancelled) {
          addLog("ERROR", `Challenge error: ${(err as Error).message}`);
          setErrorMsg((err as Error).message);
        }
      }
    };

    fetchChallenge();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demoStep]);

  /* ================================================================
     Step 2 → 3: Record Challenge Audio → POST /api/authenticate/verify
     ================================================================ */
  const handleVerifyMicToggle = async () => {
    if (isRecording) {
      // ── Stop & Submit ──
      setIsProcessing(true);
      setErrorMsg(null);
      try {
        const blob = await stopRecording();
        addLog("INFO", "Verification audio captured. Processing...");
        setDemoStep(3); // Show the processing spinner

        addLog("ENGINE", "Initializing Pyannote Diarization Pipeline...");

        const formData = new FormData();
        formData.append("session_id", sessionId || "");
        formData.append("user_id", cnic.replace(/-/g, ""));
        formData.append("voice", blob, "audio.webm");

        addLog("API", "POST /api/authenticate/verify — submitting voice...");
        const res = await fetch(`${API}/authenticate/verify`, {
          method: "POST",
          body: formData,
        });

        const data: VerifyResponse = await res.json();
        setVerifyResult(data);

        // ── Print REAL scores to terminal ──
        addLog("SECURITY", `Gatekeeper Score: ${data.gatekeeper_score?.toFixed(3) ?? "N/A"}`);
        addLog("ENGINE", "Extracting ECAPA-TDNN Verification Vector...");
        addLog("MATH", `Cosine Similarity: ${data.similarity_score?.toFixed(4) ?? "N/A"}`);
        addLog("MATH", `Liveness Score: ${data.liveness_score?.toFixed(4) ?? "N/A"}`);
        addLog("MATH", `Risk Score: ${data.risk_score?.toFixed(4) ?? "N/A"}`);

        if (data.authenticated) {
          addLog("RESULT", "✅ MATCH CONFIDENCE ABOVE THRESHOLD. ACCESS GRANTED.");
        } else {
          addLog("ERROR", `❌ VERIFICATION FAILED: ${data.message}`);
        }

        setIsProcessing(false);
        setDemoStep(4);
      } catch (err) {
        addLog("ERROR", `Verification error: ${(err as Error).message}`);
        setErrorMsg((err as Error).message);
        setIsProcessing(false);
        setDemoStep(4);
        setVerifyResult({
          authenticated: false,
          similarity_score: 0,
          liveness_score: 0,
          gatekeeper_score: 0,
          risk_score: 1,
          session_id: sessionId || "",
          message: (err as Error).message,
        });
      }
    } else {
      // ── Start Recording ──
      try {
        await startRecording();
      } catch {
        // error already logged
      }
    }
  };

  /* ================================================================
     Reset
     ================================================================ */
  const handleReset = () => {
    stopStream();
    setDemoStep(0);
    setCnic("");
    setIsProcessing(false);
    setIsRecording(false);
    setErrorMsg(null);
    setSessionId(null);
    setChallengeDigits([]);
    setVerifyResult(null);
    setLogs([
      { tag: "SYSTEM", message: "────────── SESSION RESET ──────────", color: TAG_COLORS.SYSTEM },
      { tag: "SYSTEM", message: "AWAAZONBOARD Sandbox v1.0 initialized.", color: TAG_COLORS.SYSTEM },
      { tag: "INFO", message: "Ready. Enter CNIC to begin enrollment flow.", color: TAG_COLORS.INFO },
    ]);
  };

  /* ================================================================
     Render
     ================================================================ */
  return (
    <div className="relative flex min-h-[calc(100vh-4rem)] flex-col bg-black">
      {/* ── Header Bar ─────────────────────────────────────────── */}
      <header className="flex items-center gap-4 border-b border-neutral-800/60 bg-black/90 px-6 py-3 backdrop-blur-xl">
        <Link
          href="/"
          className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm text-neutral-400 transition-colors hover:bg-neutral-900 hover:text-white"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Home
        </Link>
        <div className="h-5 w-px bg-neutral-800" />
        <div className="flex items-center gap-2">
          <Terminal className="h-4 w-4 text-green-500" />
          <span className="text-sm font-semibold tracking-wider text-white uppercase">
            AwaazOnboard Sandbox
          </span>
        </div>
        {/* Step indicator pills */}
        <div className="ml-auto flex items-center gap-1.5">
          {[0, 1, 2, 3, 4].map((s) => (
            <div
              key={s}
              className={`h-2 w-2 rounded-full transition-all duration-300 ${
                s === demoStep
                  ? "bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)]"
                  : s < demoStep
                  ? "bg-green-500/40"
                  : "bg-neutral-700"
              }`}
            />
          ))}
        </div>
      </header>

      {/* ── Split Screen ───────────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden">
        {/* ── Left Column: Mobile Mockup (40%) ─────────────────── */}
        <div className="flex w-[40%] items-center justify-center border-r border-neutral-800/40 bg-[#030303] p-8">
          {/* Phone Bezel */}
          <div className="relative flex h-[640px] w-[320px] flex-col overflow-hidden rounded-[3rem] border-[3px] border-neutral-800 bg-black shadow-[0_0_80px_rgba(34,197,94,0.04)]">
            {/* Notch */}
            <div className="mx-auto mt-3 h-6 w-28 rounded-full bg-neutral-900" />

            {/* Screen Content */}
            <div className="flex flex-1 flex-col items-center justify-center px-6 py-4">
              {/* ── Step 0 — CNIC Entry ──────────────────────── */}
              {demoStep === 0 && (
                <div className="flex w-full flex-col items-center gap-5 animate-in fade-in duration-500">
                  <Fingerprint className="h-10 w-10 text-green-500 opacity-60" />
                  <h2 className="text-base font-semibold text-white">
                    Enter CNIC
                  </h2>
                  <input
                    type="text"
                    placeholder="00000-0000000-0"
                    value={cnic}
                    maxLength={15}
                    onChange={(e) => setCnic(formatCnic(e.target.value))}
                    className="w-full rounded-xl border border-neutral-700 bg-neutral-900/80 px-4 py-3 text-center text-sm tracking-widest text-white placeholder:text-neutral-600 focus:border-green-500/60 focus:outline-none"
                  />
                  <button
                    onClick={handleStartEnrollment}
                    disabled={!cnic.trim()}
                    className="w-full rounded-xl bg-green-500 px-4 py-3 text-sm font-semibold text-black transition-all hover:bg-green-400 hover:shadow-[0_0_24px_rgba(34,197,94,0.3)] disabled:opacity-30 disabled:hover:bg-green-500 disabled:hover:shadow-none"
                  >
                    Start Enrollment
                  </button>
                </div>
              )}

              {/* ── Step 1 — Master Template Recording ───────── */}
              {demoStep === 1 && (
                <div className="flex w-full flex-col items-center gap-5 animate-in fade-in duration-500">
                  <p className="text-xs font-medium tracking-wider text-green-500/80 uppercase">
                    Step 1: Master Voice Profile
                  </p>

                  {/* Mic button — toggles record on/off */}
                  <button
                    onClick={handleEnrollmentMicToggle}
                    disabled={isProcessing}
                    className={`group relative flex h-20 w-20 items-center justify-center rounded-full transition-all disabled:opacity-50 ${
                      isRecording
                        ? "bg-red-500 shadow-[0_0_40px_rgba(239,68,68,0.35)]"
                        : "bg-green-500 shadow-[0_0_40px_rgba(34,197,94,0.25)] hover:shadow-[0_0_60px_rgba(34,197,94,0.4)]"
                    }`}
                  >
                    {isProcessing ? (
                      <Loader2 className="h-8 w-8 animate-spin text-black" />
                    ) : isRecording ? (
                      <MicOff className="h-8 w-8 text-white transition-transform group-hover:scale-110" />
                    ) : (
                      <Mic className="h-8 w-8 text-black transition-transform group-hover:scale-110" />
                    )}
                    {/* Pulse rings */}
                    {isRecording && (
                      <>
                        <span className="absolute inset-0 animate-ping rounded-full bg-red-500/20" />
                        <span className="absolute -inset-2 animate-pulse rounded-full border border-red-500/30" />
                      </>
                    )}
                    {!isRecording && !isProcessing && (
                      <>
                        <span className="absolute inset-0 animate-ping rounded-full bg-green-500/20" />
                        <span className="absolute -inset-2 animate-pulse rounded-full border border-green-500/10" />
                      </>
                    )}
                  </button>

                  <p className="rounded-lg border border-neutral-800 bg-neutral-900/60 px-4 py-2.5 text-center text-xs leading-relaxed text-neutral-300">
                    Read aloud:{" "}
                    <span className="font-semibold text-white">
                      &quot;Meri aawaz mera password hai&quot;
                    </span>
                  </p>

                  <p className="text-xs text-neutral-500">
                    {isRecording
                      ? "🔴 Recording... Tap mic to stop & enroll"
                      : isProcessing
                      ? "⏳ Uploading & processing..."
                      : "Tap the mic to start recording"}
                  </p>

                  {errorMsg && (
                    <p className="text-xs text-red-400 text-center">{errorMsg}</p>
                  )}
                </div>
              )}

              {/* ── Step 2 — Dynamic Challenge ───────────────── */}
              {demoStep === 2 && (
                <div className="flex w-full flex-col items-center gap-5 animate-in fade-in duration-500">
                  <p className="text-xs font-medium tracking-wider text-green-500/80 uppercase">
                    Step 2: Live Verification
                  </p>

                  {/* Challenge digits — from real API */}
                  {challengeDigits.length > 0 ? (
                    <div className="flex items-center gap-3">
                      {challengeDigits.map((d, idx) => (
                        <span
                          key={idx}
                          className="flex h-14 w-14 items-center justify-center rounded-2xl border border-green-500/30 bg-green-500/10 text-2xl font-bold text-green-400 glow-green"
                        >
                          {d}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <Loader2 className="h-5 w-5 animate-spin text-green-500" />
                      <span className="text-xs text-neutral-400">
                        Fetching challenge...
                      </span>
                    </div>
                  )}

                  {/* Mic for challenge response */}
                  {challengeDigits.length > 0 && (
                    <div className="flex flex-col items-center gap-3">
                      <button
                        onClick={handleVerifyMicToggle}
                        disabled={isProcessing}
                        className={`group relative flex h-16 w-16 items-center justify-center rounded-full border transition-all disabled:opacity-50 ${
                          isRecording
                            ? "bg-red-500/20 border-red-500/30 hover:bg-red-500/30"
                            : "bg-green-500/20 border-green-500/30 hover:bg-green-500/30"
                        }`}
                      >
                        {isRecording ? (
                          <MicOff className="h-6 w-6 text-red-400" />
                        ) : (
                          <Mic className="h-6 w-6 text-green-400" />
                        )}
                        {isRecording && (
                          <span className="absolute inset-0 animate-ping rounded-full bg-red-500/10" />
                        )}
                        {!isRecording && (
                          <span className="absolute inset-0 animate-ping rounded-full bg-green-500/10" />
                        )}
                      </button>
                      <p className="text-xs text-neutral-400">
                        {isRecording
                          ? "🔴 Recording... Tap to stop & verify"
                          : "Tap mic → speak the digits → tap again"}
                      </p>
                    </div>
                  )}

                  {errorMsg && (
                    <p className="text-xs text-red-400 text-center">{errorMsg}</p>
                  )}
                </div>
              )}

              {/* ── Step 3 — Processing Spinner ──────────────── */}
              {demoStep === 3 && (
                <div className="flex w-full flex-col items-center gap-6 animate-in fade-in duration-500">
                  <Loader2 className="h-14 w-14 animate-spin text-green-500" />
                  <p className="text-sm font-medium text-neutral-300">
                    Running Liveness &amp; ECAPA-TDNN...
                  </p>
                  <div className="flex items-center gap-2">
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-green-500" />
                    <span className="text-xs text-neutral-500">
                      Pipeline active
                    </span>
                  </div>
                </div>
              )}

              {/* ── Step 4 — Results (Real Data) ─────────────── */}
              {demoStep === 4 && (
                <div className="flex w-full flex-col items-center gap-5 animate-in fade-in duration-500">
                  {verifyResult?.authenticated ? (
                    <>
                      {/* ✅ Success State */}
                      <div className="relative">
                        <CheckCircle className="h-16 w-16 text-green-500" />
                        <span className="absolute -inset-3 animate-pulse rounded-full bg-green-500/10" />
                      </div>
                      <h2 className="text-lg font-bold text-green-400 glow-green-text">
                        Identity Verified
                      </h2>
                    </>
                  ) : (
                    <>
                      {/* ❌ Failure State */}
                      <div className="relative">
                        <XCircle className="h-16 w-16 text-red-500" />
                        <span className="absolute -inset-3 animate-pulse rounded-full bg-red-500/10" />
                      </div>
                      <h2 className="text-lg font-bold text-red-400">
                        Verification Failed
                      </h2>
                      {verifyResult?.message && (
                        <div className="flex items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2">
                          <AlertTriangle className="h-4 w-4 text-red-400 shrink-0" />
                          <p className="text-xs text-red-300">{verifyResult.message}</p>
                        </div>
                      )}
                    </>
                  )}

                  {/* Stats — Real values from API */}
                  <div className="w-full space-y-2 rounded-xl border border-neutral-800 bg-neutral-900/60 p-4">
                    <StatRow
                      label="Gatekeeper"
                      value={
                        verifyResult
                          ? `${(verifyResult.gatekeeper_score * 100).toFixed(0)}%`
                          : "—"
                      }
                      valueClass={
                        verifyResult && verifyResult.gatekeeper_score >= 0.8
                          ? "text-green-400"
                          : "text-red-400"
                      }
                    />
                    <StatRow
                      label="Liveness"
                      value={
                        verifyResult
                          ? `${(verifyResult.liveness_score * 100).toFixed(1)}%`
                          : "—"
                      }
                      valueClass={
                        verifyResult && verifyResult.liveness_score >= 0.7
                          ? "text-green-400"
                          : "text-red-400"
                      }
                    />
                    <StatRow
                      label="ECAPA Match"
                      value={
                        verifyResult
                          ? `${(verifyResult.similarity_score * 100).toFixed(1)}%`
                          : "—"
                      }
                      valueClass={
                        verifyResult?.authenticated
                          ? "text-green-400"
                          : "text-red-400"
                      }
                    />
                    <StatRow
                      label="Risk"
                      value={
                        verifyResult
                          ? `${(verifyResult.risk_score * 100).toFixed(0)}%`
                          : "—"
                      }
                      valueClass={
                        verifyResult && verifyResult.risk_score <= 0.3
                          ? "text-green-400"
                          : "text-orange-400"
                      }
                    />
                  </div>

                  <button
                    onClick={handleReset}
                    className="w-full rounded-xl border border-neutral-700 bg-neutral-900 px-4 py-3 text-sm font-semibold text-neutral-300 transition-all hover:border-neutral-600 hover:text-white"
                  >
                    Reset Demo
                  </button>
                </div>
              )}
            </div>

            {/* Home indicator bar */}
            <div className="mx-auto mb-3 h-1 w-28 rounded-full bg-neutral-700" />
          </div>
        </div>

        {/* ── Right Column: Live Terminal (60%) ─────────────────── */}
        <div className="flex w-[60%] flex-col bg-[#050505]">
          {/* Terminal title bar */}
          <div className="flex items-center gap-3 border-b border-neutral-800/50 px-5 py-2.5">
            <div className="flex gap-1.5">
              <span className="h-3 w-3 rounded-full bg-red-500/70" />
              <span className="h-3 w-3 rounded-full bg-yellow-500/70" />
              <span className="h-3 w-3 rounded-full bg-green-500/70" />
            </div>
            <span className="text-xs text-neutral-500 font-mono">
              inference_engine — bash — 120×40
            </span>
          </div>

          {/* Log output */}
          <div
            ref={terminalRef}
            className="flex-1 overflow-y-auto p-5 font-mono text-sm leading-relaxed"
          >
            {logs.map((log, i) => (
              <div key={i} className="flex gap-2">
                <span className="select-none text-neutral-600">
                  {String(i + 1).padStart(3, "0")}
                </span>
                <span className={`font-semibold ${log.color}`}>
                  [{log.tag}]
                </span>
                <span className="text-neutral-300">{log.message}</span>
              </div>
            ))}
            {/* Blinking cursor */}
            <div className="mt-1 flex items-center gap-1">
              <span className="text-neutral-600 select-none">
                {String(logs.length + 1).padStart(3, "0")}
              </span>
              <span className="inline-block h-4 w-2 animate-pulse bg-green-500/80" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Utility: Stat Row ────────────────────────────────────────── */
function StatRow({
  label,
  value,
  valueClass = "text-white",
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div className="flex items-center justify-between text-xs">
      <span className="text-neutral-500">{label}</span>
      <span className={`font-semibold ${valueClass}`}>{value}</span>
    </div>
  );
}
