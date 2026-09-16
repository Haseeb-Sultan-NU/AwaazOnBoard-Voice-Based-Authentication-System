import Link from "next/link";
import Image from "next/image";
import {
  ArrowRight,
  Fingerprint,
  Mic,
  Lock,
  Zap,
  Globe,
  Server,
} from "lucide-react";

export default function HomePage() {
  return (
    <div className="relative min-h-[calc(100vh-4rem)] grid-bg">
      {/* ── Ambient Glow ─────────────────────────────────────── */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -top-40 left-1/2 h-[500px] w-[800px] -translate-x-1/2 rounded-full bg-green-500/5 blur-[120px]" />
      </div>

      {/* ── Hero Section ─────────────────────────────────────── */}
      <section className="relative mx-auto flex max-w-7xl flex-col-reverse items-center gap-16 px-6 pt-20 pb-32 lg:flex-row lg:gap-20 lg:pt-32">
        {/* Left Column — Copy */}
        <div className="flex max-w-xl flex-1 flex-col items-center text-center lg:items-start lg:text-left">
          {/* Heading */}
          <h1 className="text-4xl font-bold leading-tight tracking-tight text-white sm:text-5xl lg:text-6xl">
            Voice Authentication{" "}
            <span className="text-green-500 glow-green-text">
              Built for the Real&nbsp;World
            </span>
          </h1>

          {/* Subtext */}
          <p className="mt-6 max-w-lg text-base leading-relaxed text-neutral-400 sm:text-lg">
            Secure your telephony pipelines with state-of-the-art ECAPA-TDNN
            speaker verification, active liveness detection, and real-time
            fraud scoring — all from a single API call.
          </p>

          {/* CTA Buttons */}
          <div className="mt-10 flex flex-col gap-3 sm:flex-row">
            <Link
              href="/playground"
              className="group inline-flex items-center justify-center gap-2 rounded-lg bg-green-500 px-6 py-3 text-sm font-semibold text-black transition-all hover:bg-green-400 hover:shadow-[0_0_24px_rgba(34,197,94,0.3)]"
            >
              Try the Live Demo
              <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
            </Link>
            <Link
              href="/login"
              className="inline-flex items-center justify-center gap-2 rounded-lg border border-neutral-700 bg-transparent px-6 py-3 text-sm font-semibold text-neutral-300 transition-all hover:border-neutral-500 hover:text-white"
            >
              Enterprise Console
            </Link>
          </div>

          {/* Trust Line */}
          <p className="mt-8 text-xs text-neutral-600">
            No credit card required · SOC-2 compliant · 99.97% uptime SLA
          </p>
        </div>

        {/* Right Column — Hero Graphic in Arched Pill Container */}
        <div className="flex flex-1 items-center justify-center">
          <div className="relative h-[360px] w-full max-w-sm sm:h-[420px] lg:h-[520px] lg:max-w-md">
            {/* Outer glow behind the pill */}
            <div className="pointer-events-none absolute inset-0 rounded-[60px] bg-green-500/5 blur-[60px]" />

            {/* Pill container */}
            <div className="relative flex h-full w-full items-center justify-center overflow-hidden rounded-[60px] border border-green-500/20 bg-neutral-900/30">
              {/* Inner ambient radial glow */}
              <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,_rgba(34,197,94,0.08)_0%,_transparent_70%)]" />

              {/* Hero graphic */}
              <Image
                src="/hero-graphic.png"
                alt="AwaazOnboard neural voice biometric visualization"
                fill
                className="object-contain mix-blend-screen p-4"
                priority
              />
            </div>
          </div>
        </div>
      </section>

      {/* ── Features Grid ────────────────────────────────────── */}
      <section className="relative mx-auto max-w-7xl px-6 pb-32">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <FeatureCard
            icon={<Mic className="h-5 w-5" />}
            title="Active Liveness Detection"
            description="Dynamic numeric challenge-response system with Urdu ASR transcription to defeat replay and synthesis attacks."
          />
          <FeatureCard
            icon={<Lock className="h-5 w-5" />}
            title="Coercion Detection"
            description="Pyannote-powered diarization detects multiple speakers, audio splicing, and under-duress scenarios in real-time."
          />
          <FeatureCard
            icon={<Fingerprint className="h-5 w-5" />}
            title="ECAPA-TDNN Verification"
            description="Fine-tuned 192-dim speaker embeddings with multi-template enrollment for telephony-grade biometric matching."
          />
          <FeatureCard
            icon={<Zap className="h-5 w-5" />}
            title="Sub-Second Inference"
            description="Full 3-stage verification pipeline (Gatekeeper → ASR → ECAPA) executes in under 800ms on consumer GPUs."
          />
          <FeatureCard
            icon={<Globe className="h-5 w-5" />}
            title="Urdu-First Design"
            description="Purpose-built for South Asian telephony. Whisper-based ASR with Urdu digit recognition out of the box."
          />
          <FeatureCard
            icon={<Server className="h-5 w-5" />}
            title="Single API Endpoint"
            description="One POST request handles challenge generation, audio processing, liveness, and biometric verification."
          />
        </div>
      </section>
    </div>
  );
}

/* ── Feature Card Component ──────────────────────────────────── */

function FeatureCard({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div className="group rounded-xl border border-neutral-800 bg-neutral-900/50 p-6 transition-all hover:border-neutral-700 hover:bg-neutral-900">
      <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg border border-neutral-800 bg-neutral-800/50 text-green-500 transition-colors group-hover:border-green-500/30 group-hover:bg-green-500/10">
        {icon}
      </div>
      <h3 className="text-sm font-semibold text-white">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-neutral-500">
        {description}
      </p>
    </div>
  );
}
