import React, { useState, useEffect } from 'react';
import API from '../utils/api';
import toast from 'react-hot-toast';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, PieChart, Pie, Cell, Legend,
} from 'recharts';
import {
  AlertTriangle, CheckCircle, XCircle, Users, ShieldCheck,
  ArrowLeftRight, Activity, RefreshCw, Database, Mic, WifiOff,
} from 'lucide-react';

const PIE_COLORS    = ['#22c55e', '#ef4444', '#f59e0b'];
const TOOLTIP_STYLE = { background: '#0a1f3d', border: '1px solid #1a3a6b', borderRadius: '8px', fontSize: '12px', color: '#e2e8f0' };
const TABS          = ['Overview', 'Fraud Alerts', 'Sessions', 'Users', 'Vector DB'];

// ── mock data shown when backend is offline ──────────────────────────────────
const MOCK_STATS = {
  total_users: 24, enrolled_users: 18, total_sessions: 142,
  total_transactions: 67, active_alerts: 3,
  session_success: 118, session_failed: 19, session_terminated: 5,
  avg_risk_score: '0.124',
  recent_activity: [
    { id:'1', full_name:'Fatima Bibi',    cnic:'3740511111111', session_type:'authentication', verification_status:'success',    risk_score:0.08, session_timestamp: new Date(Date.now()-5*60000).toISOString() },
    { id:'2', full_name:'Zainab Khatoon', cnic:'3740522222222', session_type:'enrollment',     verification_status:'success',    risk_score:0.05, session_timestamp: new Date(Date.now()-12*60000).toISOString() },
    { id:'3', full_name:'Rukhsana Begum', cnic:'3740533333333', session_type:'authentication', verification_status:'failed',     risk_score:0.62, session_timestamp: new Date(Date.now()-28*60000).toISOString() },
    { id:'4', full_name:'Nasreen Akhtar', cnic:'3740544444444', session_type:'authentication', verification_status:'terminated', risk_score:0.88, session_timestamp: new Date(Date.now()-45*60000).toISOString() },
  ],
  transactions_by_type: [
    { transaction_type:'transfer',     count:'28', total_amount:'142000' },
    { transaction_type:'withdrawal',   count:'18', total_amount:'54000'  },
    { transaction_type:'g2p_payment',  count:'15', total_amount:'37500'  },
    { transaction_type:'balance_check',count:'6',  total_amount:'0'      },
  ],
};

const MOCK_ALERTS = [
  { id:'a1', alert_type:'sim_swap',         severity:'high',     description:'SIM swap detected within 1-hour risk window', is_resolved:false, full_name:'Nasreen Akhtar', cnic:'3740544444444', created_at: new Date(Date.now()-30*60000).toISOString() },
  { id:'a2', alert_type:'repeated_failure', severity:'medium',   description:'3+ failed auth attempts in 1 hour',           is_resolved:false, full_name:'Rukhsana Begum', cnic:'3740533333333', created_at: new Date(Date.now()-60*60000).toISOString() },
  { id:'a3', alert_type:'replay_attack',    severity:'critical', description:'Possible voice replay attack detected',        is_resolved:true,  full_name:'Unknown User',   cnic:'3740500000000', created_at: new Date(Date.now()-3*3600000).toISOString() },
];

const MOCK_SESSIONS = [
  { id:'s1', full_name:'Fatima Bibi',    cnic:'3740511111111', session_type:'authentication', verification_status:'success',    liveness_check_status:'passed', similarity_score:0.91, risk_score:0.08, ip_address:'192.168.1.5',  session_timestamp: new Date(Date.now()-5*60000).toISOString() },
  { id:'s2', full_name:'Zainab Khatoon', cnic:'3740522222222', session_type:'enrollment',     verification_status:'success',    liveness_check_status:'passed', similarity_score:0.00, risk_score:0.05, ip_address:'192.168.1.8',  session_timestamp: new Date(Date.now()-12*60000).toISOString() },
  { id:'s3', full_name:'Rukhsana Begum', cnic:'3740533333333', session_type:'authentication', verification_status:'failed',     liveness_check_status:'passed', similarity_score:0.72, risk_score:0.62, ip_address:'192.168.1.12', session_timestamp: new Date(Date.now()-28*60000).toISOString() },
  { id:'s4', full_name:'Nasreen Akhtar', cnic:'3740544444444', session_type:'authentication', verification_status:'terminated', liveness_check_status:'pending',similarity_score:0.00, risk_score:0.88, ip_address:'10.0.0.99',    session_timestamp: new Date(Date.now()-45*60000).toISOString() },
];

const MOCK_USERS = [
  { id:'u1', full_name:'System Administrator', cnic:'3740512345678', phone_number:'03001234567', role:'admin',    is_enrolled:true,  session_count:'12', transaction_count:'5',  registration_date: new Date(Date.now()-30*86400000).toISOString() },
  { id:'u2', full_name:'Fatima Bibi',          cnic:'3740511111111', phone_number:'03011111111', role:'user',     is_enrolled:true,  session_count:'8',  transaction_count:'14', registration_date: new Date(Date.now()-10*86400000).toISOString() },
  { id:'u3', full_name:'Zainab Khatoon',       cnic:'3740522222222', phone_number:'03022222222', role:'user',     is_enrolled:true,  session_count:'3',  transaction_count:'6',  registration_date: new Date(Date.now()-7*86400000).toISOString() },
  { id:'u4', full_name:'Rukhsana Begum',       cnic:'3740533333333', phone_number:'03033333333', role:'user',     is_enrolled:false, session_count:'5',  transaction_count:'0',  registration_date: new Date(Date.now()-5*86400000).toISOString() },
  { id:'u5', full_name:'Fraud Analyst',        cnic:'3740598765432', phone_number:'03009876543', role:'analyst',  is_enrolled:false, session_count:'0',  transaction_count:'0',  registration_date: new Date(Date.now()-29*86400000).toISOString() },
];

const MOCK_VECTOR = [{ model_version:'v1.0-mock', total_embeddings:18, primary_embeddings:18, avg_quality:'0.890', avg_snr_db:'22.40', first_enrollment: new Date(Date.now()-9*86400000).toISOString(), last_enrollment: new Date(Date.now()-2*86400000).toISOString() }];
// ─────────────────────────────────────────────────────────────────────────────

function StatCard({ icon, label, value, color = 'var(--accent)', sub }) {
  return (
    <div className="card" style={{ display:'flex', gap:'16px', alignItems:'flex-start', padding:'20px' }}>
      <div style={{ color, background: color+'25', padding:'10px', borderRadius:'10px', flexShrink:0 }}>{icon}</div>
      <div>
        <div style={{ fontFamily:'IBM Plex Mono', fontSize:'22px', fontWeight:800, color, letterSpacing:'-0.02em' }}>{value ?? '—'}</div>
        <div style={{ fontSize:'12px', fontWeight:600, color:'var(--text-primary)', marginTop:'2px' }}>{label}</div>
        {sub && <div style={{ fontSize:'11px', color:'var(--text-muted)', marginTop:'2px' }}>{sub}</div>}
      </div>
    </div>
  );
}

const severityBadge = s => { const m={critical:'badge-danger',high:'badge-danger',medium:'badge-warning',low:'badge-info'}; return <span className={`badge ${m[s]||'badge-muted'}`}>{s}</span>; };
const statusBadge   = s => { const m={success:'badge-success',failed:'badge-danger',terminated:'badge-warning',pending:'badge-muted'}; return <span className={`badge ${m[s]||'badge-muted'}`}>{s}</span>; };

export default function AdminPage() {
  const [stats,       setStats]       = useState(null);
  const [alerts,      setAlerts]      = useState([]);
  const [sessions,    setSessions]    = useState([]);
  const [users,       setUsers]       = useState([]);
  const [vectorStats, setVectorStats] = useState([]);
  const [activeTab,   setActiveTab]   = useState('Overview');
  const [loading,     setLoading]     = useState(true);
  const [offline,     setOffline]     = useState(false);

  useEffect(() => { fetchAll(); }, []);

  // Each call is independent — one failure never blocks the others
  const fetchAll = async () => {
    setLoading(true);
    setOffline(false);

    const safe = async (fn, fallback) => {
      try { return await fn(); }
      catch { setOffline(true); return fallback; }
    };

    const [s, a, ss, u, v] = await Promise.all([
      safe(() => API.get('/admin/stats').then(r => r.data.stats),              MOCK_STATS),
      safe(() => API.get('/admin/fraud-alerts').then(r => r.data.alerts),      MOCK_ALERTS),
      safe(() => API.get('/admin/sessions').then(r => r.data.sessions),        MOCK_SESSIONS),
      safe(() => API.get('/users').then(r => r.data.users),                    MOCK_USERS),
      safe(() => API.get('/admin/vector-stats').then(r => r.data.vector_stats),MOCK_VECTOR),
    ]);

    setStats(s);
    setAlerts(a       || []);
    setSessions(ss    || []);
    setUsers(u        || []);
    setVectorStats(v  || []);
    setLoading(false);
  };

  const resolveAlert = async (id) => {
    if (offline) { setAlerts(a => a.map(x => x.id===id ? {...x, is_resolved:true} : x)); toast.success('Resolved (demo mode)'); return; }
    try {
      await API.patch(`/admin/fraud-alerts/${id}/resolve`);
      setAlerts(a => a.map(x => x.id===id ? {...x, is_resolved:true} : x));
      toast.success('Alert resolved');
    } catch { toast.error('Failed to resolve'); }
  };

  const unresolvedCount = alerts.filter(a => !a.is_resolved).length;

  // ── still loading ──
  if (loading) return (
    <div style={{ display:'flex', alignItems:'center', justifyContent:'center', minHeight:'400px' }}>
      <div style={{ textAlign:'center' }}>
        <div style={{ width:'48px', height:'48px', border:'3px solid var(--border)', borderTopColor:'var(--accent)', borderRadius:'50%', margin:'0 auto 16px', animation:'spin 0.8s linear infinite' }} />
        <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
        <div style={{ color:'var(--text-muted)', fontSize:'13px' }}>Loading admin data...</div>
      </div>
    </div>
  );

  const pieData  = stats ? [
    { name:'Success',    value: stats.session_success    },
    { name:'Failed',     value: stats.session_failed     },
    { name:'Terminated', value: stats.session_terminated },
  ] : [];

  const txnChart = (stats?.transactions_by_type || []).map(t => ({
    name:   t.transaction_type?.replace(/_/g,' '),
    count:  parseInt(t.count),
    volume: parseFloat(t.total_amount || 0),
  }));

  return (
    <div className="fadeIn">
      {/* Header */}
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:'32px', flexWrap:'wrap', gap:'12px' }}>
        <div>
          <h1 className="page-title">Admin Panel</h1>
          <p className="page-subtitle">System monitoring, fraud detection &amp; voice embedding analytics</p>
        </div>
        <div style={{ display:'flex', gap:'10px', alignItems:'center' }}>
          {offline && (
            <div style={{ display:'flex', alignItems:'center', gap:'6px', background:'#f59e0b15', border:'1px solid #f59e0b30', borderRadius:'8px', padding:'6px 12px' }}>
              <WifiOff size={13} color="var(--warning)" />
              <span style={{ fontSize:'12px', color:'var(--warning)' }}>Demo mode — backend offline</span>
            </div>
          )}
          <button className="btn btn-ghost" onClick={fetchAll} style={{ gap:'8px' }}>
            <RefreshCw size={14} /> Refresh
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display:'flex', gap:'4px', background:'var(--bg-secondary)', padding:'4px', borderRadius:'10px', width:'fit-content', marginBottom:'28px', flexWrap:'wrap' }}>
        {TABS.map(t => (
          <button key={t} onClick={() => setActiveTab(t)} style={{
            padding:'8px 18px', borderRadius:'7px', border:'none', cursor:'pointer',
            background: activeTab===t ? 'var(--bg-card)' : 'transparent',
            color:      activeTab===t ? 'var(--text-primary)' : 'var(--text-muted)',
            fontWeight: activeTab===t ? 700 : 400,
            fontSize:'13px', fontFamily:'Syne, sans-serif', transition:'all 0.15s',
          }}>
            {t}
            {t==='Fraud Alerts' && unresolvedCount > 0 && (
              <span style={{ marginLeft:'6px', background:'var(--danger)', color:'white', borderRadius:'10px', padding:'1px 7px', fontSize:'10px', fontWeight:700 }}>
                {unresolvedCount}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* ── OVERVIEW ── */}
      {activeTab === 'Overview' && stats && (
        <div>
          <div className="grid-4" style={{ marginBottom:'28px' }}>
            <StatCard icon={<Users size={18}/>}         label="Total Users"    value={stats.total_users}        sub={`${stats.enrolled_users} enrolled`}     color="var(--accent)" />
            <StatCard icon={<Activity size={18}/>}      label="Auth Sessions"  value={stats.total_sessions}     sub={`Avg risk: ${stats.avg_risk_score}`}     color="var(--accent-2)" />
            <StatCard icon={<ArrowLeftRight size={18}/>} label="Transactions"  value={stats.total_transactions}                                               color="var(--warning)" />
            <StatCard icon={<AlertTriangle size={18}/>} label="Active Alerts"  value={stats.active_alerts}      sub="Unresolved"                              color={stats.active_alerts > 0 ? 'var(--danger)' : 'var(--success)'} />
          </div>

          <div className="grid-3" style={{ marginBottom:'28px' }}>
            {[
              { label:'Successful Auth', value:stats.session_success,    color:'var(--success)' },
              { label:'Failed Auth',     value:stats.session_failed,     color:'var(--danger)'  },
              { label:'Terminated',      value:stats.session_terminated, color:'var(--warning)' },
            ].map(c => (
              <div key={c.label} className="card" style={{ padding:'16px 20px', borderColor: c.color+'30' }}>
                <div style={{ fontFamily:'IBM Plex Mono', fontSize:'28px', fontWeight:800, color:c.color }}>{c.value}</div>
                <div style={{ fontSize:'12px', color:'var(--text-muted)', marginTop:'4px' }}>{c.label}</div>
              </div>
            ))}
          </div>

          <div className="grid-2" style={{ marginBottom:'28px' }}>
            <div className="card">
              <div className="section-title" style={{ marginBottom:'20px' }}>Session Results</div>
              <ResponsiveContainer width="100%" height={220}>
                <PieChart>
                  <Pie data={pieData} cx="50%" cy="50%" innerRadius={55} outerRadius={85} paddingAngle={4} dataKey="value">
                    {pieData.map((_,i) => <Cell key={i} fill={PIE_COLORS[i]} />)}
                  </Pie>
                  <Tooltip contentStyle={TOOLTIP_STYLE} />
                  <Legend formatter={v => <span style={{ color:'var(--text-secondary)', fontSize:'12px' }}>{v}</span>} />
                </PieChart>
              </ResponsiveContainer>
            </div>

            <div className="card">
              <div className="section-title" style={{ marginBottom:'20px' }}>Transactions by Type</div>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={txnChart} margin={{ top:0, right:0, left:-20, bottom:0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="name" tick={{ fill:'var(--text-muted)', fontSize:10 }} />
                  <YAxis tick={{ fill:'var(--text-muted)', fontSize:10 }} />
                  <Tooltip contentStyle={TOOLTIP_STYLE} />
                  <Bar dataKey="count" fill="var(--accent)" radius={[4,4,0,0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Recent activity */}
          <div className="card" style={{ padding:0, overflow:'hidden' }}>
            <div style={{ padding:'18px 24px', borderBottom:'1px solid var(--border)', display:'flex', alignItems:'center', gap:'8px' }}>
              <Activity size={15} color="var(--accent)" />
              <span className="section-title">Recent Activity</span>
            </div>
            <div style={{ overflowX:'auto' }}>
              <table>
                <thead><tr><th>User</th><th>CNIC</th><th>Type</th><th>Status</th><th>Risk</th><th>Time</th></tr></thead>
                <tbody>
                  {(stats.recent_activity || []).map(a => (
                    <tr key={a.id}>
                      <td style={{ fontWeight:600, color:'var(--text-primary)', fontSize:'13px' }}>{a.full_name}</td>
                      <td style={{ fontFamily:'IBM Plex Mono', fontSize:'11px' }}>{a.cnic}</td>
                      <td><span className="badge badge-info" style={{ fontSize:'10px' }}>{a.session_type}</span></td>
                      <td>{statusBadge(a.verification_status)}</td>
                      <td style={{ fontFamily:'IBM Plex Mono', fontSize:'12px', color: parseFloat(a.risk_score) > 0.5 ? 'var(--danger)' : 'var(--success)' }}>
                        {parseFloat(a.risk_score||0).toFixed(3)}
                      </td>
                      <td style={{ fontFamily:'IBM Plex Mono', fontSize:'11px' }}>{new Date(a.session_timestamp).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ── FRAUD ALERTS ── */}
      {activeTab === 'Fraud Alerts' && (
        <div>
          {alerts.length === 0 ? (
            <div className="card" style={{ textAlign:'center', padding:'60px' }}>
              <CheckCircle size={44} color="var(--success)" style={{ marginBottom:'16px' }} />
              <div style={{ fontSize:'17px', fontWeight:700 }}>No Fraud Alerts</div>
              <div style={{ fontSize:'13px', color:'var(--text-muted)', marginTop:'6px' }}>System operating normally</div>
            </div>
          ) : (
            <div style={{ display:'flex', flexDirection:'column', gap:'12px' }}>
              {alerts.map(a => (
                <div key={a.id} className="card" style={{
                  borderColor: a.is_resolved ? 'var(--border)' : (['critical','high'].includes(a.severity) ? '#ef444440' : '#f59e0b30'),
                  opacity: a.is_resolved ? 0.55 : 1, padding:'20px 24px',
                }}>
                  <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', gap:'16px', flexWrap:'wrap' }}>
                    <div style={{ flex:1 }}>
                      <div style={{ display:'flex', alignItems:'center', gap:'10px', marginBottom:'8px', flexWrap:'wrap' }}>
                        <span style={{ fontWeight:700, fontSize:'13px', color:'var(--text-primary)' }}>
                          {a.alert_type?.replace(/_/g,' ').toUpperCase()}
                        </span>
                        {severityBadge(a.severity)}
                        {a.is_resolved && <span className="badge badge-success">Resolved</span>}
                      </div>
                      <div style={{ fontSize:'13px', color:'var(--text-secondary)', marginBottom:'6px' }}>{a.description}</div>
                      <div style={{ fontSize:'11px', color:'var(--text-muted)', fontFamily:'IBM Plex Mono' }}>
                        {a.full_name} · {a.cnic} · {new Date(a.created_at).toLocaleString()}
                      </div>
                    </div>
                    {!a.is_resolved && (
                      <button className="btn btn-ghost" onClick={() => resolveAlert(a.id)}
                        style={{ fontSize:'12px', padding:'8px 14px', color:'var(--success)', borderColor:'#22c55e40', flexShrink:0 }}>
                        <CheckCircle size={13} /> Resolve
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── SESSIONS ── */}
      {activeTab === 'Sessions' && (
        <div className="card" style={{ padding:0, overflow:'hidden' }}>
          <div style={{ padding:'18px 24px', borderBottom:'1px solid var(--border)', display:'flex', alignItems:'center', gap:'8px' }}>
            <ShieldCheck size={15} color="var(--accent)" />
            <span className="section-title">All Authentication Sessions ({sessions.length})</span>
          </div>
          <div style={{ overflowX:'auto' }}>
            <table>
              <thead><tr><th>User</th><th>Type</th><th>Status</th><th>Liveness</th><th>Similarity</th><th>Risk</th><th>IP</th><th>Time</th></tr></thead>
              <tbody>
                {sessions.map(s => (
                  <tr key={s.id}>
                    <td>
                      <div style={{ fontWeight:600, fontSize:'13px', color:'var(--text-primary)' }}>{s.full_name}</div>
                      <div style={{ fontFamily:'IBM Plex Mono', fontSize:'10px', color:'var(--text-muted)' }}>{s.cnic}</div>
                    </td>
                    <td><span className="badge badge-info" style={{ fontSize:'10px' }}>{s.session_type}</span></td>
                    <td>{statusBadge(s.verification_status)}</td>
                    <td><span className={`badge ${s.liveness_check_status==='passed' ? 'badge-success' : s.liveness_check_status==='failed' ? 'badge-danger' : 'badge-muted'}`}>{s.liveness_check_status}</span></td>
                    <td style={{ fontFamily:'IBM Plex Mono', fontSize:'12px', color: parseFloat(s.similarity_score)>=0.8 ? 'var(--success)' : parseFloat(s.similarity_score)>0 ? 'var(--danger)' : 'var(--text-muted)' }}>
                      {s.similarity_score > 0 ? (parseFloat(s.similarity_score)*100).toFixed(1)+'%' : '—'}
                    </td>
                    <td style={{ fontFamily:'IBM Plex Mono', fontSize:'12px', color: parseFloat(s.risk_score)>0.5 ? 'var(--danger)' : 'var(--text-muted)' }}>
                      {parseFloat(s.risk_score||0).toFixed(3)}
                    </td>
                    <td style={{ fontFamily:'IBM Plex Mono', fontSize:'11px', color:'var(--text-muted)' }}>{s.ip_address || '—'}</td>
                    <td style={{ fontFamily:'IBM Plex Mono', fontSize:'11px' }}>{new Date(s.session_timestamp).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── USERS ── */}
      {activeTab === 'Users' && (
        <div className="card" style={{ padding:0, overflow:'hidden' }}>
          <div style={{ padding:'18px 24px', borderBottom:'1px solid var(--border)', display:'flex', alignItems:'center', gap:'8px' }}>
            <Users size={15} color="var(--accent)" />
            <span className="section-title">Registered Users ({users.length})</span>
          </div>
          <div style={{ overflowX:'auto' }}>
            <table>
              <thead><tr><th>Name</th><th>CNIC</th><th>Phone</th><th>Role</th><th>Enrolled</th><th>Sessions</th><th>Txns</th><th>Registered</th></tr></thead>
              <tbody>
                {users.map(u => (
                  <tr key={u.id}>
                    <td style={{ fontWeight:600, color:'var(--text-primary)', fontSize:'13px' }}>{u.full_name}</td>
                    <td style={{ fontFamily:'IBM Plex Mono', fontSize:'12px' }}>{u.cnic}</td>
                    <td style={{ fontFamily:'IBM Plex Mono', fontSize:'12px' }}>{u.phone_number}</td>
                    <td><span className={`badge ${u.role==='admin' ? 'badge-warning' : u.role==='analyst' ? 'badge-info' : 'badge-muted'}`}>{u.role}</span></td>
                    <td style={{ textAlign:'center' }}>
                      {u.is_enrolled ? <CheckCircle size={15} color="var(--success)" /> : <XCircle size={15} color="var(--danger)" />}
                    </td>
                    <td style={{ fontFamily:'IBM Plex Mono', fontSize:'12px', color:'var(--accent)', textAlign:'center' }}>{u.session_count}</td>
                    <td style={{ fontFamily:'IBM Plex Mono', fontSize:'12px', color:'var(--warning)', textAlign:'center' }}>{u.transaction_count}</td>
                    <td style={{ fontFamily:'IBM Plex Mono', fontSize:'11px' }}>{new Date(u.registration_date).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── VECTOR DB ── */}
      {activeTab === 'Vector DB' && (
        <div>
          <div style={{ marginBottom:'20px', padding:'16px 20px', background:'#0ea5e910', border:'1px solid #0ea5e925', borderRadius:'12px', fontSize:'13px', color:'var(--accent)', lineHeight:'1.7' }}>
            <strong><Database size={14} style={{ marginRight:'6px', verticalAlign:'middle' }} />pgvector Store</strong> — Voice embeddings are 256-dimensional float vectors stored in PostgreSQL using the <code style={{ background:'#ffffff15', padding:'1px 5px', borderRadius:'4px' }}>vector(256)</code> column type. Cosine similarity search uses an IVFFlat index.
          </div>

          {vectorStats.length === 0 ? (
            <div className="card" style={{ textAlign:'center', padding:'60px' }}>
              <Mic size={40} color="var(--text-muted)" style={{ marginBottom:'16px' }} />
              <div style={{ fontSize:'16px', fontWeight:700 }}>No Embeddings Stored</div>
              <div style={{ fontSize:'13px', color:'var(--text-muted)', marginTop:'6px' }}>Users need to complete voice enrollment first</div>
            </div>
          ) : (
            <div style={{ display:'flex', flexDirection:'column', gap:'16px' }}>
              {vectorStats.map((v, i) => (
                <div key={i} className="card">
                  <div style={{ display:'flex', alignItems:'center', gap:'12px', marginBottom:'20px' }}>
                    <div style={{ padding:'10px', background:'var(--accent-glow)', borderRadius:'10px', color:'var(--accent)' }}><Database size={18} /></div>
                    <div>
                      <div style={{ fontWeight:700, fontSize:'15px' }}>Model: {v.model_version}</div>
                      <div style={{ fontSize:'12px', color:'var(--text-muted)' }}>Dimensionality: 256 · Index: IVFFlat cosine · Distance: 1 − cosine</div>
                    </div>
                  </div>
                  <div className="grid-4">
                    {[
                      { label:'Total Embeddings',  value: v.total_embeddings },
                      { label:'Primary (Active)',   value: v.primary_embeddings },
                      { label:'Avg Audio Quality', value: v.avg_quality ? (v.avg_quality*100).toFixed(1)+'%' : '—' },
                      { label:'Avg SNR',            value: v.avg_snr_db ? v.avg_snr_db+' dB' : '—' },
                    ].map(m => (
                      <div key={m.label} style={{ background:'var(--bg-secondary)', borderRadius:'10px', padding:'14px' }}>
                        <div style={{ fontSize:'10px', color:'var(--text-muted)', textTransform:'uppercase', letterSpacing:'0.08em', marginBottom:'6px' }}>{m.label}</div>
                        <div style={{ fontFamily:'IBM Plex Mono', fontSize:'18px', fontWeight:700, color:'var(--accent)' }}>{m.value}</div>
                      </div>
                    ))}
                  </div>
                  <div style={{ marginTop:'16px', fontSize:'11px', color:'var(--text-muted)', fontFamily:'IBM Plex Mono' }}>
                    First enrollment: {v.first_enrollment ? new Date(v.first_enrollment).toLocaleString() : '—'} &nbsp;·&nbsp;
                    Last enrollment:  {v.last_enrollment  ? new Date(v.last_enrollment).toLocaleString()  : '—'}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}