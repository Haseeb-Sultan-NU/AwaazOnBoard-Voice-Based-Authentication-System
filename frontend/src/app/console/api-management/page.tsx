"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import {
  Activity,
  Clock,
  Key,
  Copy,
  Globe,
  Save,
  Check,
  Terminal,
  Send,
  Loader2,
  CheckCircle2,
  XCircle,
  ChevronRight,
  Code2,
  Zap,
  RefreshCw,
  Trash2,
  Mic,
  Square,
  Upload,
  ShieldCheck,
  Fingerprint,
  Eye,
  AlertTriangle,
  BadgeCheck,
} from "lucide-react";

/* ════════════════════════════════════════════════════════════
   Types
═══════════════════════════════════════════════════════════════ */
type TabKey = "curl" | "python" | "node";
type InputTab = "form" | "raw";
type AudioMode = "upload" | "record";
type Status = "idle" | "loading" | "success" | "error";

/** Shape returned by POST /authenticate/verify */
interface VerifyResponse {
  authenticated?: boolean;
  similarity_score?: number;
  liveness_score?: number;
  risk_score?: number;
  gatekeeper_score?: number;
  session_id?: string;
  message?: string;
  // fallback for mock /api/v1/verify response shape
  result?: string;
  confidence_score?: number;
  liveness_detected?: boolean;
  pipeline?: {
    gatekeeper?: { passed?: boolean; speakers_detected?: number };
    liveness?: { passed?: boolean; score?: number; method?: string };
    biometric?: { passed?: boolean; cosine_similarity?: number };
  };
}

/* ════════════════════════════════════════════════════════════
   Helpers
═══════════════════════════════════════════════════════════════ */
function randomApiKey(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return (
    "sk_live_" +
    Array.from({ length: 32 }, () =>
      chars[Math.floor(Math.random() * chars.length)]
    ).join("")
  );
}

function formatCnicDisplay(raw: string): string {
  const d = raw.replace(/\D/g, "").slice(0, 13);
  if (d.length <= 5) return d;
  if (d.length <= 12) return `${d.slice(0, 5)}-${d.slice(5)}`;
  return `${d.slice(0, 5)}-${d.slice(5, 12)}-${d.slice(12)}`;
}

function colorizeJson(json: string): string {
  return json
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(
      /("(\\u[\da-fA-F]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g,
      (match) => {
        if (/^"/.test(match)) {
          if (/:$/.test(match)) return `<span style="color:#7dd3fc">${match}</span>`;
          return `<span style="color:#86efac">${match}</span>`;
        }
        if (/true|false/.test(match)) return `<span style="color:#f9a8d4">${match}</span>`;
        if (/null/.test(match)) return `<span style="color:#fca5a5">${match}</span>`;
        return `<span style="color:#fde68a">${match}</span>`;
      }
    );
}

const SNIPPETS: Record<TabKey, string> = {
  curl: `# Step 1 — Generate a numeric challenge
curl -X POST https://api.awaazonboard.ai/authenticate/challenge \\
  -H "Authorization: Bearer sk_live_...3f2d"
# Returns: { session_id, challenge: [5,9,1], sim_swap_warning }

# Step 2 — Submit FormData (CNIC + recorded voice)
curl -X POST https://api.awaazonboard.ai/authenticate/verify \\
  -H "Authorization: Bearer sk_live_...3f2d" \\
  -F "session_id=<session_id>" \\
  -F "user_id=1234512345671" \\
  -F "voice=@response.webm;type=audio/webm"`,
  python: `import requests

BASE = "https://api.awaazonboard.ai"
KEY  = "sk_live_...3f2d"
HEADERS = {"Authorization": f"Bearer {KEY}"}

# Step 1 — Generate challenge
ch = requests.post(f"{BASE}/authenticate/challenge", headers=HEADERS).json()
print("Say these digits:", ch["challenge"])   # e.g. [5, 9, 1]

# Step 2 — Verify (send recorded audio)
with open("response.webm", "rb") as audio:
    resp = requests.post(
        f"{BASE}/authenticate/verify",
        headers=HEADERS,
        data={"session_id": ch["session_id"], "user_id": "1234512345671"},
        files={"voice": ("response.webm", audio, "audio/webm")},
    )
print(resp.json())`,
  node: `const BASE = "https://api.awaazonboard.ai";
const auth = "Bearer sk_live_...3f2d";

// Step 1 — Generate challenge
const ch = await fetch(\`\${BASE}/authenticate/challenge\`, {
  method: "POST", headers: { Authorization: auth },
}).then(r => r.json());
console.log("Say:", ch.challenge);   // [5, 9, 1]

// Step 2 — Verify (send recorded audio blob)
const form = new FormData();
form.append("session_id", ch.session_id);
form.append("user_id", "1234512345671");
form.append("voice", audioBlob, "response.webm");

const result = await fetch(\`\${BASE}/authenticate/verify\`, {
  method: "POST", headers: { Authorization: auth }, body: form,
}).then(r => r.json());
console.log(result);`,
};

/* ════════════════════════════════════════════════════════════
   Sub-components
═══════════════════════════════════════════════════════════════ */
function PassBadge({ passed }: { passed?: boolean }) {
  return passed ? (
    <span className="inline-flex items-center gap-1 rounded-full border border-green-500/30 bg-green-500/10 px-2.5 py-0.5 text-xs font-semibold text-green-400">
      <CheckCircle2 className="h-3 w-3" /> PASS
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 rounded-full border border-red-500/30 bg-red-500/10 px-2.5 py-0.5 text-xs font-semibold text-red-400">
      <XCircle className="h-3 w-3" /> FAIL
    </span>
  );
}

function ConfidenceBar({ score }: { score: number }) {
  const pct = Math.round(score * 100);
  const color = pct >= 80 ? "bg-green-500" : pct >= 50 ? "bg-amber-500" : "bg-red-500";
  return (
    <div className="flex items-center gap-3">
      <div className="h-1.5 flex-1 rounded-full bg-neutral-800 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-700 ${color}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="w-10 text-right text-xs font-semibold text-white">{pct}%</span>
    </div>
  );
}

/** Minimal MediaRecorder hook per take (returns {blob, recording, elapsed, start, stop}) */
function useTake() {
  const [blob, setBlob] = useState<Blob | null>(null);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const mrRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const start = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      mrRef.current = mr;
      chunksRef.current = [];
      mr.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      mr.onstop = () => {
        setBlob(new Blob(chunksRef.current, { type: "audio/webm" }));
        stream.getTracks().forEach((t) => t.stop());
      };
      mr.start();
      setRecording(true);
      setElapsed(0);
      timerRef.current = setInterval(() => setElapsed((s) => s + 1), 1000);
    } catch { alert("Microphone access denied."); }
  }, []);

  const stop = useCallback(() => {
    mrRef.current?.stop();
    setRecording(false);
    if (timerRef.current) clearInterval(timerRef.current);
  }, []);

  return { blob, recording, elapsed, start, stop };
}

/* ════════════════════════════════════════════════════════════
   Main Component
═══════════════════════════════════════════════════════════════ */
export default function ApiManagementPage() {
  /* ── API Key ─────────────────────────────────────── */
  const [apiKey, setApiKey] = useState("sk_live_••••••••••••••••3f2d");
  const [keyCopied, setKeyCopied] = useState(false);
  const [keyRevoked, setKeyRevoked] = useState(false);

  const handleCopyKey = () => {
    if (keyRevoked) return;
    navigator.clipboard.writeText(apiKey).catch(() => {});
    setKeyCopied(true);
    setTimeout(() => setKeyCopied(false), 2000);
  };

  /* ── Webhook ─────────────────────────────────────── */
  const [webhookUrl, setWebhookUrl] = useState("");

  /* ── Sandbox tabs ────────────────────────────────── */
  const [inputTab, setInputTab] = useState<InputTab>("form");
  const [codeTab, setCodeTab] = useState<TabKey>("curl");

  /* ── Step 1: Challenge ───────────────────────────── */
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [challenge, setChallenge] = useState<number[] | null>(null);
  const [challengeLoading, setChallengeLoading] = useState(false);
  const [challengeError, setChallengeError] = useState("");

  const handleGenerateChallenge = async () => {
    setChallengeLoading(true);
    setChallengeError("");
    try {
      const res = await fetch("/api/authenticate/challenge", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
      setSessionId(data.session_id);
      // challenge is an array of ints e.g. [5, 9, 1]
      setChallenge(Array.isArray(data.challenge) ? data.challenge : [data.challenge]);
    } catch (err) {
      setChallengeError(String(err));
    } finally {
      setChallengeLoading(false);
    }
  };

  /* ── Step 1.5: Quick Enroll ──────────────────────── */
  const [cnic, setCnic] = useState("");
  const take1 = useTake();
  const take2 = useTake();
  const take3 = useTake();
  const takes = [take1, take2, take3];
  const [enrollLoading, setEnrollLoading] = useState(false);
  const [enrollStatus, setEnrollStatus] = useState<"idle" | "success" | "error">("idle");
  const [enrollMsg, setEnrollMsg] = useState("");

  const handleEnroll = async () => {
    if (!take1.blob || !take2.blob || !take3.blob) {
      setEnrollMsg("Record all 3 takes before submitting.");
      setEnrollStatus("error");
      return;
    }
    const cnicDigits = cnic.replace(/\D/g, "");
    if (cnicDigits.length !== 13) {
      setEnrollMsg("Enter a valid 13-digit CNIC first.");
      setEnrollStatus("error");
      return;
    }

    let adminId = "";
    try {
      const stored = localStorage.getItem("awaaz_user");
      if (stored) {
        const parsed = JSON.parse(stored);
        adminId = (parsed?.cnic || parsed?.user_id || "").replace(/\D/g, "");
      }
    } catch { /* no-op */ }

    setEnrollLoading(true);
    setEnrollStatus("idle");
    setEnrollMsg("");
    try {
      const fd = new FormData();
      fd.append("customer_cnic", cnicDigits);
      fd.append("customer_name", "API Sandbox Tester");
      fd.append("admin_user_id", adminId);
      fd.append("take_1", take1.blob!, "take_1.webm");
      fd.append("take_2", take2.blob!, "take_2.webm");
      fd.append("take_3", take3.blob!, "take_3.webm");

      const res = await fetch("/api/customers/enroll?sandbox=true", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
      setEnrollStatus("success");
      setEnrollMsg(data.message || "Customer enrolled successfully.");
    } catch (err) {
      setEnrollStatus("error");
      setEnrollMsg(String(err));
    } finally {
      setEnrollLoading(false);
    }
  };

  /* ── Step 2: Verify audio (record or upload) ─────── */
  const [audioMode, setAudioMode] = useState<AudioMode>("record");
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const verifyTake = useTake();

  /* ── Raw JSON tab ────────────────────────────────── */
  const defaultRaw = JSON.stringify(
    { session_id: "<generated-session-id>", cnic: "12345-1234567-1", audio_url: "https://client-storage.com/audio/response.wav" },
    null, 2
  );
  const [rawPayload, setRawPayload] = useState(defaultRaw);
  const [rawError, setRawError] = useState("");

  /* ── Response state ──────────────────────────────── */
  const [status, setStatus] = useState<Status>("idle");
  const [responseJson, setResponseJson] = useState("");
  const [parsedResponse, setParsedResponse] = useState<VerifyResponse | null>(null);
  const [colorizedHtml, setColorizedHtml] = useState("");
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [respCopied, setRespCopied] = useState(false);
  const startRef = useRef<number>(0);

  useEffect(() => {
    if (responseJson) setColorizedHtml(colorizeJson(responseJson));
  }, [responseJson]);

  /* ── Send for verification ───────────────────────── */
  const handleSend = async () => {
    setStatus("loading");
    setResponseJson("");
    setParsedResponse(null);
    setLatencyMs(null);
    startRef.current = performance.now();

    try {
      let res: Response;

      if (inputTab === "raw") {
        // Raw JSON → mock endpoint (no real audio file)
        try { JSON.parse(rawPayload); } catch { setRawError("Fix JSON errors first."); setStatus("idle"); return; }
        res = await fetch("/api/api/v1/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: rawPayload,
        });
      } else {
        // Real pipeline → POST /authenticate/verify with FormData
        if (!sessionId) {
          setResponseJson(JSON.stringify({ error: "Generate a challenge first (Step 1)." }, null, 2));
          setStatus("error");
          setLatencyMs(0);
          return;
        }

        const audioBlob = audioMode === "record" ? verifyTake.blob : audioFile;
        if (!audioBlob) {
          setResponseJson(JSON.stringify({ error: audioMode === "record" ? "Record your voice response first." : "Select an audio file first." }, null, 2));
          setStatus("error");
          setLatencyMs(0);
          return;
        }

        const cnicDigits = cnic.replace(/\D/g, "");
        const fd = new FormData();
        fd.append("session_id", sessionId);
        fd.append("user_id", cnicDigits);
        // The backend field is `voice` on /authenticate/verify
        fd.append("voice", audioBlob, "response.webm");

        res = await fetch("/api/authenticate/verify?sandbox=true", { method: "POST", body: fd });
      }

      const elapsed = Math.round(performance.now() - startRef.current);
      setLatencyMs(elapsed);
      const data: VerifyResponse = await res.json();
      setResponseJson(JSON.stringify(data, null, 2));
      setParsedResponse(data);
      setStatus(res.ok ? "success" : "error");
    } catch (err) {
      setLatencyMs(Math.round(performance.now() - startRef.current));
      setResponseJson(JSON.stringify({ error: "Network error — is the backend running?", detail: String(err) }, null, 2));
      setStatus("error");
    }
  };

  const canSend = status !== "loading";

  /* ── Derive metrics from either response shape ───── */
  const biometricScore =
    parsedResponse?.similarity_score ??
    parsedResponse?.pipeline?.biometric?.cosine_similarity ??
    parsedResponse?.confidence_score ?? 0;

  const livenessPassed =
    parsedResponse?.authenticated !== undefined
      ? (parsedResponse.liveness_score ?? 0) > 0.5
      : parsedResponse?.pipeline?.liveness?.passed ?? parsedResponse?.liveness_detected;

  const gatekeeperPassed =
    parsedResponse?.gatekeeper_score !== undefined
      ? parsedResponse.gatekeeper_score > 0.5
      : parsedResponse?.pipeline?.gatekeeper?.passed;

  const isAuthenticated =
    parsedResponse?.authenticated ??
    (parsedResponse?.result === "PASS");

  /* ── Status badge ────────────────────────────────── */
  const statusBadge = () => {
    if (status === "idle") return null;
    if (status === "loading")
      return <span className="flex items-center gap-1.5 text-xs font-medium text-neutral-400"><Loader2 className="h-3 w-3 animate-spin" /> Processing…</span>;
    const ok = status === "success";
    return (
      <span className={`flex items-center gap-1.5 text-xs font-medium ${ok ? "text-green-400" : "text-red-400"}`}>
        {ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
        {ok ? "200 OK" : "Error"}
        {latencyMs !== null && <span className="text-neutral-500">· {latencyMs} ms</span>}
      </span>
    );
  };

  /* ═══════════════════════════════════════════════════
     Render
  ════════════════════════════════════════════════════ */
  return (
    <div className="p-8 lg:p-10">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white">API Management</h1>
        <p className="mt-1.5 text-sm text-neutral-500">
          Manage production keys, run the live 2-step Challenge-Response verification
          flow, and grab integration code snippets.
        </p>
      </div>

      {/* Stats */}
      <div className="mb-8 grid gap-4 sm:grid-cols-3">
        {[
          { icon: Activity, label: "Total API Calls", value: "1,204,592" },
          { icon: Clock, label: "Average Latency", value: "420 ms" },
          { icon: Zap, label: "Uptime (30 d)", value: "99.98%" },
        ].map(({ icon: Icon, label, value }) => (
          <div key={label} className="rounded-xl border border-neutral-800 bg-neutral-900 p-6">
            <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-lg border border-neutral-800 bg-neutral-800/50 text-green-500">
              <Icon className="h-5 w-5" />
            </div>
            <p className="text-3xl font-bold text-white">{value}</p>
            <p className="mt-1 text-xs font-medium uppercase tracking-wider text-neutral-500">{label}</p>
          </div>
        ))}
      </div>

      {/* ══ API Key Manager ══════════════════════════════════ */}
      <div className="mb-8 rounded-xl border border-neutral-800 bg-neutral-900 p-6 sm:p-8">
        <div className="mb-1 flex items-center gap-2">
          <Key className="h-4 w-4 text-green-500" />
          <h2 className="text-sm font-semibold uppercase tracking-wider text-neutral-400">Production API Key</h2>
        </div>
        <p className="mb-5 text-xs text-neutral-600">
          Pass as{" "}
          <code className="rounded bg-neutral-800 px-1.5 py-0.5 font-mono text-green-400">Authorization: Bearer &lt;key&gt;</code>.
          Regenerate to rotate; revoke to deactivate immediately.
        </p>
        <div className="flex flex-col gap-3 sm:flex-row">
          <input
            type="text"
            value={keyRevoked ? "— No active key —" : apiKey}
            readOnly disabled
            className="flex-1 rounded-lg border border-neutral-800 bg-black px-4 py-3 font-mono text-sm text-neutral-400"
          />
          <div className="flex gap-2">
            <button
              onClick={handleCopyKey} disabled={keyRevoked}
              className={`inline-flex items-center gap-2 rounded-lg px-4 py-3 text-sm font-semibold transition-all disabled:opacity-40 disabled:cursor-not-allowed ${keyCopied ? "border border-green-500/30 bg-green-500/15 text-green-400" : "bg-green-500 text-black hover:bg-green-400"}`}
            >
              {keyCopied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              {keyCopied ? "Copied" : "Copy"}
            </button>
            <button
              onClick={() => { setApiKey(randomApiKey()); setKeyRevoked(false); }}
              className="inline-flex items-center gap-2 rounded-lg border border-neutral-700 bg-neutral-800 px-4 py-3 text-sm font-semibold text-neutral-300 transition-all hover:bg-neutral-700 hover:text-white"
            >
              <RefreshCw className="h-4 w-4" /> Regenerate
            </button>
            <button
              onClick={() => { setApiKey(""); setKeyRevoked(true); }} disabled={keyRevoked}
              className="inline-flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm font-semibold text-red-400 transition-all hover:bg-red-500/20 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Trash2 className="h-4 w-4" /> Revoke
            </button>
          </div>
        </div>
      </div>

      {/* ══ Interactive Sandbox ══════════════════════════════ */}
      <div className="mb-8 rounded-xl border border-neutral-800 bg-neutral-900 overflow-hidden">
        {/* Sandbox header */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-800 px-6 py-4">
          <div className="flex items-center gap-2">
            <Terminal className="h-4 w-4 text-green-500" />
            <h2 className="text-sm font-semibold uppercase tracking-wider text-neutral-400">
              Live Sandbox — Challenge-Response Pipeline
            </h2>
          </div>
          <div className="flex items-center gap-2">
            <span className="rounded-full border border-neutral-700 px-2.5 py-0.5 font-mono text-[10px] text-neutral-500">POST</span>
            <span className="font-mono text-xs text-green-400">/authenticate/verify</span>
          </div>
        </div>

        <div className="grid lg:grid-cols-2 divide-y lg:divide-y-0 lg:divide-x divide-neutral-800">
          {/* ── LEFT — Request ───────────────────────────── */}
          <div className="flex flex-col gap-5 p-6">
            {/* Input mode tabs */}
            <div className="flex rounded-lg border border-neutral-800 bg-black p-0.5">
              {([["form", "Form Data (Interactive)"], ["raw", "Raw JSON (Mock)"]] as [InputTab, string][]).map(([key, label]) => (
                <button
                  key={key} onClick={() => setInputTab(key)}
                  className={`flex-1 rounded-md px-3 py-2 text-xs font-semibold transition-all ${inputTab === key ? "bg-neutral-800 text-white" : "text-neutral-500 hover:text-neutral-300"}`}
                >
                  {label}
                </button>
              ))}
            </div>

            {/* ── FORM TAB ─────────────────────────────── */}
            {inputTab === "form" && (
              <div className="flex flex-col gap-5">

                {/* STEP 1 — Generate Challenge */}
                <div className="rounded-lg border border-neutral-800 bg-black/60 p-4">
                  <p className="mb-3 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-green-500">
                    <span className="flex h-5 w-5 items-center justify-center rounded-full border border-green-500/40 bg-green-500/10 text-[10px]">1</span>
                    Generate Challenge
                  </p>
                  <button
                    onClick={handleGenerateChallenge} disabled={challengeLoading}
                    className="mb-3 inline-flex items-center gap-2 rounded-lg border border-green-500/30 bg-green-500/10 px-4 py-2.5 text-xs font-semibold text-green-400 transition-all hover:bg-green-500/20 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {challengeLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                    {challengeLoading ? "Requesting…" : "Generate Challenge"}
                  </button>
                  {challengeError && (
                    <p className="mb-2 text-xs text-red-400">{challengeError}</p>
                  )}
                  {sessionId && challenge && (
                    <div className="flex flex-col gap-2">
                      <div className="rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2.5">
                        <p className="text-[10px] uppercase tracking-wider text-neutral-600">Session ID</p>
                        <p className="mt-0.5 font-mono text-xs text-neutral-400 break-all">{sessionId}</p>
                      </div>
                      <div className="flex items-center justify-between rounded-lg border border-amber-500/20 bg-amber-500/5 px-4 py-3">
                        <div>
                          <p className="text-[10px] uppercase tracking-wider text-amber-600">Say these digits out loud</p>
                          <p className="mt-1 font-mono text-2xl font-bold tracking-[0.3em] text-amber-400">
                            {challenge.join(" – ")}
                          </p>
                        </div>
                        <AlertTriangle className="h-5 w-5 text-amber-500/60 shrink-0" />
                      </div>
                    </div>
                  )}
                </div>

                {/* CNIC Input (shared between enroll + verify) */}
                <div>
                  <label className="mb-1 block text-[11px] uppercase tracking-wider text-neutral-500">Customer CNIC</label>
                  <input
                    type="text" placeholder="12345-1234567-1" value={cnic}
                    onChange={(e) => setCnic(formatCnicDisplay(e.target.value))}
                    className="w-full rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2.5 font-mono text-sm text-white placeholder:text-neutral-700 focus:border-green-500/50 focus:ring-1 focus:ring-green-500/20 focus:outline-none"
                  />
                </div>

                {/* STEP 1.5 — Quick Enroll */}
                <div className="rounded-lg border border-neutral-700/60 bg-black/60 p-4">
                  <p className="mb-1 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-neutral-400">
                    <span className="flex h-5 w-5 items-center justify-center rounded-full border border-neutral-700 bg-neutral-800 text-[10px]">1.5</span>
                    Quick Enroll — Baseline Voice
                  </p>
                  <p className="mb-4 text-[11px] text-neutral-600">
                    Record 3 short voice samples to create a biometric template for this CNIC. Required before verification.
                  </p>

                  <div className="flex flex-col gap-3 mb-4">
                    {takes.map((take, i) => (
                      <div key={i} className="flex items-center gap-3">
                        <span className="w-12 text-[11px] text-neutral-500 shrink-0">Take {i + 1}</span>
                        <button
                          onClick={take.recording ? take.stop : take.start}
                          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full border transition-all ${
                            take.recording
                              ? "border-red-500 bg-red-500/10 animate-pulse"
                              : take.blob
                              ? "border-green-500/50 bg-green-500/10"
                              : "border-neutral-700 bg-neutral-800 hover:border-green-500/40"
                          }`}
                        >
                          {take.recording ? (
                            <Square className="h-3 w-3 text-red-400" />
                          ) : take.blob ? (
                            <CheckCircle2 className="h-3.5 w-3.5 text-green-400" />
                          ) : (
                            <Mic className="h-3.5 w-3.5 text-neutral-400" />
                          )}
                        </button>
                        <span className="text-xs text-neutral-500">
                          {take.recording
                            ? <span className="text-red-400">Recording… {take.elapsed}s</span>
                            : take.blob
                            ? <span className="text-green-400">✓ {take.elapsed}s captured</span>
                            : "Click to record"}
                        </span>
                      </div>
                    ))}
                  </div>

                  <button
                    onClick={handleEnroll}
                    disabled={enrollLoading || !take1.blob || !take2.blob || !take3.blob}
                    className="inline-flex items-center gap-2 rounded-lg border border-neutral-700 bg-neutral-800 px-4 py-2.5 text-xs font-semibold text-neutral-300 transition-all hover:bg-neutral-700 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {enrollLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <BadgeCheck className="h-3.5 w-3.5" />}
                    {enrollLoading ? "Enrolling…" : "Submit Enrollment"}
                  </button>

                  {enrollStatus === "success" && (
                    <div className="mt-3 flex items-center gap-2 rounded-lg border border-green-500/30 bg-green-500/5 px-3 py-2.5">
                      <CheckCircle2 className="h-4 w-4 shrink-0 text-green-400" />
                      <p className="text-xs text-green-400">{enrollMsg}</p>
                    </div>
                  )}
                  {enrollStatus === "error" && (
                    <div className="mt-3 flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2.5">
                      <XCircle className="h-4 w-4 shrink-0 text-red-400" />
                      <p className="text-xs text-red-400">{enrollMsg}</p>
                    </div>
                  )}
                </div>

                {/* STEP 2 — Voice Response */}
                <div className="rounded-lg border border-neutral-800 bg-black/60 p-4">
                  <p className="mb-3 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-neutral-400">
                    <span className="flex h-5 w-5 items-center justify-center rounded-full border border-neutral-700 bg-neutral-800 text-[10px]">2</span>
                    Voice Response
                  </p>

                  {/* Audio mode toggle */}
                  <div className="mb-3 flex rounded-lg border border-neutral-800 bg-neutral-900 p-0.5">
                    {([["record", "Record Now", Mic], ["upload", "Upload File", Upload]] as [AudioMode, string, React.ElementType][]).map(([mode, label, Icon]) => (
                      <button
                        key={mode} onClick={() => setAudioMode(mode)}
                        className={`flex flex-1 items-center justify-center gap-1.5 rounded-md py-2 text-xs font-semibold transition-all ${audioMode === mode ? "bg-neutral-800 text-white" : "text-neutral-500 hover:text-neutral-300"}`}
                      >
                        <Icon className="h-3.5 w-3.5" />{label}
                      </button>
                    ))}
                  </div>

                  {audioMode === "record" ? (
                    <div className="flex flex-col items-center gap-3 rounded-lg border border-neutral-800 bg-neutral-900/50 px-4 py-5">
                      <button
                        onClick={verifyTake.recording ? verifyTake.stop : verifyTake.start}
                        className={`flex h-14 w-14 items-center justify-center rounded-full border-2 transition-all ${
                          verifyTake.recording
                            ? "border-red-500 bg-red-500/10 shadow-[0_0_20px_rgba(239,68,68,0.2)] animate-pulse"
                            : "border-green-500/50 bg-green-500/5 hover:border-green-400 hover:bg-green-500/10"
                        }`}
                      >
                        {verifyTake.recording ? <Square className="h-5 w-5 text-red-400" /> : <Mic className="h-5 w-5 text-green-400" />}
                      </button>
                      {verifyTake.recording ? (
                        <p className="text-xs font-mono text-red-400">Recording… {verifyTake.elapsed}s — click to stop</p>
                      ) : verifyTake.blob ? (
                        <p className="text-xs text-green-400">✓ {verifyTake.elapsed}s recorded — click to re-record</p>
                      ) : (
                        <p className="text-xs text-neutral-500">Say the challenge digits, then click mic</p>
                      )}
                    </div>
                  ) : (
                    <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-neutral-700 bg-neutral-900/50 px-4 py-5 text-xs text-neutral-500 transition-all hover:border-green-500/40 hover:text-neutral-300">
                      <Upload className="h-5 w-5" />
                      {audioFile ? <span className="text-green-400">{audioFile.name}</span> : "Click to choose audio file"}
                      <input type="file" accept="audio/*" className="sr-only" onChange={(e) => setAudioFile(e.target.files?.[0] ?? null)} />
                    </label>
                  )}
                </div>
              </div>
            )}

            {/* ── RAW JSON TAB ─────────────────────────── */}
            {inputTab === "raw" && (
              <div className="flex flex-col gap-2">
                <label className="text-[11px] uppercase tracking-wider text-neutral-500">
                  Request Body — sent to mock <code className="text-green-400">/api/v1/verify</code>
                </label>
                <textarea
                  value={rawPayload} onChange={(e) => { setRawPayload(e.target.value); try { JSON.parse(e.target.value); setRawError(""); } catch { setRawError("Invalid JSON"); } }}
                  rows={14} spellCheck={false}
                  className={`w-full rounded-lg border bg-black px-4 py-3 font-mono text-sm text-white resize-none transition-all focus:outline-none focus:ring-1 ${rawError ? "border-red-500/50 focus:ring-red-500/20" : "border-neutral-800 focus:border-green-500/50 focus:ring-green-500/20"}`}
                />
                {rawError && <p className="text-xs text-red-400">{rawError}</p>}
              </div>
            )}

            {/* Send button */}
            <button
              onClick={handleSend} disabled={!canSend}
              className="group flex items-center justify-center gap-2 rounded-lg bg-green-500 px-4 py-3 text-sm font-semibold text-black transition-all hover:bg-green-400 hover:shadow-[0_0_24px_rgba(34,197,94,0.3)] disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {status === "loading" ? (
                <><Loader2 className="h-4 w-4 animate-spin" /> Sending…</>
              ) : (
                <><Send className="h-4 w-4 transition-transform group-hover:translate-x-0.5" /> Send for Verification</>
              )}
            </button>
          </div>

          {/* ── RIGHT — Response ─────────────────────────── */}
          <div className="flex flex-col gap-4 p-6">
            <div className="flex items-center justify-between">
              <label className="text-[11px] uppercase tracking-wider text-neutral-500">Response</label>
              <div className="flex items-center gap-3">
                {statusBadge()}
                {responseJson && (
                  <button
                    onClick={() => { navigator.clipboard.writeText(responseJson).catch(() => {}); setRespCopied(true); setTimeout(() => setRespCopied(false), 2000); }}
                    className="flex items-center gap-1 text-xs text-neutral-500 hover:text-neutral-300 transition-colors"
                  >
                    {respCopied ? <Check className="h-3 w-3 text-green-400" /> : <Copy className="h-3 w-3" />}
                    {respCopied ? "Copied" : "Copy"}
                  </button>
                )}
              </div>
            </div>

            {/* JSON block */}
            <div className="relative min-h-[200px] rounded-lg border border-neutral-800 bg-black overflow-auto">
              {status === "idle" && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-neutral-700">
                  <ChevronRight className="h-6 w-6" />
                  <p className="text-xs text-center px-4">Generate a challenge → record response → send for verification</p>
                </div>
              )}
              {status === "loading" && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-neutral-500">
                  <Loader2 className="h-6 w-6 animate-spin text-green-500" />
                  <p className="text-xs">ML pipeline processing…</p>
                </div>
              )}
              {responseJson && status !== "loading" && (
                <pre className="p-4 text-xs font-mono leading-6 overflow-auto" dangerouslySetInnerHTML={{ __html: colorizedHtml }} />
              )}
            </div>

            {/* Verification Metrics */}
            {parsedResponse && status === "success" && (
              <div className="rounded-lg border border-neutral-800 bg-black overflow-hidden">
                <div className="border-b border-neutral-800 px-4 py-2.5">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-neutral-500">Verification Metrics</p>
                </div>
                <div className="divide-y divide-neutral-800/60">
                  {/* Biometric */}
                  <div className="grid grid-cols-[1fr_2fr] items-center gap-4 px-4 py-3">
                    <div className="flex items-center gap-2">
                      <Fingerprint className="h-4 w-4 shrink-0 text-neutral-500" />
                      <span className="text-xs text-neutral-400">Biometric</span>
                    </div>
                    <ConfidenceBar score={biometricScore} />
                  </div>
                  {/* Liveness */}
                  <div className="grid grid-cols-[1fr_2fr] items-center gap-4 px-4 py-3">
                    <div className="flex items-center gap-2">
                      <Eye className="h-4 w-4 shrink-0 text-neutral-500" />
                      <span className="text-xs text-neutral-400">Liveness</span>
                    </div>
                    <div className="flex items-center gap-3">
                      <PassBadge passed={livenessPassed} />
                      {parsedResponse.liveness_score !== undefined && (
                        <span className="text-[10px] text-neutral-600">{Math.round((parsedResponse.liveness_score) * 100)}% confidence</span>
                      )}
                    </div>
                  </div>
                  {/* Gatekeeper */}
                  <div className="grid grid-cols-[1fr_2fr] items-center gap-4 px-4 py-3">
                    <div className="flex items-center gap-2">
                      <ShieldCheck className="h-4 w-4 shrink-0 text-neutral-500" />
                      <span className="text-xs text-neutral-400">Gatekeeper</span>
                    </div>
                    <div className="flex items-center gap-3">
                      <PassBadge passed={gatekeeperPassed} />
                      {parsedResponse.gatekeeper_score !== undefined && (
                        <span className="text-[10px] text-neutral-600">score {parsedResponse.gatekeeper_score.toFixed(2)}</span>
                      )}
                    </div>
                  </div>
                  {/* Risk */}
                  {parsedResponse.risk_score !== undefined && (
                    <div className="grid grid-cols-[1fr_2fr] items-center gap-4 px-4 py-3">
                      <div className="flex items-center gap-2">
                        <AlertTriangle className="h-4 w-4 shrink-0 text-neutral-500" />
                        <span className="text-xs text-neutral-400">Risk Score</span>
                      </div>
                      <ConfidenceBar score={1 - parsedResponse.risk_score} />
                    </div>
                  )}
                  {/* Verdict */}
                  <div className="grid grid-cols-[1fr_2fr] items-center gap-4 bg-neutral-900/50 px-4 py-3">
                    <div className="flex items-center gap-2">
                      <Activity className="h-4 w-4 shrink-0 text-neutral-500" />
                      <span className="text-xs font-semibold text-neutral-300">Verdict</span>
                    </div>
                    {isAuthenticated ? (
                      <span className="inline-flex items-center gap-1.5 rounded-full border border-green-500/30 bg-green-500/10 px-3 py-1 text-xs font-bold text-green-400">
                        <CheckCircle2 className="h-3.5 w-3.5" /> AUTHENTICATED
                      </span>
                    ) : (
                      <div className="flex flex-col gap-1">
                        <span className="inline-flex items-center gap-1.5 rounded-full border border-red-500/30 bg-red-500/10 px-3 py-1 text-xs font-bold text-red-400 w-fit">
                          <XCircle className="h-3.5 w-3.5" /> REJECTED
                        </span>
                        {parsedResponse.message && (
                          <p className="text-[10px] text-neutral-600 leading-relaxed">{parsedResponse.message}</p>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ══ Code Snippets ════════════════════════════════════ */}
      <div className="mb-8 rounded-xl border border-neutral-800 bg-neutral-900 overflow-hidden">
        <div className="flex items-center justify-between border-b border-neutral-800 px-6 py-4">
          <div className="flex items-center gap-2">
            <Code2 className="h-4 w-4 text-green-500" />
            <h2 className="text-sm font-semibold uppercase tracking-wider text-neutral-400">Integration Examples</h2>
          </div>
          <button
            onClick={() => navigator.clipboard.writeText(SNIPPETS[codeTab]).catch(() => {})}
            className="flex items-center gap-1.5 rounded-lg border border-neutral-800 bg-neutral-800/50 px-3 py-1.5 text-xs text-neutral-400 hover:text-white transition-colors"
          >
            <Copy className="h-3 w-3" /> Copy
          </button>
        </div>
        <div className="flex gap-0 border-b border-neutral-800 px-6">
          {(Object.keys(SNIPPETS) as TabKey[]).map((tab) => (
            <button
              key={tab} onClick={() => setCodeTab(tab)}
              className={`relative pb-3 pt-3 px-4 text-xs font-medium transition-colors ${codeTab === tab ? "text-green-400" : "text-neutral-500 hover:text-neutral-300"}`}
            >
              {{ curl: "cURL", python: "Python", node: "Node.js" }[tab]}
              {codeTab === tab && <span className="absolute bottom-0 left-0 right-0 h-px bg-green-500" />}
            </button>
          ))}
        </div>
        <pre className="overflow-x-auto p-6 font-mono text-xs text-neutral-300 leading-6 whitespace-pre">{SNIPPETS[codeTab]}</pre>
      </div>

      {/* ══ Webhooks ═════════════════════════════════════════ */}
      <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-6 sm:p-8">
        <div className="mb-1 flex items-center gap-2">
          <Globe className="h-4 w-4 text-green-500" />
          <h2 className="text-sm font-semibold uppercase tracking-wider text-neutral-400">Webhook Endpoints</h2>
        </div>
        <p className="mb-5 text-xs text-neutral-600">Receive real-time POST notifications when verification events occur.</p>
        <div>
          <label htmlFor="webhook" className="mb-2 block text-xs font-medium uppercase tracking-wider text-neutral-500">Primary Callback URL</label>
          <div className="flex gap-3">
            <div className="relative flex-1">
              <Globe className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-600" />
              <input
                id="webhook" type="url"
                placeholder="https://api.yourdomain.com/awaaz-callback"
                value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)}
                className="w-full rounded-lg border border-neutral-800 bg-black px-4 py-3 pl-11 text-sm text-white transition-all placeholder:text-neutral-600 focus:border-green-500/50 focus:ring-1 focus:ring-green-500/20"
              />
            </div>
            <button className="inline-flex items-center gap-2 rounded-lg bg-green-500 px-5 py-3 text-sm font-semibold text-black transition-all hover:bg-green-400">
              <Save className="h-4 w-4" /> Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
