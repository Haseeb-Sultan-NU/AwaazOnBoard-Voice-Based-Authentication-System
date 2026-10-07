"use client";

import Link from "next/link";
import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import {
  FileText,
  LogIn,
  LogOut,
  User,
  Settings,
  ChevronDown,
} from "lucide-react";

interface AwaazUser {
  cnic?: string;
  user_id?: string;
  full_name?: string;
}

export function Navbar() {
  const router = useRouter();
  const pathname = usePathname();
  const [user, setUser] = useState<AwaazUser | null>(null);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      const stored = localStorage.getItem("awaaz_user");
      if (stored) setUser(JSON.parse(stored));
    } catch {
      // Invalid JSON or no storage
    }
  }, [pathname]);

  /* Close dropdown on route change */
  useEffect(() => {
    setDropdownOpen(false);
  }, [pathname]);

  /* Close dropdown on outside click */
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node)
      ) {
        setDropdownOpen(false);
      }
    }
    if (dropdownOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [dropdownOpen]);

  const handleSignOut = async () => {
    try {
      await fetch("/api/logout", { method: "POST" });
    } catch {
      // Still clear local state even if backend is unreachable
    }
    localStorage.removeItem("awaaz_user");
    setUser(null);
    setDropdownOpen(false);
    router.push("/login");
  };

  const displayName = user?.full_name || user?.cnic || "Account";

  return (
    <nav className="sticky top-0 z-50 w-full border-b border-neutral-800/60 bg-black/80 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-6">
        {/* Left — Logo */}
        <Link href="/" className="flex items-center gap-3 group">
          <Image
            src="/logo.png"
            alt="AwaazOnboard Logo"
            width={32}
            height={64}
            className="h-10 w-auto object-contain"
            priority
          />
          <span className="text-sm font-semibold tracking-widest text-white uppercase">
            AwaazOnboard
          </span>
        </Link>

        {/* Right — Nav Links */}
        <div className="flex items-center gap-1">
          <Link
            href="/docs"
            className="flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm text-neutral-400 transition-colors hover:text-white hover:bg-neutral-900"
          >
            <FileText className="h-4 w-4" />
            <span className="hidden sm:inline">Documentation</span>
          </Link>

          {user ? (
            /* ── Profile Dropdown ──────────────────────────── */
            <div className="relative" ref={dropdownRef}>
              <button
                onClick={() => setDropdownOpen((prev) => !prev)}
                className={`flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm transition-colors ${dropdownOpen
                  ? "bg-neutral-800 text-white"
                  : "text-neutral-400 hover:text-white hover:bg-neutral-900"
                  }`}
              >
                {/* Avatar circle */}
                <div className="flex h-6 w-6 items-center justify-center rounded-full bg-green-500/15 border border-green-500/30">
                  <User className="h-3 w-3 text-green-400" />
                </div>
                <span className="hidden sm:inline max-w-[120px] truncate">
                  {displayName}
                </span>
                <ChevronDown
                  className={`h-3.5 w-3.5 text-neutral-500 transition-transform duration-200 ${dropdownOpen ? "rotate-180" : ""
                    }`}
                />
              </button>

              {/* Dropdown Menu */}
              {dropdownOpen && (
                <div className="absolute right-0 mt-2 w-56 origin-top-right animate-in fade-in slide-in-from-top-1 duration-150 rounded-xl border border-neutral-800 bg-neutral-900 p-1.5 shadow-2xl shadow-black/50">
                  {/* User Info Header */}
                  <div className="mb-1.5 border-b border-neutral-800 px-3 py-2.5">
                    <p className="text-sm font-medium text-white truncate">
                      {user.full_name || "User"}
                    </p>
                    <p className="mt-0.5 text-xs text-neutral-500 font-mono">
                      {user.cnic || user.user_id || "—"}
                    </p>
                  </div>

                  {/* Menu Items */}
                  <Link
                    href="/console/settings"
                    onClick={() => setDropdownOpen(false)}
                    className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-white"
                  >
                    <Settings className="h-4 w-4 text-neutral-500" />
                    Account Settings
                  </Link>

                  <button
                    onClick={handleSignOut}
                    className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-neutral-400 transition-colors hover:bg-red-500/10 hover:text-red-400"
                  >
                    <LogOut className="h-4 w-4 text-neutral-500" />
                    Sign Out
                  </button>
                </div>
              )}
            </div>
          ) : (
            <Link
              href="/login"
              className="flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm text-neutral-400 transition-colors hover:text-white hover:bg-neutral-900"
            >
              <LogIn className="h-4 w-4" />
              <span className="hidden sm:inline">Sign In</span>
            </Link>
          )}
        </div>
      </div>
    </nav>
  );
}
