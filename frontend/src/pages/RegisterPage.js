import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import toast from 'react-hot-toast';
import { Mic, UserPlus } from 'lucide-react';

export default function RegisterPage() {
  const { register, loading } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ cnic: '', full_name: '', phone_number: '', password: '', confirm: '' });

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.cnic || !form.full_name || !form.phone_number || !form.password) {
      toast.error('All fields are required');
      return;
    }
    if (form.cnic.length !== 13) {
      toast.error('CNIC must be 13 digits');
      return;
    }
    if (form.password !== form.confirm) {
      toast.error('Passwords do not match');
      return;
    }
    if (form.password.length < 6) {
      toast.error('Password must be at least 6 characters');
      return;
    }

    // NEW CODE (Matches your FastAPI UserSignup schema)
    const result = await register({
      cnic: form.cnic,
      full_name: form.full_name,
      phone_number: form.phone_number,
      password: form.password,
    });

    if (result.success) {
      toast.success('Account created successfully!');
      navigate('/dashboard');
    } else {
      toast.error(result.message);
    }
  };

  const fields = [
    { key: 'full_name', label: 'Full Name', placeholder: 'Zainab Tahir', type: 'text' },
    { key: 'cnic', label: 'CNIC Number', placeholder: '3740512345678', type: 'text', maxLength: 13, hint: '13 digits without dashes' },
    { key: 'phone_number', label: 'Phone Number', placeholder: '03001234567', type: 'text' },
    { key: 'password', label: 'Password', placeholder: '••••••••', type: 'password' },
    { key: 'confirm', label: 'Confirm Password', placeholder: '••••••••', type: 'password' },
  ];

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px' }}>
      <div style={{
        position: 'fixed', inset: 0, zIndex: 0,
        backgroundImage: 'linear-gradient(var(--border) 1px, transparent 1px), linear-gradient(90deg, var(--border) 1px, transparent 1px)',
        backgroundSize: '60px 60px', opacity: 0.3,
      }} />

      <div className="fadeIn" style={{ position: 'relative', zIndex: 1, width: '100%', maxWidth: '440px' }}>
        <div style={{ textAlign: 'center', marginBottom: '32px' }}>
          <div style={{
            width: '56px', height: '56px', borderRadius: '16px',
            background: 'var(--gradient)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            margin: '0 auto 14px',
            boxShadow: '0 0 30px #0ea5e950',
          }}>
            <Mic size={24} color="white" />
          </div>
          <h1 style={{ fontSize: '24px', fontWeight: 800, letterSpacing: '-0.02em' }}>Create Account</h1>
          <p style={{ color: 'var(--text-secondary)', fontSize: '13px', marginTop: '4px' }}>
            Register to access AwaazOnBoard
          </p>
        </div>

        <div className="card" style={{ padding: '32px' }}>
          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
            {fields.map(f => (
              <div key={f.key} className="input-group">
                <label className="input-label">{f.label}</label>
                <input
                  className="input-field"
                  type={f.type}
                  placeholder={f.placeholder}
                  maxLength={f.maxLength}
                  value={form[f.key]}
                  onChange={e => setForm({ ...form, [f.key]: e.target.value })}
                />
                {f.hint && <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{f.hint}</span>}
              </div>
            ))}

            <button
              type="submit"
              className="btn btn-primary"
              style={{ width: '100%', justifyContent: 'center', padding: '14px', marginTop: '4px' }}
              disabled={loading}
            >
              {loading ? <span className="pulse">Creating account...</span> : <><UserPlus size={16} /> Create Account</>}
            </button>
          </form>

          <div className="divider" />
          <p style={{ textAlign: 'center', fontSize: '13px', color: 'var(--text-secondary)' }}>
            Already have an account?{' '}
            <Link to="/login" style={{ color: 'var(--accent)', textDecoration: 'none', fontWeight: 600 }}>
              Sign in
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
