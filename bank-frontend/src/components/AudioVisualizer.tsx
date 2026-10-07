"use client";

import { useEffect, useRef } from "react";

type AudioVisualizerProps = {
  /** Live microphone stream. Pass null to render nothing and release all audio resources. */
  stream: MediaStream | null;
  /** Number of bars across the full width (mirrored around the centre). */
  bars?: number;
  className?: string;
};

// Palette: Tailwind emerald-500 / emerald-300 / teal-300, matching the dashboard.
const EMERALD_500 = "#10b981";
const EMERALD_300 = "#6ee7b7";
const TEAL_300 = "#5eead4";

// Speech energy lives roughly between 80 Hz and 5 kHz; bars outside that band
// would sit flat and make the visual look dead.
const MIN_HZ = 80;
const MAX_HZ = 5000;

type WebkitWindow = Window & { webkitAudioContext?: typeof AudioContext };

/**
 * Real-time mirrored EQ visualiser driven by the Web Audio API.
 *
 * MediaStream → MediaStreamAudioSourceNode → AnalyserNode (never connected to
 * the speakers, so the user doesn't hear their own mic) → canvas via rAF.
 */
export default function AudioVisualizer({ stream, bars = 48, className = "" }: AudioVisualizerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const live = stream?.getAudioTracks().some((t) => t.readyState === "live");
    if (!canvas || !stream || !live) return;

    const Ctx = window.AudioContext ?? (window as WebkitWindow).webkitAudioContext;
    if (!Ctx) return;

    const audioCtx = new Ctx();
    void audioCtx.resume(); // may start "suspended" under autoplay policy

    const source = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.75;
    analyser.minDecibels = -90;
    analyser.maxDecibels = -20;
    source.connect(analyser);

    const freq = new Uint8Array(analyser.frequencyBinCount);
    const g = canvas.getContext("2d");
    if (!g) {
      source.disconnect();
      void audioCtx.close();
      return;
    }

    // Map each half-bar to a log-spaced frequency band so low and high speech
    // formants get equal visual weight.
    const half = Math.max(4, Math.floor(bars / 2));
    const binHz = audioCtx.sampleRate / analyser.fftSize;
    const bands = Array.from({ length: half }, (_, i) => {
      const lo = MIN_HZ * Math.pow(MAX_HZ / MIN_HZ, i / half);
      const hi = MIN_HZ * Math.pow(MAX_HZ / MIN_HZ, (i + 1) / half);
      const a = Math.max(1, Math.floor(lo / binHz));
      const b = Math.min(freq.length - 1, Math.max(a + 1, Math.ceil(hi / binHz)));
      return [a, b] as const;
    });
    const levels = new Float32Array(half); // eased 0..1 per band

    // Keep the backing store crisp on HiDPI and responsive to layout changes.
    let width = 0;
    let height = 0;
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    let raf = 0;
    let running = true;

    const draw = () => {
      if (!running) return;
      raf = requestAnimationFrame(draw);

      analyser.getByteFrequencyData(freq);
      g.clearRect(0, 0, width, height);

      const total = half * 2;
      const slot = width / total;
      const barW = Math.max(2, slot * 0.55);
      const mid = height / 2;
      const maxH = height * 0.92;

      const grad = g.createLinearGradient(0, mid - maxH / 2, 0, mid + maxH / 2);
      grad.addColorStop(0, TEAL_300);
      grad.addColorStop(0.5, EMERALD_300);
      grad.addColorStop(1, EMERALD_500);
      g.fillStyle = grad;
      g.shadowColor = EMERALD_500;
      g.shadowBlur = 14;

      for (let i = 0; i < half; i++) {
        const [a, b] = bands[i];
        let peak = 0;
        for (let k = a; k <= b; k++) peak = Math.max(peak, freq[k]);
        const target = Math.pow(peak / 255, 1.4);
        // Fast attack, slow release → lively but never jittery.
        levels[i] += (target - levels[i]) * (target > levels[i] ? 0.55 : 0.12);

        const h = Math.max(3, levels[i] * maxH);
        const r = Math.min(barW / 2, h / 2);
        // Lowest band in the centre, mirrored outwards.
        for (const side of [-1, 1]) {
          const idx = side < 0 ? half - 1 - i : half + i;
          const x = idx * slot + (slot - barW) / 2;
          g.beginPath();
          g.roundRect(x, mid - h / 2, barW, h, r);
          g.fill();
        }
      }
    };
    raf = requestAnimationFrame(draw);

    // Stop drawing as soon as the mic is released, even before the parent unmounts us.
    const tracks = stream.getAudioTracks();
    const onEnded = () => {
      running = false;
      cancelAnimationFrame(raf);
    };
    tracks.forEach((t) => t.addEventListener("ended", onEnded));

    return () => {
      running = false;
      cancelAnimationFrame(raf);
      tracks.forEach((t) => t.removeEventListener("ended", onEnded));
      ro.disconnect();
      source.disconnect();
      analyser.disconnect();
      void audioCtx.close();
    };
  }, [stream, bars]);

  if (!stream) return null;

  return (
    <canvas
      ref={canvasRef}
      role="img"
      aria-label="Live microphone level"
      className={`block h-16 w-full ${className}`}
    />
  );
}
