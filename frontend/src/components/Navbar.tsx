"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { Shield, FileText, LogIn, LogOut, User } from "lucide-react";

interface AwaazUser {
  cnic?: string;
  user_id?: string;
  full_name?: string;
}

export function Navbar() {
  const router = useRouter();
  const pathname = usePathname();
  const [user, setUser] = useState<AwaazUser | null>(null);

  useEffect(() => {
    try {
      const stored = localStorage.getItem("awaaz_user");
      if (stored) setUser(JSON.parse(stored));
    } catch {
      // Invalid JSON or no storage
    }
  }, [pathname]);

  const handleSignOut = () => {
    localStorage.clear();
    setUser(null);
    router.push("/login");
  };

  return (
    <nav className="sticky top-0 z-50 w-full border-b border-neutral-800/60 bg-black/80 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-6">
        {/* Left — Logo */}
        <Link href="/" className="flex items-center gap-2.5 group">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-green-500/10 border border-green-500/20 transition-colors group-hover:bg-green-500/20">
            <Shield className="h-4 w-4 text-green-500" />
          </div>
          <span className="text-sm font-semibold tracking-widest text-white uppercase">
            AwaazOnboard
          </span>
        </Link>

        {/* Right — Nav Links */}
        <div className="flex items-center gap-1">
          <a
            href="#"
            className="flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm text-neutral-400 transition-colors hover:text-white hover:bg-neutral-900"
          >
            <FileText className="h-4 w-4" />
            <span className="hidden sm:inline">Documentation</span>
          </a>

          {user ? (
            <>
              {/* User indicator */}
              <Link
                href="/console"
                className="flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm text-neutral-400 transition-colors hover:text-white hover:bg-neutral-900"
              >
                <User className="h-4 w-4" />
                <span className="hidden sm:inline">
                  {user.full_name || user.cnic || "Console"}
                </span>
              </Link>
              {/* Sign Out */}
              <button
                onClick={handleSignOut}
                className="flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm text-neutral-400 transition-colors hover:text-red-400 hover:bg-red-500/5"
              >
                <LogOut className="h-4 w-4" />
                <span className="hidden sm:inline">Sign Out</span>
              </button>
            </>
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
