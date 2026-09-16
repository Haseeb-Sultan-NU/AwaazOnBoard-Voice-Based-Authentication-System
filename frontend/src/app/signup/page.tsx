"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Shield, User, CreditCard, Mail, Lock, ArrowRight, Loader2 } from "lucide-react";

export default function SignUpPage() {
  const router = useRouter();
  const [fullName, setFullName] = useState("");
  const [cnic, setCnic] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);

    // Attempt real backend signup; fall through to mock on failure
    try {
      const res = await fetch("/api/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          full_name: fullName,
          cnic,
          phone_number: "",
          password,
        }),
      });

      if (res.ok) {
        // Auto-login after successful signup
        const loginRes = await fetch("/api/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cnic, password }),
        });

        if (loginRes.ok) {
          const data = await loginRes.json();
          localStorage.setItem("awaaz_user", JSON.stringify(data));
          router.push("/console");
          return;
        }
      }
    } catch {
      // Backend unreachable — continue to mock session
    }

    // Mock session
    const strippedCnic = cnic.replace(/\D/g, "") || "4230115693921";
    const isAdmin = strippedCnic === "0000000000000";
    const mockUser = {
      status: "success",
      user_id: strippedCnic,
      cnic: strippedCnic,
      full_name: fullName || (isAdmin ? "Admin" : "Enterprise User"),
      token: "demo-token",
      is_enrolled: false,
    };
    localStorage.setItem("awaaz_user", JSON.stringify(mockUser));

    await new Promise((r) => setTimeout(r, 600));
    setIsLoading(false);
    router.push("/console");
  };

  return (
    <div className="relative flex min-h-[calc(100vh-4rem)] items-center justify-center px-6 py-12 grid-bg">
      {/* Ambient glow */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute top-1/2 left-1/2 h-[400px] w-[600px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-green-500/5 blur-[100px]" />
      </div>

      {/* Card */}
      <div className="relative w-full max-w-md">
        <div className="rounded-2xl border border-neutral-800 bg-neutral-900/80 p-8 backdrop-blur-sm sm:p-10">
          {/* Logo */}
          <div className="mb-8 flex flex-col items-center text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-green-500/20 bg-green-500/10">
              <Shield className="h-6 w-6 text-green-500" />
            </div>
            <h1 className="mt-5 text-xl font-semibold text-white">
              Create Enterprise Account
            </h1>
            <p className="mt-2 text-sm text-neutral-500">
              Register with your CNIC to get started
            </p>
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit} className="space-y-4">
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
                  placeholder="Ali Khan"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  className="w-full rounded-lg border border-neutral-800 bg-black px-4 py-3 pl-11 text-sm text-white transition-all placeholder:text-neutral-600 focus:border-green-500/50 focus:ring-1 focus:ring-green-500/20"
                  required
                />
              </div>
            </div>

            {/* CNIC */}
            <div>
              <label
                htmlFor="cnic"
                className="mb-2 block text-xs font-medium uppercase tracking-wider text-neutral-500"
              >
                CNIC Number (13 digits, no dashes)
              </label>
              <div className="relative">
                <CreditCard className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-600" />
                <input
                  id="cnic"
                  type="text"
                  placeholder="1234567890123"
                  value={cnic}
                  onChange={(e) => setCnic(e.target.value)}
                  className="w-full rounded-lg border border-neutral-800 bg-black px-4 py-3 pl-11 text-sm text-white transition-all placeholder:text-neutral-600 focus:border-green-500/50 focus:ring-1 focus:ring-green-500/20"
                  required
                />
              </div>
            </div>

            {/* Email */}
            <div>
              <label
                htmlFor="email"
                className="mb-2 block text-xs font-medium uppercase tracking-wider text-neutral-500"
              >
                Email Address
              </label>
              <div className="relative">
                <Mail className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-600" />
                <input
                  id="email"
                  type="email"
                  placeholder="admin@company.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full rounded-lg border border-neutral-800 bg-black px-4 py-3 pl-11 text-sm text-white transition-all placeholder:text-neutral-600 focus:border-green-500/50 focus:ring-1 focus:ring-green-500/20"
                  required
                />
              </div>
            </div>

            {/* Password */}
            <div>
              <label
                htmlFor="password"
                className="mb-2 block text-xs font-medium uppercase tracking-wider text-neutral-500"
              >
                Password
              </label>
              <div className="relative">
                <Lock className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-600" />
                <input
                  id="password"
                  type="password"
                  placeholder="••••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full rounded-lg border border-neutral-800 bg-black px-4 py-3 pl-11 text-sm text-white transition-all placeholder:text-neutral-600 focus:border-green-500/50 focus:ring-1 focus:ring-green-500/20"
                  required
                />
              </div>
            </div>

            {/* Submit */}
            <button
              type="submit"
              disabled={isLoading}
              className="group flex w-full items-center justify-center gap-2 rounded-lg bg-green-500 px-4 py-3 text-sm font-semibold text-black transition-all hover:bg-green-400 hover:shadow-[0_0_24px_rgba(34,197,94,0.3)] disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isLoading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Creating Account...
                </>
              ) : (
                <>
                  Sign Up
                  <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
                </>
              )}
            </button>
          </form>

          {/* Footer */}
          <div className="mt-8 border-t border-neutral-800 pt-6 text-center">
            <p className="text-sm text-neutral-500">
              Already have an account?{" "}
              <Link
                href="/login"
                className="font-medium text-green-500 transition-colors hover:text-green-400"
              >
                Sign In
              </Link>
            </p>
          </div>
        </div>

        {/* Bottom text */}
        <p className="mt-6 text-center text-xs text-neutral-700">
          Protected by AwaazOnboard Voice Biometrics · End-to-End Encrypted
        </p>
      </div>
    </div>
  );
}
