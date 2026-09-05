import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import toast from 'react-hot-toast';
import { Mic, Eye, EyeOff, ShieldCheck } from 'lucide-react';

export default function LoginPage() {
  const { login, loading } = useAuth();
  
  const navigate = useNavigate();
  const [form, setForm] = useState({ cnic: '', password: '' });
  const [showPass, setShowPass] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.cnic || !form.password) {
      toast.error('Please fill in all fields');
      return;
    }
    
    // 1. Call the REAL backend login function (no more fake bypass!)
    const result = await login(form.cnic, form.password);

    // 2. If the backend verifies the password, let them in
    if (result.success) {
      toast.success('Welcome back!');
      navigate('/dashboard');
    } else {
      toast.error(result.message);
    }
  };
  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '24px',
    }}>
      {/* Background grid */}
      <div style={{
        position: 'fixed', inset: 0, zIndex: 0,
        backgroundImage: 'linear-gradient(var(--border) 1px, transparent 1px), linear-gradient(90deg, var(--border) 1px, transparent 1px)',
        backgroundSize: '60px 60px',
        opacity: 0.3,
      }} />

      <div className="fadeIn" style={{ position: 'relative', zIndex: 1, width: '100%', maxWidth: '420px' }}>
        {/* Logo */}
        <div style={{ textAlign: 'center', marginBottom: '40px' }}>
          <div style={{
            width: '64px', height: '64px', borderRadius: '18px',
            background: 'var(--gradient)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            margin: '0 auto 16px',
            boxShadow: '0 0 40px #0ea5e960',
          }}>
            <Mic size={28} color="white" />
          </div>
          <h1 style={{ fontSize: '28px', fontWeight: 800, letterSpacing: '-0.02em' }}>AwaazOnBoard</h1>
          <p style={{ color: 'var(--text-secondary)', fontSize: '14px', marginTop: '6px' }}>
            Voice Biometric Authentication System
          </p>
        </div>

        {/* Form card */}
        <div className="card" style={{ padding: '36px' }}>
          <div style={{ marginBottom: '28px' }}>
            <h2 style={{ fontSize: '20px', fontWeight: 700 }}>Sign In</h2>
            <p style={{ color: 'var(--text-secondary)', fontSize: '13px', marginTop: '4px' }}>
              Enter your CNIC and password to access the system
            </p>
          </div>

          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
            <div className="input-group">
              <label className="input-label">CNIC Number</label>
              <input
                className="input-field"
                placeholder="3740512345678"
                maxLength={15}
                value={form.cnic}
                onChange={e => setForm({ ...form, cnic: e.target.value })}
              />
              <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>13 digits, no dashes</span>
            </div>

            <div className="input-group">
              <label className="input-label">Password</label>
              <div style={{ position: 'relative' }}>
                <input
                  className="input-field"
                  type={showPass ? 'text' : 'password'}
                  placeholder="••••••••"
                  value={form.password}
                  onChange={e => setForm({ ...form, password: e.target.value })}
                  style={{ paddingRight: '44px' }}
                />
                <button
                  type="button"
                  onClick={() => setShowPass(!showPass)}
                  style={{
                    position: 'absolute', right: '14px', top: '50%',
                    transform: 'translateY(-50%)',
                    background: 'none', border: 'none', cursor: 'pointer',
                    color: 'var(--text-muted)',
                  }}
                >
                  {showPass ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>

            <button
              type="submit"
              className="btn btn-primary"
              style={{ width: '100%', justifyContent: 'center', padding: '14px' }}
              disabled={loading}
            >
              {loading ? (
                <span className="pulse">Signing in...</span>
              ) : (
                <><ShieldCheck size={16} /> Sign In Securely</>
              )}
            </button>
          </form>

          <div className="divider" />

          <p style={{ textAlign: 'center', fontSize: '13px', color: 'var(--text-secondary)' }}>
            New user?{' '}
            <Link to="/register" style={{ color: 'var(--accent)', textDecoration: 'none', fontWeight: 600 }}>
              Register here
            </Link>
          </p>
        </div>

        {/* Admin hint */}
        <div style={{
          marginTop: '16px',
          padding: '12px 16px',
          background: '#f59e0b10',
          border: '1px solid #f59e0b20',
          borderRadius: '10px',
          fontSize: '12px',
          color: 'var(--warning)',
          fontFamily: 'IBM Plex Mono',
        }}>
          Admin demo → CNIC: <strong>3740512345678</strong> | Pass: <strong>password</strong>
        </div>
      </div>
    </div>
  );
}
