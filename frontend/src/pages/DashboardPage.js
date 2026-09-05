import React, { useEffect, useState } from 'react';
import { useAuth } from '../hooks/useAuth';
import { Link } from 'react-router-dom';
import API from '../utils/api';
import { Mic, ShieldCheck, ArrowLeftRight, AlertTriangle, CheckCircle, Clock, TrendingUp, Zap } from 'lucide-react';

const StatCard = ({ icon, label, value, sub, color = 'var(--accent)' }) => (
  <div className="card fadeIn" style={{ display: 'flex', alignItems: 'flex-start', gap: '16px' }}>
    <div style={{
      width: '44px', height: '44px', borderRadius: '12px',
      background: color + '20', border: `1px solid ${color}30`,
      display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
      color,
    }}>
      {icon}
    </div>
    <div>
      <div style={{ fontSize: '28px', fontWeight: 800, letterSpacing: '-0.02em', fontFamily: 'IBM Plex Mono' }}>
        {value}
      </div>
      <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)', marginTop: '2px' }}>{label}</div>
      {sub && <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>{sub}</div>}
    </div>
  </div>
);

export default function DashboardPage() {
  const { user } = useAuth();
  const [sessions, setSessions] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [enrollment, setEnrollment] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [sRes, tRes, eRes] = await Promise.all([
          API.get('/authenticate/sessions'),
          API.get('/transactions'),
          API.get('/enroll/status'),
        ]);
        setSessions(sRes.data.sessions || []);
        setTransactions(tRes.data.transactions || []);
        setEnrollment(eRes.data.enrollment);
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, []);

  const successSessions = sessions.filter(s => s.verification_status === 'success').length;

  const quickActions = [
    { to: '/enroll', icon: <Mic size={20} />, label: 'Voice Enrollment', desc: 'Register your voice biometric', color: 'var(--accent)' },
    { to: '/authenticate', icon: <ShieldCheck size={20} />, label: 'Authenticate', desc: 'Verify your identity via voice', color: 'var(--success)' },
    { to: '/transactions', icon: <ArrowLeftRight size={20} />, label: 'Transactions', desc: 'View & authorize transactions', color: 'var(--warning)' },
  ];

  return (
    <div className="fadeIn">
      {/* Header */}
      <div style={{ marginBottom: '32px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '8px' }}>
          <h1 className="page-title">Dashboard</h1>
          {user?.is_enrolled ? (
            <span className="badge badge-success"><CheckCircle size={10} /> Enrolled</span>
          ) : (
            <span className="badge badge-warning"><AlertTriangle size={10} /> Not Enrolled</span>
          )}
        </div>
        <p className="page-subtitle">
          Welcome back, <strong style={{ color: 'var(--text-primary)' }}>{user?.full_name}</strong> · CNIC: <span className="mono" style={{ fontSize: '13px' }}>{user?.cnic}</span>
        </p>
      </div>

      {/* Enrollment banner */}
      {!user?.is_enrolled && (
        <div style={{
          background: '#f59e0b10', border: '1px solid #f59e0b30',
          borderRadius: '12px', padding: '16px 20px',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          marginBottom: '28px', flexWrap: 'wrap', gap: '12px',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <AlertTriangle size={18} color="var(--warning)" />
            <div>
              <div style={{ fontWeight: 600, color: 'var(--warning)', fontSize: '14px' }}>Voice not enrolled</div>
              <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Complete enrollment to use authentication & transactions</div>
            </div>
          </div>
          <Link to="/enroll" className="btn btn-primary" style={{ fontSize: '13px', padding: '10px 20px' }}>
            <Mic size={14} /> Enroll Now
          </Link>
        </div>
      )}

      {/* Stats */}
      {loading ? (
        <div style={{ color: 'var(--text-muted)', fontSize: '14px', marginBottom: '28px' }}>Loading stats...</div>
      ) : (
        <div className="grid-4" style={{ marginBottom: '32px' }}>
          <StatCard icon={<ShieldCheck size={20} />} label="Total Sessions" value={sessions.length} sub="Authentication attempts" color="var(--accent)" />
          <StatCard icon={<CheckCircle size={20} />} label="Successful Auth" value={successSessions} sub="Passed verification" color="var(--success)" />
          <StatCard icon={<ArrowLeftRight size={20} />} label="Transactions" value={transactions.length} sub="Total authorized" color="var(--warning)" />
          <StatCard icon={<TrendingUp size={20} />} label="Success Rate" value={sessions.length ? `${Math.round((successSessions / sessions.length) * 100)}%` : 'N/A'} sub="Authentication accuracy" color="var(--accent-2)" />
        </div>
      )}

      <div className="grid-2" style={{ marginBottom: '32px' }}>
        {/* Quick Actions */}
        <div className="card">
          <div className="section-title" style={{ marginBottom: '20px', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Zap size={16} color="var(--accent)" /> Quick Actions
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {quickActions.map(a => (
              <Link key={a.to} to={a.to} style={{ textDecoration: 'none' }}>
                <div style={{
                  display: 'flex', alignItems: 'center', gap: '14px',
                  padding: '14px 16px', borderRadius: '10px',
                  background: 'var(--bg-secondary)',
                  border: '1px solid var(--border)',
                  transition: 'all 0.15s', cursor: 'pointer',
                }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = a.color; e.currentTarget.style.background = a.color + '10'; }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = ''; e.currentTarget.style.background = ''; }}
                >
                  <div style={{ color: a.color, background: a.color + '20', padding: '8px', borderRadius: '8px' }}>{a.icon}</div>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: '14px', color: 'var(--text-primary)' }}>{a.label}</div>
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{a.desc}</div>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </div>

        {/* Recent Sessions */}
        <div className="card">
          <div className="section-title" style={{ marginBottom: '20px', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Clock size={16} color="var(--accent)" /> Recent Sessions
          </div>
          {sessions.length === 0 ? (
            <div style={{ color: 'var(--text-muted)', fontSize: '13px', textAlign: 'center', padding: '32px 0' }}>
              No sessions yet. Start by authenticating.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {sessions.slice(0, 5).map(s => (
                <div key={s.id} style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '10px 14px', borderRadius: '8px', background: 'var(--bg-secondary)',
                }}>
                  <div>
                    <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-primary)', fontFamily: 'IBM Plex Mono' }}>
                      {s.session_type?.toUpperCase()}
                    </div>
                    <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
                      {new Date(s.session_timestamp).toLocaleString()}
                    </div>
                  </div>
                  <span className={`badge ${s.verification_status === 'success' ? 'badge-success' : s.verification_status === 'failed' ? 'badge-danger' : 'badge-muted'}`}>
                    {s.verification_status}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Enrollment info */}
      {enrollment?.is_enrolled && (
        <div className="card" style={{ borderColor: '#22c55e30' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <CheckCircle size={20} color="var(--success)" />
            <div>
              <div style={{ fontWeight: 700, fontSize: '15px' }}>Voice Profile Active</div>
              <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>
                Enrolled on {new Date(enrollment.enrollment_date).toLocaleDateString()} · Confidence score: <span className="mono">{(enrollment.confidence_score * 100).toFixed(1)}%</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
