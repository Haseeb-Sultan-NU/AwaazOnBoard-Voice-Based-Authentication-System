"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  Shield,
  LayoutDashboard,
  Mic,
  Code2,
  ScrollText,
  LogOut,
  ChevronRight,
  Settings,
} from "lucide-react";

interface AwaazUser {
  cnic?: string;
  user_id?: string;
  full_name?: string;
}

const navItems = [
  { label: "Dashboard", href: "/console", icon: LayoutDashboard },
  { label: "Voice Enrollment", href: "/console/enrollment", icon: Mic },
  { label: "API Management", href: "/console/api-management", icon: Code2 },
  { label: "Logs", href: "/console/logs", icon: ScrollText },
  { label: "Account Settings", href: "/console/settings", icon: Settings },
];

export default function ConsoleLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();

  /* ── Read user from localStorage (re-reads on route change) ── */
  const [user, setUser] = useState<AwaazUser | null>(null);

  useEffect(() => {
    try {
      const stored = localStorage.getItem("awaaz_user");
      if (stored) setUser(JSON.parse(stored));
      else setUser(null);
    } catch {
      // Invalid JSON or no storage
    }
  }, [pathname]);

  const displayName = user?.full_name || "Enterprise Account";
  const displayCnic = user?.cnic || user?.user_id || "—";

  /* Format CNIC: 1234567890123 → 12345-6789012-3 */
  const formatCnic = (raw: string): string => {
    const digits = raw.replace(/\D/g, "");
    if (digits.length !== 13) return raw;
    return `${digits.slice(0, 5)}-${digits.slice(5, 12)}-${digits.slice(12)}`;
  };

  const handleLogout = () => {
    localStorage.removeItem("awaaz_user");
    router.push("/login");
  };

  return (
    <div className="flex h-[calc(100vh-4rem)]">
      {/* ── Sidebar ─────────────────────────────────────────── */}
      <aside className="flex w-[280px] shrink-0 flex-col border-r border-neutral-800 bg-[#0a0a0a]">
        {/* Logo */}
        <div className="flex items-center gap-2.5 border-b border-neutral-800/60 px-6 py-5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-green-500/10 border border-green-500/20">
            <Shield className="h-4 w-4 text-green-500" />
          </div>
          <span className="text-xs font-semibold tracking-[0.2em] text-neutral-300 uppercase">
            AwaazOnboard
          </span>
        </div>

        {/* Navigation */}
        <nav className="flex-1 overflow-y-auto px-3 py-4">
          <p className="mb-3 px-3 text-[10px] font-semibold uppercase tracking-[0.15em] text-neutral-600">
            Platform
          </p>
          <ul className="space-y-1">
            {navItems.map((item) => {
              const isActive =
                pathname === item.href ||
                (item.href !== "/console" && pathname.startsWith(item.href));
              const Icon = item.icon;

              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className={`group flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all ${
                      isActive
                        ? "bg-green-500/10 text-green-400"
                        : "text-neutral-500 hover:bg-neutral-800/50 hover:text-neutral-300"
                    }`}
                  >
                    <Icon
                      className={`h-4 w-4 shrink-0 ${
                        isActive
                          ? "text-green-400"
                          : "text-neutral-600 group-hover:text-neutral-400"
                      }`}
                    />
                    <span className="flex-1">{item.label}</span>
                    {isActive && (
                      <ChevronRight className="h-3.5 w-3.5 text-green-500/50" />
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        {/* User Profile Card */}
        <div className="border-t border-neutral-800/60 p-4">
          <div className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-4">
            {/* User Info — Dynamic from localStorage */}
            <div className="mb-3">
              <p className="text-xs font-medium text-neutral-300">
                {displayName}
              </p>
              <p className="mt-1 font-mono text-[11px] text-neutral-600">
                {formatCnic(displayCnic)}
              </p>
            </div>

            {/* Status badge */}
            <div className="mb-3 flex items-center gap-2">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-green-500" />
              <span className="text-[10px] font-medium uppercase tracking-wider text-neutral-500">
                Active Session
              </span>
            </div>

            {/* Logout */}
            <button
              onClick={handleLogout}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2 text-xs font-medium text-neutral-400 transition-all hover:border-red-500/30 hover:bg-red-500/5 hover:text-red-400"
            >
              <LogOut className="h-3.5 w-3.5" />
              Logout
            </button>
          </div>
        </div>
      </aside>

      {/* ── Main Content ────────────────────────────────────── */}
      <main className="flex-1 overflow-y-auto bg-black">{children}</main>
    </div>
  );
}
