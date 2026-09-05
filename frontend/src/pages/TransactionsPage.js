import React, { useState, useEffect } from 'react';
import API from '../utils/api';
import toast from 'react-hot-toast';
import { ArrowLeftRight, Plus, CheckCircle, XCircle, Clock, Loader, ShieldCheck } from 'lucide-react';

const TXN_TYPES = [
  { value: 'transfer', label: 'Money Transfer' },
  { value: 'withdrawal', label: 'Withdrawal' },
  { value: 'g2p_payment', label: 'G2P Payment (BISP)' },
  { value: 'balance_check', label: 'Balance Check' },
  { value: 'deposit', label: 'Deposit' },
];

const statusBadge = (status) => {
  const map = { approved: 'badge-success', rejected: 'badge-danger', pending: 'badge-warning' };
  return <span className={`badge ${map[status] || 'badge-muted'}`}>{status}</span>;
};

const formatAmount = (amt) => `PKR ${parseFloat(amt).toLocaleString('en-PK', { minimumFractionDigits: 2 })}`;

export default function TransactionsPage() {
  const [transactions, setTransactions] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ session_id: '', amount: '', transaction_type: 'transfer', description: '' });
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => { fetchData(); }, []);

  const fetchData = async () => {
    setLoading(true);
    try {
      const [tRes, sRes] = await Promise.all([
        API.get('/transactions'),
        API.get('/authenticate/sessions'),
      ]);
      setTransactions(tRes.data.transactions || []);
      // Only show recent successful sessions (within 10 min) for new transactions
      const validSessions = (sRes.data.sessions || []).filter(s =>
        s.verification_status === 'success' &&
        new Date(s.session_timestamp) > new Date(Date.now() - 10 * 60 * 1000)
      );
      setSessions(validSessions);
    } catch (err) {
      toast.error('Failed to load transactions');
    } finally { setLoading(false); }
  };

  const submitTxn = async (e) => {
    e.preventDefault();
    if (!form.session_id) { toast.error('Select an authenticated session'); return; }
    if (!form.amount || isNaN(form.amount) || parseFloat(form.amount) <= 0) { toast.error('Enter a valid amount'); return; }
    setSubmitting(true);
    try {
      await API.post('/transactions', {
        session_id: form.session_id,
        amount: parseFloat(form.amount),
        transaction_type: form.transaction_type,
        description: form.description,
      });
      toast.success('Transaction authorized!');
      setShowForm(false);
      setForm({ session_id: '', amount: '', transaction_type: 'transfer', description: '' });
      fetchData();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Transaction failed');
    } finally { setSubmitting(false); }
  };

  const inputStyle = { background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: '10px', padding: '13px 16px', color: 'var(--text-primary)', fontFamily: 'IBM Plex Mono', fontSize: '13px', outline: 'none', width: '100%' };

  const totalApproved = transactions.filter(t => t.authorization_status === 'approved').reduce((s, t) => s + parseFloat(t.amount), 0);

  return (
    <div className="fadeIn">
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '32px', flexWrap: 'wrap', gap: '16px' }}>
        <div>
          <h1 className="page-title">Transactions</h1>
          <p className="page-subtitle">Voice-authorized financial transactions</p>
        </div>
        <button className="btn btn-primary" onClick={() => setShowForm(!showForm)}>
          <Plus size={16} /> New Transaction
        </button>
      </div>

      {/* Summary cards */}
      <div className="grid-3" style={{ marginBottom: '28px' }}>
        {[
          { label: 'Total Transactions', value: transactions.length, color: 'var(--accent)', icon: <ArrowLeftRight size={18} /> },
          { label: 'Approved', value: transactions.filter(t => t.authorization_status === 'approved').length, color: 'var(--success)', icon: <CheckCircle size={18} /> },
          { label: 'Total Volume', value: `PKR ${totalApproved.toLocaleString()}`, color: 'var(--warning)', icon: <ShieldCheck size={18} /> },
        ].map(c => (
          <div key={c.label} className="card" style={{ display: 'flex', alignItems: 'center', gap: '14px', padding: '20px' }}>
            <div style={{ color: c.color, background: c.color + '20', padding: '10px', borderRadius: '10px' }}>{c.icon}</div>
            <div>
              <div style={{ fontFamily: 'IBM Plex Mono', fontSize: '20px', fontWeight: 700, color: c.color }}>{c.value}</div>
              <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>{c.label}</div>
            </div>
          </div>
        ))}
      </div>

      {/* New Transaction Form */}
      {showForm && (
        <div className="card fadeIn" style={{ marginBottom: '28px', borderColor: 'var(--accent)' }}>
          <div className="section-title" style={{ marginBottom: '20px', color: 'var(--accent)' }}>
            <ShieldCheck size={16} style={{ marginRight: '8px' }} /> New Voice-Authorized Transaction
          </div>

          {sessions.length === 0 ? (
            <div style={{ background: '#f59e0b10', border: '1px solid #f59e0b30', borderRadius: '10px', padding: '16px', textAlign: 'center' }}>
              <div style={{ fontSize: '13px', color: 'var(--warning)', marginBottom: '12px' }}>
                No valid authenticated session found (sessions expire in 10 minutes).
              </div>
              <a href="/authenticate" className="btn btn-primary" style={{ display: 'inline-flex', textDecoration: 'none', fontSize: '13px', padding: '10px 20px' }}>
                <ShieldCheck size={14} /> Authenticate First
              </a>
            </div>
          ) : (
            <form onSubmit={submitTxn} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <div className="input-group">
                <label className="input-label">Authenticated Session</label>
                <select style={inputStyle} value={form.session_id} onChange={e => setForm({ ...form, session_id: e.target.value })}>
                  <option value="">Select session...</option>
                  {sessions.map(s => (
                    <option key={s.id} value={s.id}>
                      Session {s.id.slice(0, 8)}... — {new Date(s.session_timestamp).toLocaleTimeString()}
                    </option>
                  ))}
                </select>
              </div>
              <div className="grid-2">
                <div className="input-group">
                  <label className="input-label">Transaction Type</label>
                  <select style={inputStyle} value={form.transaction_type} onChange={e => setForm({ ...form, transaction_type: e.target.value })}>
                    {TXN_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>
                </div>
                <div className="input-group">
                  <label className="input-label">Amount (PKR)</label>
                  <input style={inputStyle} type="number" min="1" placeholder="5000" value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })} />
                </div>
              </div>
              <div className="input-group">
                <label className="input-label">Description (optional)</label>
                <input style={inputStyle} placeholder="e.g. Monthly pension payment" value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} />
              </div>
              <div style={{ display: 'flex', gap: '12px', marginTop: '4px' }}>
                <button type="button" className="btn btn-ghost" onClick={() => setShowForm(false)} style={{ flex: 1, justifyContent: 'center' }}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={submitting} style={{ flex: 2, justifyContent: 'center', padding: '14px' }}>
                  {submitting ? <><Loader size={15} className="pulse" /> Processing...</> : <><CheckCircle size={15} /> Authorize Transaction</>}
                </button>
              </div>
            </form>
          )}
        </div>
      )}

      {/* Transaction table */}
      <div className="card" style={{ padding: '0', overflow: 'hidden' }}>
        <div style={{ padding: '20px 24px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <ArrowLeftRight size={16} color="var(--accent)" />
          <span className="section-title">Transaction History</span>
        </div>
        {loading ? (
          <div style={{ padding: '48px', textAlign: 'center', color: 'var(--text-muted)' }}><Loader size={20} className="pulse" /></div>
        ) : transactions.length === 0 ? (
          <div style={{ padding: '48px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>
            No transactions yet. Authenticate first, then create a transaction.
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Amount</th>
                  <th>Institution</th>
                  <th>Date & Time</th>
                  <th>Status</th>
                  <th>Description</th>
                </tr>
              </thead>
              <tbody>
                {transactions.map(t => (
                  <tr key={t.id}>
                    <td>
                      <span style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: '12px' }}>
                        {TXN_TYPES.find(x => x.value === t.transaction_type)?.label || t.transaction_type}
                      </span>
                    </td>
                    <td style={{ fontFamily: 'IBM Plex Mono', color: 'var(--accent)', fontWeight: 600 }}>
                      {formatAmount(t.amount)}
                    </td>
                    <td style={{ fontSize: '12px' }}>{t.institution_name || '—'}</td>
                    <td style={{ fontFamily: 'IBM Plex Mono', fontSize: '11px' }}>
                      {new Date(t.request_timestamp).toLocaleString()}
                    </td>
                    <td>{statusBadge(t.authorization_status)}</td>
                    <td style={{ fontSize: '12px', maxWidth: '180px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {t.description || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
