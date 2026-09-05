import React, { useState, useRef, useEffect } from 'react';
import API from '../utils/api';
import { useAuth } from '../hooks/useAuth';
import toast from 'react-hot-toast';
import { Mic, Square, ShieldCheck, ShieldX, Loader, RefreshCw, AlertTriangle, CheckCircle, Activity } from 'lucide-react';

function PulsingRing({ active, color = 'var(--accent)' }) {
  return (
    <div style={{ position: 'relative', width: '120px', height: '120px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      {active && [1, 2, 3].map(i => (
        <div key={i} style={{
          position: 'absolute', borderRadius: '50%',
          border: `2px solid ${color}`,
          width: `${80 + i * 20}px`, height: `${80 + i * 20}px`,
          animation: `ripple 2s ease-out ${i * 0.4}s infinite`,
          opacity: 0,
        }} />
      ))}
      <div style={{
        width: '80px', height: '80px', borderRadius: '50%',
        background: active ? color + '20' : 'var(--bg-card)',
        border: `3px solid ${active ? color : 'var(--border)'}`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        transition: 'all 0.3s',
        boxShadow: active ? `0 0 30px ${color}60` : 'none',
      }}>
        <Mic size={28} color={active ? color : 'var(--text-muted)'} />
      </div>
      <style>{`@keyframes ripple { 0% { opacity:0.6; transform:scale(0.8) } 100% { opacity:0; transform:scale(1.4) } }`}</style>
    </div>
  );
}

function ScoreBar({ label, value, color = 'var(--accent)', threshold }) {
  const pct = Math.min(Math.max(value * 100, 0), 100);
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
        <span style={{ fontSize: '12px', color: 'var(--text-secondary)', fontWeight: 600 }}>{label}</span>
        <span style={{ fontFamily: 'IBM Plex Mono', fontSize: '12px', color }}>{pct.toFixed(1)}%</span>
      </div>
      <div style={{ height: '6px', background: 'var(--bg-secondary)', borderRadius: '3px', overflow: 'hidden', position: 'relative' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: '3px', transition: 'width 1s ease' }} />
        {threshold && (
          <div style={{ position: 'absolute', left: `${threshold * 100}%`, top: 0, bottom: 0, width: '2px', background: '#ffffff40' }} />
        )}
      </div>
      {threshold && <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '3px' }}>Threshold: {(threshold * 100).toFixed(0)}%</div>}
    </div>
  );
}

export default function AuthenticatePage() {
  const { user } = useAuth();
  const [phase, setPhase] = useState('idle'); 
  const [challenge, setChallenge] = useState(null);
  const [sessionId, setSessionId] = useState(null);
  const [recording, setRecording] = useState(false);
  const [audioBlob, setAudioBlob] = useState(null);
  const [audioUrl, setAudioUrl] = useState(null);
  const [result, setResult] = useState(null);
  const [timer, setTimer] = useState(0);
  const mediaRef = useRef(null);
  const chunksRef = useRef([]);
  const timerRef = useRef(null);

  useEffect(() => {
    if (recording) { timerRef.current = setInterval(() => setTimer(t => t + 1), 1000); }
    else { clearInterval(timerRef.current); if (phase !== 'recording') setTimer(0); }
    return () => clearInterval(timerRef.current);
  }, [recording, phase]);

  const getChallenge = async () => {
    try {
      setPhase('challenge');
      const res = await API.post('/authenticate/challenge');
      setChallenge(res.data);
      setSessionId(res.data.session_id);
      setAudioBlob(null); setAudioUrl(null); setResult(null);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Failed to get challenge');
      setPhase('idle');
    }
  };

  const playChallengeAudio = async () => {
    if (!sessionId) return;
    
    try {
      const audioUrl = `${API.defaults.baseURL}/authenticate/audio/${sessionId}`;
      const audio = new Audio(audioUrl);
      
      await new Promise((resolve, reject) => {
        audio.onended = resolve;
        audio.onerror = reject;
        audio.play();
      });
    } catch (err) {
      toast.error('Could not play audio prompt.');
      console.error(err);
    }
  };

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      chunksRef.current = [];
      mr.ondataavailable = e => chunksRef.current.push(e.data);
      mr.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
        setAudioBlob(blob);
        setAudioUrl(URL.createObjectURL(blob));
        setRecording(false);
        stream.getTracks().forEach(t => t.stop());
      };
      mr.start();
      mediaRef.current = mr;
      setRecording(true);
      setPhase('challenge'); 
    } catch {
      toast.error('Microphone access denied.');
    }
  };

  const stopRecording = () => {
    if (mediaRef.current) { mediaRef.current.stop(); }
  };

  const verifyVoice = async () => {
    if (!audioBlob || !sessionId) return;
    setPhase('verifying');
    try {
      const form = new FormData();
      form.append('voice', audioBlob, 'auth.webm');
      form.append('session_id', sessionId);
      form.append('user_id', user.name || user.id); 
      
      const res = await API.post('/authenticate/verify', form, { headers: { 'Content-Type': 'multipart/form-data' } });
      setResult(res.data);
      setPhase('result');
      if (res.data.authenticated) toast.success('Authentication successful!');
      else toast.error('Authentication failed. Please try again.');
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Verification error');
      setPhase('challenge');
    }
  };

  if (!user?.is_enrolled) {
    return (
      <div className="fadeIn" style={{ maxWidth: '600px' }}>
        <h1 className="page-title">Voice Authentication</h1>
        <div className="card" style={{ marginTop: '32px', textAlign: 'center', padding: '48px', borderColor: '#f59e0b30' }}>
          <AlertTriangle size={40} color="var(--warning)" style={{ marginBottom: '16px' }} />
          <div style={{ fontSize: '18px', fontWeight: 700, marginBottom: '8px' }}>Voice Not Enrolled</div>
          <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '24px' }}>
            You must complete voice enrollment before you can authenticate.
          </div>
          <a href="/enroll" className="btn btn-primary" style={{ display: 'inline-flex', textDecoration: 'none' }}>
            <Mic size={16} /> Go to Enrollment
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="fadeIn" style={{ maxWidth: '640px' }}>
      <div style={{ marginBottom: '32px' }}>
        <h1 className="page-title">Voice Authentication</h1>
        <p className="page-subtitle">Verify your identity using your enrolled voice biometric</p>
      </div>

      {/* IDLE */}
      {phase === 'idle' && (
        <div className="card" style={{ textAlign: 'center', padding: '48px' }}>
          <PulsingRing active={false} />
          <div style={{ marginTop: '24px', marginBottom: '12px', fontSize: '18px', fontWeight: 700 }}>Ready to Authenticate</div>
          <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '32px' }}>
            Click below to receive a voice challenge phrase. You will then record yourself speaking it.
          </div>
          <button className="btn btn-primary" onClick={getChallenge} style={{ padding: '14px 32px', fontSize: '15px' }}>
            <ShieldCheck size={18} /> Begin Authentication
          </button>
        </div>
      )}

      {/* CHALLENGE */}
      {phase === 'challenge' && challenge && (
        <div className="card">
          {challenge.sim_swap_warning && (
            <div style={{ background: '#f59e0b10', border: '1px solid #f59e0b30', borderRadius: '10px', padding: '12px 16px', marginBottom: '20px', display: 'flex', alignItems: 'center', gap: '10px' }}>
              <AlertTriangle size={16} color="var(--warning)" />
              <span style={{ fontSize: '12px', color: 'var(--warning)' }}>SIM swap detected recently. Enhanced verification active.</span>
            </div>
          )}

          <div style={{ textAlign: 'center', marginBottom: '28px' }}>
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '16px' }}>
              Speak these numbers clearly
            </div>
            <div style={{
              background: 'var(--bg-secondary)', border: '1px solid var(--border)',
              borderRadius: '14px', padding: '28px 24px', marginBottom: '12px',
            }}>
              <div style={{ fontSize: '32px', letterSpacing: '8px', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '12px' }}>
                {Array.isArray(challenge.challenge) ? challenge.challenge.join(' - ') : challenge.challenge}
              </div>
              <button className="btn btn-ghost" onClick={playChallengeAudio} style={{ margin: '0 auto', fontSize: '13px', padding: '8px 16px' }}>
                ▶ Play Audio Prompt
              </button>
            </div>
          </div>

          {!audioBlob ? (
            <div style={{ textAlign: 'center' }}>
              {!recording ? (
                <button className="btn btn-primary" onClick={startRecording} style={{ padding: '16px 40px', fontSize: '15px' }}>
                  <Mic size={18} /> Start Speaking
                </button>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                  <PulsingRing active color="var(--danger)" />
                  <div style={{ marginTop: '16px', fontFamily: 'IBM Plex Mono', color: 'var(--danger)', fontSize: '14px', marginBottom: '16px' }}>
                    Recording... {timer}s
                  </div>
                  <button onClick={stopRecording} style={{
                    padding: '14px 32px', borderRadius: '10px', border: '2px solid var(--danger)',
                    background: '#ef444415', color: 'var(--danger)', cursor: 'pointer',
                    fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: '8px',
                  }}>
                    <Square size={16} /> Stop
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div>
              <div style={{ background: 'var(--bg-secondary)', borderRadius: '10px', padding: '14px', marginBottom: '16px' }}>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '8px' }}>Preview recording</div>
                <audio controls src={audioUrl} style={{ width: '100%', height: '36px' }} />
              </div>
              <div style={{ display: 'flex', gap: '12px' }}>
                <button className="btn btn-ghost" onClick={() => { setAudioBlob(null); setAudioUrl(null); }} style={{ flex: 1, justifyContent: 'center' }}>
                  <RefreshCw size={15} /> Re-record
                </button>
                <button className="btn btn-primary" onClick={verifyVoice} style={{ flex: 2, justifyContent: 'center', padding: '14px' }}>
                  <ShieldCheck size={16} /> Verify Identity
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* VERIFYING */}
      {phase === 'verifying' && (
        <div className="card" style={{ textAlign: 'center', padding: '60px' }}>
          <div style={{ width: '72px', height: '72px', borderRadius: '50%', background: 'var(--accent-glow)', border: '2px solid var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 24px', animation: 'spin 1.5s linear infinite' }}>
            <Loader size={28} color="var(--accent)" />
          </div>
          <style>{`@keyframes spin { to { transform:rotate(360deg) } }`}</style>
          <div style={{ fontSize: '17px', fontWeight: 700, marginBottom: '8px' }}>Verifying Voice...</div>
          <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>Running ECAPA-TDNN and Liveness Checks...</div>
        </div>
      )}

      {/* RESULT */}
      {phase === 'result' && result && (
        <div className="card fadeIn" style={{ borderColor: result.authenticated ? '#22c55e40' : '#ef444440' }}>
          <div style={{ textAlign: 'center', marginBottom: '32px' }}>
            <div style={{
              width: '80px', height: '80px', borderRadius: '50%', margin: '0 auto 20px',
              background: result.authenticated ? '#22c55e20' : '#ef444420',
              border: `3px solid ${result.authenticated ? 'var(--success)' : 'var(--danger)'}`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              {result.authenticated
                ? <CheckCircle size={36} color="var(--success)" />
                : <ShieldX size={36} color="var(--danger)" />}
            </div>
            <div style={{ fontSize: '22px', fontWeight: 800, color: result.authenticated ? 'var(--success)' : 'var(--danger)', marginBottom: '6px' }}>
              {result.authenticated ? 'Identity Verified' : 'Authentication Failed'}
            </div>
            <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>{result.message}</div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', marginBottom: '28px' }}>
            
            {/* GATEKEEPER CHECKMARK UI */}
            {result.gatekeeper_score === 1.0 ? (
                <div style={{ 
                    display: 'flex', 
                    alignItems: 'center', 
                    gap: '12px', 
                    padding: '16px', 
                    background: '#10b98110', 
                    borderRadius: '12px', 
                    border: '1px solid #10b98130', 
                    color: 'var(--success)',
                    fontSize: '14px',
                    fontWeight: 600
                }}>
                    <CheckCircle size={22} color="var(--success)" />
                    Gatekeeper passed, only 1 speaker detected.
                </div>
            ) : (
                <div style={{ 
                    display: 'flex', 
                    alignItems: 'center', 
                    gap: '12px', 
                    padding: '16px', 
                    background: '#ef444410', 
                    borderRadius: '12px', 
                    border: '1px solid #ef444430', 
                    color: 'var(--danger)',
                    fontSize: '14px',
                    fontWeight: 600
                }}>
                    <AlertTriangle size={22} color="var(--danger)" />
                    Gatekeeper blocked: Multiple speakers or splicing detected!
                </div>
            )}

            {/* SCORE BARS */}
            <ScoreBar label="Voice Similarity (ECAPA)" value={result.similarity_score} color={result.similarity_score >= 0.2393 ? 'var(--success)' : 'var(--danger)'} threshold={0.2393} />
            <ScoreBar label="Liveness Score (ASR)" value={result.liveness_score} color={result.liveness_score >= 0.80 ? 'var(--success)' : 'var(--warning)'} threshold={0.80} />
            <ScoreBar label="Risk Score" value={result.risk_score} color={result.risk_score < 0.3 ? 'var(--success)' : result.risk_score < 0.6 ? 'var(--warning)' : 'var(--danger)'} />
          </div>

          <div style={{ background: 'var(--bg-secondary)', borderRadius: '10px', padding: '14px', marginBottom: '24px', fontFamily: 'IBM Plex Mono', fontSize: '11px', color: 'var(--text-muted)' }}>
            Session: {result.session_id?.slice(0, 16)}...
          </div>

          <div style={{ display: 'flex', gap: '12px' }}>
            <button className="btn btn-ghost" onClick={() => { setPhase('idle'); setResult(null); }} style={{ flex: 1, justifyContent: 'center' }}>
              <Activity size={15} /> New Session
            </button>
            {result.authenticated && (
              <a href="/transactions" className="btn btn-primary" style={{ flex: 2, justifyContent: 'center', textDecoration: 'none' }}>
                Proceed to Transactions →
              </a>
            )}
          </div>
        </div>
      )}
    </div>
  );
}