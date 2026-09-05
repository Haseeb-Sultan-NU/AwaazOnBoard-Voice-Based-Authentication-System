import React, { useState, useRef, useEffect } from 'react';
import API from '../utils/api';
import { useAuth } from '../hooks/useAuth';
import toast from 'react-hot-toast';
import {
  Mic, CheckCircle, Loader, Smartphone,
  ChevronRight, Shield, RefreshCw, Square, WifiOff, Zap
} from 'lucide-react';

const PHRASES = [
  { urdu: 'میرا نام ہے اور میں پاکستان میں رہتی ہوں',     latin: 'Mera naam hai aur main Pakistan mein rehti hoon' },
  { urdu: 'میں اپنا بینک اکاؤنٹ محفوظ رکھنا چاہتی ہوں', latin: 'Main apna bank account mehfooz rakhna chahti hoon' },
  { urdu: 'آواز میری پہچان ہے',                           latin: 'Awaaz meri pehchaan hai' },
];

const STEPS = ['SIM Registration', 'Voice Recording', 'Processing', 'Complete'];

/* ── Animated waveform bars ── */
function WaveAnimation({ active }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '56px', gap: '5px' }}>
      {Array.from({ length: 9 }).map((_, i) => (
        <div
          key={i}
          style={{
            width: '5px', borderRadius: '3px',
            background: active ? 'var(--accent)' : 'var(--border)',
            height: active ? `${14 + Math.sin(i * 0.9) * 18}px` : '8px',
            transition: 'background 0.3s',
            animation: active ? `wb 1s ease-in-out ${i * 0.09}s infinite alternate` : 'none',
          }}
        />
      ))}
      <style>{`@keyframes wb { from { height:8px; opacity:.3 } to { height:44px; opacity:1 } }`}</style>
    </div>
  );
}

/* ── Step progress indicator ── */
function StepBar({ step }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', marginBottom: '36px' }}>
      {STEPS.map((s, i) => (
        <React.Fragment key={s}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px' }}>
            <div style={{
              width: '36px', height: '36px', borderRadius: '50%', flexShrink: 0,
              background: i < step ? 'var(--success)' : i === step ? 'var(--gradient)' : 'var(--bg-card)',
              border: i < step ? 'none' : `2px solid ${i === step ? 'transparent' : 'var(--border)'}`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: '13px', fontWeight: 700,
              color: i <= step ? 'white' : 'var(--text-muted)',
            }}>
              {i < step ? <CheckCircle size={16} /> : i + 1}
            </div>
            <span style={{
              fontSize: '10px', whiteSpace: 'nowrap',
              color: i <= step ? 'var(--text-primary)' : 'var(--text-muted)',
              fontWeight: i === step ? 700 : 400,
            }}>
              {s}
            </span>
          </div>
          {i < STEPS.length - 1 && (
            <div style={{
              flex: 1, height: '2px', margin: '0 8px', marginBottom: '22px',
              background: i < step ? 'var(--success)' : 'var(--border)',
              transition: 'background 0.4s',
            }} />
          )}
        </React.Fragment>
      ))}
    </div>
  );
}

export default function EnrollPage() {
  const { user, refreshUser } = useAuth();

  const [step,          setStep]       = useState(0);
  const [offline,       setOffline]    = useState(false);
  const [simForm,       setSimForm]    = useState({ phone_number: '', imsi: '', iccid: '' });
  
  // 3-Take Recording States
  const [currentTake,   setCurrentTake] = useState(0); // 0, 1, or 2
  const [audioBlobs,    setAudioBlobs]  = useState([null, null, null]);
  const [recording,     setRecording]   = useState(false);
  const [recorded,      setRecorded]    = useState(false);
  const [audioUrl,      setAudioUrl]    = useState(null);
  const [timer,         setTimer]       = useState(0);

  const [submitting,    setSubmitting]  = useState(false);
  const [result,        setResult]      = useState(null);

  const mediaRef  = useRef(null);
  const chunksRef = useRef([]);
  const timerRef  = useRef(null);

  useEffect(() => {
    if (recording) {
      timerRef.current = setInterval(() => setTimer(t => t + 1), 1000);
    } else {
      clearInterval(timerRef.current);
      setTimer(0);
    }
    return () => clearInterval(timerRef.current);
  }, [recording]);

  /* ── STEP 1: SIM Registration (Local Save) ── */
  const skipToRecording = () => {
    toast('Proceeding without SIM data', { icon: '⚡' });
    setStep(1);
  };

  const registerSim = () => {
    toast.success('SIM details temporarily saved. Now record your voice.');
    setStep(1);
  };

  /* ── STEP 2: Voice Recording (3 Takes) ── */
  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/ogg';
      const mr = new MediaRecorder(stream, { mimeType });
      chunksRef.current = [];
      mr.ondataavailable = e => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      mr.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: 'audio/wav' }); // Backend prefers wav
        
        // Save the blob to the correct take array index
        const updatedBlobs = [...audioBlobs];
        updatedBlobs[currentTake] = blob;
        setAudioBlobs(updatedBlobs);

        setAudioUrl(URL.createObjectURL(blob));
        setRecorded(true);
        stream.getTracks().forEach(t => t.stop());
      };
      mr.start(100);
      mediaRef.current = mr;
      setRecording(true);
    } catch (err) {
      toast.error('Could not access microphone: ' + err.message);
    }
  };

  const stopRecording = () => {
    if (mediaRef.current && recording) {
      mediaRef.current.stop();
      setRecording(false);
    }
  };

  const resetRecording = () => {
    setRecorded(false);
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    setAudioUrl(null);
  };

  const nextTake = () => {
    setCurrentTake(prev => prev + 1);
    setRecorded(false);
    setAudioUrl(null);
  };

  /* ── STEP 3: Submit to FastAPI ── */
  const submitVoice = async () => {
    setSubmitting(true);
    setStep(2);

    try {
      const form = new FormData();
      form.append('user_id', user.name || user.id); // Grabs the CNIC correctly
      form.append('phone_number', simForm.phone_number);
      form.append('imsi', simForm.imsi);
      form.append('iccid', simForm.iccid);
      
      // Append the 3 separate files
      form.append('take_1', audioBlobs[0], 'take_1.wav');
      form.append('take_2', audioBlobs[1], 'take_2.wav');
      form.append('take_3', audioBlobs[2], 'take_3.wav');

      const res = await API.post('/enroll', form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      
      setResult(res.data);
      if (refreshUser) await refreshUser();
      toast.success('Enrollment successful!');
      setStep(3);
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Enrollment failed.');
      setStep(1); // Kick back to recording if failed
    } finally {
      setSubmitting(false);
    }
  };

  const inputStyle = {
    background: 'var(--bg-secondary)', border: '1px solid var(--border)',
    borderRadius: '10px', padding: '13px 16px', color: 'var(--text-primary)',
    fontFamily: 'IBM Plex Mono', fontSize: '13px', outline: 'none', width: '100%',
  };

  return (
    <div className="fadeIn" style={{ maxWidth: '680px' }}>
      <div style={{ marginBottom: '32px', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px' }}>
        <div>
          <h1 className="page-title">Voice Enrollment</h1>
          <p className="page-subtitle">Register your voice as a biometric identity</p>
        </div>
      </div>

      <StepBar step={step} />

      {/* ══ STEP 0: SIM Registration ══ */}
      {step === 0 && (
        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '20px' }}>
            <div style={{ padding: '10px', background: 'var(--accent-glow)', borderRadius: '10px', color: 'var(--accent)' }}>
              <Smartphone size={20} />
            </div>
            <div>
              <div className="section-title">Register SIM Device</div>
              <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>
                Link your SIM card for security — or skip to use demo data
              </div>
            </div>
          </div>

          <button className="btn btn-primary" onClick={skipToRecording} style={{ width: '100%', justifyContent: 'center', padding: '14px', marginBottom: '20px', background: 'linear-gradient(135deg,#f59e0b,#ef4444)', boxShadow: '0 4px 20px #f59e0b40' }}>
            <Zap size={16} /> Skip — Do Not Link SIM
          </button>

          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '20px' }}>
            <div style={{ flex: 1, height: '1px', background: 'var(--border)' }} />
            <span style={{ fontSize: '11px', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>OR fill in real SIM details</span>
            <div style={{ flex: 1, height: '1px', background: 'var(--border)' }} />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            {[
              { key: 'phone_number', label: 'Phone Number', placeholder: '03001234567' },
              { key: 'imsi',         label: 'IMSI Number',  placeholder: '92300XXXXXXXXXX', hint: 'Settings → About → SIM Status' },
              { key: 'iccid',        label: 'ICCID Number', placeholder: '8992300XXXXXXXXXX', hint: 'Printed on back of SIM card' },
            ].map(f => (
              <div key={f.key} className="input-group">
                <label className="input-label">{f.label} <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(optional)</span></label>
                <input style={inputStyle} placeholder={f.placeholder} value={simForm[f.key]} onChange={e => setSimForm({ ...simForm, [f.key]: e.target.value })} />
                {f.hint && <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{f.hint}</span>}
              </div>
            ))}

            <button className="btn btn-ghost" onClick={registerSim} style={{ width: '100%', justifyContent: 'center', padding: '13px', marginTop: '4px' }}>
               <ChevronRight size={15} /> Register SIM &amp; Continue
            </button>
          </div>
        </div>
      )}

      {/* ══ STEP 1: Voice Recording (Looping 3 Takes) ══ */}
      {step === 1 && (
        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '24px' }}>
            <div style={{ padding: '10px', background: 'var(--accent-glow)', borderRadius: '10px', color: 'var(--accent)' }}>
              <Mic size={20} />
            </div>
            <div>
              <div className="section-title">Record Voice (Take {currentTake + 1} of 3)</div>
              <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>Speak the phrase below clearly</div>
            </div>
          </div>

          {/* Phrase display */}
          <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: '12px', padding: '24px', marginBottom: '24px', textAlign: 'center' }}>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '12px' }}>
              Read aloud in Urdu
            </div>
            <div style={{ fontSize: '22px', fontWeight: 600, lineHeight: '1.9', marginBottom: '10px', color: 'var(--text-primary)' }}>
              {PHRASES[currentTake].urdu}
            </div>
            <div style={{ fontSize: '13px', color: 'var(--text-muted)', fontStyle: 'italic' }}>
              {PHRASES[currentTake].latin}
            </div>
          </div>

          {/* Waveform visualizer */}
          <div style={{
            background: 'var(--bg-secondary)', borderRadius: '12px', padding: '20px', marginBottom: '24px',
            border: `2px solid ${recording ? 'var(--accent)' : recorded ? 'var(--success)' : 'var(--border)'}`,
            transition: 'border-color 0.3s',
          }}>
            <WaveAnimation active={recording} />
            <div style={{ textAlign: 'center', marginTop: '10px', fontSize: '13px', fontFamily: 'IBM Plex Mono' }}>
              {recording && <span style={{ color: 'var(--accent)' }}>🔴 Recording... {timer}s</span>}
              {recorded  && !recording && <span style={{ color: 'var(--success)' }}>✓ Recording ready — preview below</span>}
              {!recording && !recorded  && <span style={{ color: 'var(--text-muted)' }}>Press Start Recording, then speak the phrase</span>}
            </div>
          </div>

          {/* Audio playback */}
          {audioUrl && (
            <div style={{ marginBottom: '20px', background: 'var(--bg-secondary)', borderRadius: '10px', padding: '14px' }}>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '8px' }}>▶ Preview your recording</div>
              <audio controls src={audioUrl} style={{ width: '100%', height: '36px' }} />
            </div>
          )}

          {/* Action buttons */}
          <div style={{ display: 'flex', gap: '12px' }}>
            {!recording && !recorded && (
              <button className="btn btn-primary" onClick={startRecording} style={{ flex: 1, justifyContent: 'center', padding: '14px' }}>
                <Mic size={16} /> Start Recording
              </button>
            )}

            {recording && (
              <button onClick={stopRecording} style={{ flex: 1, padding: '14px', borderRadius: '10px', cursor: 'pointer', background: '#ef444420', border: '2px solid var(--danger)', color: 'var(--danger)', fontWeight: 700, fontFamily: 'Syne,sans-serif', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
                <Square size={16} /> Stop Recording
              </button>
            )}

            {recorded && !recording && (
              <>
                <button className="btn btn-ghost" onClick={resetRecording} style={{ flex: 1, justifyContent: 'center' }}>
                  <RefreshCw size={15} /> Re-record
                </button>
                
                {/* Logic gate: Next Take vs Submit */}
                {currentTake < 2 ? (
                    <button className="btn btn-primary" onClick={nextTake} style={{ flex: 2, justifyContent: 'center', padding: '14px' }}>
                        Next Phrase ({currentTake + 2}/3) <ChevronRight size={15} />
                    </button>
                ) : (
                    <button className="btn btn-primary" onClick={submitVoice} disabled={submitting} style={{ flex: 2, justifyContent: 'center', padding: '14px', background: 'var(--success)' }}>
                      {submitting ? <><Loader size={15} className="pulse" /> Processing...</> : <><CheckCircle size={15} /> Submit Enrollment</>}
                    </button>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* ══ STEP 2: Processing ══ */}
      {step === 2 && (
        <div className="card" style={{ textAlign: 'center', padding: '60px 40px' }}>
          <div style={{ width: '72px', height: '72px', borderRadius: '50%', background: 'var(--accent-glow)', border: '2px solid var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 24px', animation: 'spin 1.5s linear infinite' }}>
            <Loader size={28} color="var(--accent)" />
          </div>
          <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
          <div style={{ fontSize: '18px', fontWeight: 700, marginBottom: '12px' }}>Processing Biometrics...</div>
        </div>
      )}

      {/* ══ STEP 3: Complete ══ */}
      {step === 3 && (
        <div className="card" style={{ textAlign: 'center', padding: '48px 40px', borderColor: '#22c55e40' }}>
          <div style={{ width: '72px', height: '72px', borderRadius: '50%', background: '#22c55e20', border: '2px solid var(--success)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 24px' }}>
            <CheckCircle size={32} color="var(--success)" />
          </div>
          <div style={{ fontSize: '20px', fontWeight: 800, marginBottom: '8px', color: 'var(--success)' }}>Enrollment Complete!</div>
          <a href="/authenticate" className="btn btn-primary" style={{ display: 'inline-flex', textDecoration: 'none', padding: '13px 28px', fontSize: '15px' }}>
            Go to Authentication →
          </a>
        </div>
      )}
    </div>
  );
}