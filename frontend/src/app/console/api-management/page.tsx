"use client";

import { useState } from "react";
import { Activity, Clock, Key, Copy, Globe, Save, Check } from "lucide-react";

export default function ApiManagementPage() {
  const [copied, setCopied] = useState(false);
  const [webhookUrl, setWebhookUrl] = useState("");

  const apiKey = "ak_live_*******************3f2d";

  const handleCopy = () => {
    navigator.clipboard.writeText(apiKey).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="p-8 lg:p-10">
      {/* ── Header ─────────────────────────────────────────── */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white">API Management</h1>
        <p className="mt-1.5 text-sm text-neutral-500">
          Manage your production keys, monitor usage, and configure webhooks
        </p>
      </div>

      {/* ── Top Stats ──────────────────────────────────────── */}
      <div className="mb-8 grid gap-4 sm:grid-cols-2">
        <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-6">
          <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-lg border border-neutral-800 bg-neutral-800/50 text-green-500">
            <Activity className="h-5 w-5" />
          </div>
          <p className="text-3xl font-bold text-white">1,204,592</p>
          <p className="mt-1 text-xs font-medium uppercase tracking-wider text-neutral-500">
            Total API Calls
          </p>
        </div>
        <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-6">
          <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-lg border border-neutral-800 bg-neutral-800/50 text-green-500">
            <Clock className="h-5 w-5" />
          </div>
          <p className="text-3xl font-bold text-white">420<span className="text-lg text-neutral-500">ms</span></p>
          <p className="mt-1 text-xs font-medium uppercase tracking-wider text-neutral-500">
            Average Latency
          </p>
        </div>
      </div>

      {/* ── Production Keys ────────────────────────────────── */}
      <div className="mb-8 rounded-xl border border-neutral-800 bg-neutral-900 p-6 sm:p-8">
        <div className="mb-1 flex items-center gap-2">
          <Key className="h-4 w-4 text-green-500" />
          <h2 className="text-sm font-semibold uppercase tracking-wider text-neutral-400">
            Production API Key
          </h2>
        </div>
        <p className="mb-5 text-xs text-neutral-600">
          Use this key to authenticate requests to the AwaazOnboard API.
        </p>

        <div className="flex gap-3">
          <input
            type="text"
            value={apiKey}
            readOnly
            disabled
            className="flex-1 rounded-lg border border-neutral-800 bg-black px-4 py-3 font-mono text-sm text-neutral-400 selection:bg-green-500/20"
          />
          <button
            onClick={handleCopy}
            className={`inline-flex items-center gap-2 rounded-lg px-5 py-3 text-sm font-semibold transition-all ${
              copied
                ? "bg-green-500/15 text-green-400 border border-green-500/30"
                : "bg-green-500 text-black hover:bg-green-400 hover:shadow-[0_0_20px_rgba(34,197,94,0.25)]"
            }`}
          >
            {copied ? (
              <>
                <Check className="h-4 w-4" />
                Copied
              </>
            ) : (
              <>
                <Copy className="h-4 w-4" />
                Copy
              </>
            )}
          </button>
        </div>
      </div>

      {/* ── Webhooks ───────────────────────────────────────── */}
      <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-6 sm:p-8">
        <div className="mb-1 flex items-center gap-2">
          <Globe className="h-4 w-4 text-green-500" />
          <h2 className="text-sm font-semibold uppercase tracking-wider text-neutral-400">
            Webhook Endpoints
          </h2>
        </div>
        <p className="mb-5 text-xs text-neutral-600">
          Receive real-time POST notifications when verification events occur.
        </p>

        <div>
          <label
            htmlFor="webhook"
            className="mb-2 block text-xs font-medium uppercase tracking-wider text-neutral-500"
          >
            Primary Callback URL
          </label>
          <div className="flex gap-3">
            <div className="relative flex-1">
              <Globe className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-600" />
              <input
                id="webhook"
                type="url"
                placeholder="https://api.yourdomain.com/awaaz-callback"
                value={webhookUrl}
                onChange={(e) => setWebhookUrl(e.target.value)}
                className="w-full rounded-lg border border-neutral-800 bg-black px-4 py-3 pl-11 text-sm text-white transition-all placeholder:text-neutral-600 focus:border-green-500/50 focus:ring-1 focus:ring-green-500/20"
              />
            </div>
            <button className="inline-flex items-center gap-2 rounded-lg bg-green-500 px-5 py-3 text-sm font-semibold text-black transition-all hover:bg-green-400 hover:shadow-[0_0_20px_rgba(34,197,94,0.25)]">
              <Save className="h-4 w-4" />
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
