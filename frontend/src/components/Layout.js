import React, { useState } from 'react';
import { Outlet, NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import {
  Mic, LayoutDashboard, ShieldCheck, ArrowLeftRight,
  Settings, LogOut, Menu, X, AlertTriangle, ChevronRight
} from 'lucide-react';

export default function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [sidebarOpen, setSidebarOpen] = useState(true);

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const navItems = [
    { to: '/dashboard', icon: <LayoutDashboard size={18} />, label: 'Dashboard' },
    { to: '/enroll', icon: <Mic size={18} />, label: 'Voice Enrollment' },
    { to: '/authenticate', icon: <ShieldCheck size={18} />, label: 'Authenticate' },
    { to: '/transactions', icon: <ArrowLeftRight size={18} />, label: 'Transactions' },
    ...(user?.role === 'admin' || user?.role === 'analyst'
      ? [{ to: '/admin', icon: <AlertTriangle size={18} />, label: 'Admin Panel' }]
      : []),
  ];

  return (
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      {/* Sidebar */}
      <aside style={{
        width: sidebarOpen ? '260px' : '72px',
        background: 'var(--bg-secondary)',
        borderRight: '1px solid var(--border)',
        display: 'flex',
        flexDirection: 'column',
        transition: 'width 0.3s ease',
        position: 'fixed',
        top: 0, left: 0, bottom: 0,
        zIndex: 100,
        overflow: 'hidden',
      }}>
        {/* Logo */}
        <div style={{
          padding: '24px 20px',
          borderBottom: '1px solid var(--border)',
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          minHeight: '72px',
        }}>
          <div style={{
            width: '36px', height: '36px', borderRadius: '10px',
            background: 'var(--gradient)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexShrink: 0,
            boxShadow: '0 0 20px #0ea5e950',
          }}>
            <Mic size={18} color="white" />
          </div>
          {sidebarOpen && (
            <div>
              <div style={{ fontWeight: 800, fontSize: '15px', letterSpacing: '-0.01em' }}>AwaazOnBoard</div>
              <div style={{ fontSize: '10px', color: 'var(--text-muted)', letterSpacing: '0.1em', textTransform: 'uppercase' }}>Voice Auth System</div>
            </div>
          )}
        </div>

        {/* Nav */}
        <nav style={{ flex: 1, padding: '16px 12px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              style={({ isActive }) => ({
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                padding: '11px 12px',
                borderRadius: '10px',
                textDecoration: 'none',
                color: isActive ? 'var(--accent)' : 'var(--text-secondary)',
                background: isActive ? 'var(--accent-glow)' : 'transparent',
                border: isActive ? '1px solid #0ea5e930' : '1px solid transparent',
                transition: 'all 0.15s',
                fontWeight: isActive ? 600 : 400,
                fontSize: '14px',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
              })}
              onMouseEnter={e => {
                if (!e.currentTarget.style.background.includes('accent-glow')) {
                  e.currentTarget.style.background = 'var(--bg-card)';
                  e.currentTarget.style.color = 'var(--text-primary)';
                }
              }}
              onMouseLeave={e => {
                if (!e.currentTarget.classList.contains('active')) {
                  e.currentTarget.style.background = '';
                  e.currentTarget.style.color = '';
                }
              }}
            >
              <span style={{ flexShrink: 0 }}>{item.icon}</span>
              {sidebarOpen && <span>{item.label}</span>}
            </NavLink>
          ))}
        </nav>

        {/* User + collapse */}
        <div style={{ padding: '12px', borderTop: '1px solid var(--border)' }}>
          {sidebarOpen && (
            <div style={{
              background: 'var(--bg-card)',
              border: '1px solid var(--border)',
              borderRadius: '10px',
              padding: '12px',
              marginBottom: '8px',
            }}>
              <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>
                {user?.full_name || 'User'}
              </div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontFamily: 'IBM Plex Mono', marginTop: '2px' }}>
                {user?.cnic}
              </div>
              <div style={{ marginTop: '8px' }}>
                <span className={`badge ${user?.role === 'admin' ? 'badge-warning' : 'badge-info'}`}>
                  {user?.role}
                </span>
              </div>
            </div>
          )}
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              onClick={() => setSidebarOpen(!sidebarOpen)}
              className="btn btn-ghost"
              style={{ flex: 1, padding: '10px', justifyContent: 'center' }}
            >
              {sidebarOpen ? <X size={16} /> : <Menu size={16} />}
            </button>
            <button
              onClick={handleLogout}
              className="btn btn-ghost"
              style={{ flex: 1, padding: '10px', justifyContent: 'center', color: 'var(--danger)' }}
              title="Logout"
            >
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </aside>

      {/* Main content */}
      <main style={{
        marginLeft: sidebarOpen ? '260px' : '72px',
        flex: 1,
        transition: 'margin-left 0.3s ease',
        minHeight: '100vh',
        padding: '40px',
      }}>
        <Outlet />
      </main>
    </div>
  );
}
