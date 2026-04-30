import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

const BACKEND_URL =
  window.SENTINEL_CONFIG?.BACKEND_URL ||
  import.meta.env.VITE_BACKEND_URL ||
  'http://localhost:8000';

const symptoms = ['fever', 'cough', 'fast_breathing', 'diarrhoea', 'dehydration', 'rash', 'vomiting'];

const dangerSigns = {
  unable_to_drink: 'Unable to drink or breastfeed',
  vomits_everything: 'Vomits everything',
  convulsions: 'History of convulsions in this illness',
  currently_convulsing: 'Currently convulsing',
  lethargic_unconscious: 'Lethargic or unconscious',
  stridor: 'Stridor in calm child',
  severe_respiratory_distress: 'Severe respiratory distress',
  visible_severe_wasting: 'Visible severe wasting',
  bilateral_oedema: 'Bilateral pitting oedema of the feet',
  severe_pallor: 'Severe palmar pallor'
};

const initialForm = {
  patient_pseudo_id: `child-${Math.random().toString(16).slice(2, 7)}`,
  age_months: 24,
  sex: 'F',
  ward: 'Bambatha',
  chief_complaint: 'cough and fever',
  symptoms: ['fever', 'cough', 'fast_breathing'],
  temperature_c: 38.5,
  respiratory_rate: 48,
  danger_signs: []
};

function App() {
  const [tab, setTab] = useState('intake');
  const [offline, setOffline] = useState(false);
  const [pendingCases, setPendingCases] = useState([]);
  const [syncState, setSyncState] = useState('Synced');
  const [form, setForm] = useState(initialForm);
  const [lastResult, setLastResult] = useState(null);
  const [dashboard, setDashboard] = useState(null);
  const [bqStatus, setBqStatus] = useState(null);
  const [voiceTranscript, setVoiceTranscript] = useState('');
  const [voiceStatus, setVoiceStatus] = useState('Ready');
  const [isListening, setIsListening] = useState(false);
  const recognitionRef = useRef(null);
  const listeningRef = useRef(false);
  const finalTranscriptRef = useRef('');
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const transcriberRef = useRef(null);
  const transcriberModelRef = useRef('');
  const [isWhisperTranscribing, setIsWhisperTranscribing] = useState(false);
  const [isRecordingIntake, setIsRecordingIntake] = useState(false);
  const [isGeminiTranscribing, setIsGeminiTranscribing] = useState(false);

  const queuedLabel = useMemo(() => `${pendingCases.length}`, [pendingCases.length]);

  async function api(path, options = {}) {
    const response = await fetch(`${BACKEND_URL}${path}`, {
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return response.json();
  }

  async function refreshDashboard() {
    try {
      const [dash, bq] = await Promise.all([api('/api/v1/dashboard'), api('/api/v1/bigquery/status')]);
      setDashboard(dash);
      setBqStatus(bq);
    } catch (error) {
      setSyncState(`Backend unavailable: ${error.message}`);
    }
  }

  useEffect(() => {
    refreshDashboard();
    const timer = window.setInterval(refreshDashboard, 8000);
    return () => window.clearInterval(timer);
  }, []);

  function updateField(name, value) {
    setForm((current) => ({ ...current, [name]: value }));
  }

  function toggleList(name, value) {
    setForm((current) => {
      const set = new Set(current[name]);
      if (set.has(value)) set.delete(value);
      else set.add(value);
      return { ...current, [name]: Array.from(set) };
    });
  }

  function applyExtractedCase(extracted) {
    setForm((current) => ({
      ...current,
      ...extracted,
      patient_pseudo_id: extracted.patient_pseudo_id || current.patient_pseudo_id,
      ward: extracted.ward || current.ward,
      sex: extracted.sex || current.sex,
      symptoms: Array.isArray(extracted.symptoms) ? extracted.symptoms : current.symptoms,
      danger_signs: Array.isArray(extracted.danger_signs) ? extracted.danger_signs : current.danger_signs,
      temperature_c: extracted.temperature_c ?? current.temperature_c,
      respiratory_rate: extracted.respiratory_rate ?? current.respiratory_rate
    }));
  }

  async function submitCase(event) {
    event.preventDefault();
    const payload = {
      ...form,
      client_case_id: `local-${crypto.randomUUID()}`,
      chv_name: 'Aisha',
      captured_offline: offline,
      captured_at: new Date().toISOString(),
      age_months: Number(form.age_months),
      temperature_c: Number(form.temperature_c),
      respiratory_rate: Number(form.respiratory_rate)
    };

    if (offline) {
      setPendingCases((cases) => [...cases, payload]);
      setSyncState(`Pending Sync (${pendingCases.length + 1})`);
      setLastResult({
        urgency: 'PENDING',
        classification: 'Queued locally',
        rationale: 'This case is safely stored on-device and will sync when connectivity returns.',
        actions: ['Reconnect and press Sync queue'],
        model: 'On-device queue'
      });
      return;
    }

    try {
      const result = await api('/api/v1/triage', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      setLastResult(result);
      setSyncState('Synced');
      refreshDashboard();
    } catch (error) {
      setSyncState(`Sync Error: ${error.message}`);
    }
  }

  async function syncQueue() {
    if (offline) {
      setSyncState(`Offline - Pending Sync (${pendingCases.length})`);
      return;
    }
    if (pendingCases.length === 0) {
      setSyncState('Synced');
      return;
    }
    setSyncState('Syncing');
    try {
      const result = await api('/api/v1/sync', {
        method: 'POST',
        body: JSON.stringify({ cases: pendingCases })
      });
      setPendingCases([]);
      setLastResult(result.cases?.[0] || null);
      setSyncState('Synced');
      refreshDashboard();
    } catch (error) {
      setSyncState(`Sync Error: ${error.message}`);
    }
  }

  async function triggerCluster() {
    await api('/api/v1/demo/outbreak?ward=Bambatha&count=3', { method: 'POST' });
    refreshDashboard();
  }

  function startVoiceIntake() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setVoiceStatus('Speech recognition is not supported in this browser. Paste a transcript instead.');
      return;
    }

    if (listeningRef.current && recognitionRef.current) {
      listeningRef.current = false;
      recognitionRef.current.stop();
      setIsListening(false);
      setVoiceStatus('Transcript ready for extraction');
      return;
    }

    const recognition = recognitionRef.current || new SpeechRecognition();
    recognitionRef.current = recognition;
    finalTranscriptRef.current = voiceTranscript.trim() ? `${voiceTranscript.trim()} ` : '';
    recognition.lang = 'en-US';
    recognition.interimResults = true;
    recognition.continuous = true;
    listeningRef.current = true;
    setIsListening(true);
    setVoiceStatus('Listening - click again to stop');

    recognition.onresult = (event) => {
      let interimTranscript = '';
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const transcript = event.results[index][0].transcript;
        if (event.results[index].isFinal) finalTranscriptRef.current += `${transcript} `;
        else interimTranscript += transcript;
      }
      setVoiceTranscript(`${finalTranscriptRef.current}${interimTranscript}`.trim());
    };
    recognition.onerror = (event) => {
      if (event.error === 'no-speech' && listeningRef.current) {
        setVoiceStatus('Listening - waiting for speech');
        return;
      }
      listeningRef.current = false;
      setIsListening(false);
      setVoiceStatus(`Voice error: ${event.error}`);
    };
    recognition.onend = () => {
      if (listeningRef.current) {
        try {
          recognition.start();
        } catch {
          listeningRef.current = false;
          setIsListening(false);
          setVoiceStatus('Transcript ready for extraction');
        }
        return;
      }
      setIsListening(false);
      setVoiceStatus('Transcript ready for extraction');
    };
    try {
      recognition.start();
    } catch {
      setVoiceStatus('Voice recognition is already starting');
    }
  }

  async function startIntakeRecording() {
    if (!navigator.mediaDevices?.getUserMedia) {
      setVoiceStatus('This browser cannot access the microphone for recording.');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioChunksRef.current = [];
      const recorder = new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) audioChunksRef.current.push(event.data);
      };
      recorder.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());
        await transcribeAndExtractWithGemini();
      };
      recorder.start();
      setIsRecordingIntake(true);
      setVoiceStatus('Recording intake. Stop when the caregiver note is complete.');
    } catch (error) {
      setVoiceStatus(`Microphone error: ${error.message}`);
    }
  }

  function stopIntakeRecording() {
    if (mediaRecorderRef.current?.state === 'recording') {
      setIsRecordingIntake(false);
      mediaRecorderRef.current.stop();
    }
  }

  async function transcribeAndExtractWithGemini() {
    if (audioChunksRef.current.length === 0) {
      setVoiceStatus('No audio captured for Gemini transcription.');
      return;
    }

    setIsGeminiTranscribing(true);
    setVoiceStatus('Gemini is transcribing audio and extracting fields');
    const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
    const formData = new FormData();
    formData.append('file', audioBlob, 'intake.webm');

    try {
      const response = await fetch(`${BACKEND_URL}/api/v1/voice/audio-extract`, {
        method: 'POST',
        body: formData
      });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      const result = await response.json();
      if (result.error) throw new Error(result.error);
      setVoiceStatus('Gemini audio fields prefilled - CHV review required');
      if (result.transcript) setVoiceTranscript(result.transcript);
      applyExtractedCase(result.case || {});
    } catch (error) {
      setVoiceStatus(`Gemini failed, falling back to on-device Whisper: ${error.message}`);
      await transcribeWithWhisper({ extractAfterTranscription: true });
    } finally {
      setIsGeminiTranscribing(false);
    }
  }

  async function transcribeWithWhisper({ extractAfterTranscription = false } = {}) {
    if (audioChunksRef.current.length === 0) {
      setVoiceStatus('No audio captured for local transcription.');
      return;
    }

    setIsWhisperTranscribing(true);
    setVoiceStatus('Loading on-device Whisper. First run may take a minute.');
    const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
    const audioUrl = URL.createObjectURL(audioBlob);

    try {
      if (!transcriberRef.current) {
        const { pipeline } = await import('@huggingface/transformers');
        const hasWebGpu = Boolean(navigator.gpu);
        const preferredModel = hasWebGpu ? 'onnx-community/whisper-small.en' : 'Xenova/whisper-small.en';
        const fallbackModel = hasWebGpu ? 'onnx-community/whisper-tiny.en' : 'Xenova/whisper-tiny.en';

        try {
          setVoiceStatus('Loading higher-accuracy on-device Whisper small model');
          transcriberRef.current = await pipeline(
            'automatic-speech-recognition',
            preferredModel,
            hasWebGpu ? { device: 'webgpu' } : {}
          );
          transcriberModelRef.current = preferredModel;
        } catch {
          setVoiceStatus('Whisper small could not load; falling back to tiny model');
          transcriberRef.current = await pipeline(
            'automatic-speech-recognition',
            fallbackModel,
            hasWebGpu ? { device: 'webgpu' } : {}
          );
          transcriberModelRef.current = fallbackModel;
        }
      }
      setVoiceStatus(`Transcribing locally with ${transcriberModelRef.current}`);
      const output = await transcriberRef.current(audioUrl);
      const transcript = output.text || '';
      setVoiceTranscript(transcript);
      if (extractAfterTranscription && transcript.trim()) {
        setVoiceStatus('Whisper transcript ready, extracting fields with Gemini');
        const result = await api('/api/v1/voice/extract', {
          method: 'POST',
          body: JSON.stringify({ transcript })
        });
        applyExtractedCase(result.case || {});
        setVoiceStatus(`Fields prefilled from ${transcriberModelRef.current} transcript - CHV review required`);
      } else {
        setVoiceStatus(`Local transcript ready from ${transcriberModelRef.current} - review, then prefill`);
      }
    } catch (error) {
      setVoiceStatus(`Local Whisper failed: ${error.message}`);
    } finally {
      URL.revokeObjectURL(audioUrl);
      setIsWhisperTranscribing(false);
    }
  }

  async function extractVoiceIntake() {
    if (!voiceTranscript.trim()) {
      setVoiceStatus('Record or paste a transcript first');
      return;
    }
    setVoiceStatus('Gemini is extracting fields');
    try {
      const result = await api('/api/v1/voice/extract', {
        method: 'POST',
        body: JSON.stringify({ transcript: voiceTranscript })
      });
      const extracted = result.case || {};
      applyExtractedCase(extracted);
      setVoiceStatus('Fields prefilled - CHV review required');
    } catch (error) {
      setVoiceStatus(`Extraction failed: ${error.message}`);
    }
  }

  return (
    <main>
      <Hero />
      <section className="nav">
        {[
          ['intake', 'CHV Intake'],
          ['dashboard', 'District Dashboard'],
          ['story', 'Story']
        ].map(([id, label]) => (
          <button className={tab === id ? 'active' : ''} key={id} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </section>

      {tab === 'intake' && (
        <Intake
          form={form}
          offline={offline}
          queuedLabel={queuedLabel}
          syncState={syncState}
          lastResult={lastResult}
          setOffline={setOffline}
          updateField={updateField}
          toggleList={toggleList}
          submitCase={submitCase}
          syncQueue={syncQueue}
          voiceTranscript={voiceTranscript}
          voiceStatus={voiceStatus}
          isListening={isListening}
          isWhisperTranscribing={isWhisperTranscribing}
          isRecordingIntake={isRecordingIntake}
          isGeminiTranscribing={isGeminiTranscribing}
          setVoiceTranscript={setVoiceTranscript}
          startVoiceIntake={startVoiceIntake}
          startIntakeRecording={startIntakeRecording}
          stopIntakeRecording={stopIntakeRecording}
          extractVoiceIntake={extractVoiceIntake}
        />
      )}
      {tab === 'dashboard' && (
        <Dashboard
          data={dashboard}
          bqStatus={bqStatus}
          refreshDashboard={refreshDashboard}
          triggerCluster={triggerCluster}
        />
      )}
      {tab === 'story' && <Story />}
    </main>
  );
}

function Hero() {
  return (
    <section className="hero fade-in">
      <div>
        <p className="eyebrow">Google Buildathon / AI for Health</p>
        <h1>Sentinel Health</h1>
        <p className="subtitle">
          A modern field triage and outbreak command center for CHVs and district health teams.
        </p>
      </div>
      <div className="hero-orbit">
        <span />
        <strong>One intake</strong>
        <em>two life-saving signals</em>
      </div>
    </section>
  );
}

function Intake(props) {
  const {
    form,
    offline,
    queuedLabel,
    syncState,
    lastResult,
    setOffline,
    updateField,
    toggleList,
    submitCase,
    syncQueue,
    voiceTranscript,
    voiceStatus,
    isListening,
    isWhisperTranscribing,
    isRecordingIntake,
    isGeminiTranscribing,
    setVoiceTranscript,
    startVoiceIntake,
    startIntakeRecording,
    stopIntakeRecording,
    extractVoiceIntake
  } = props;

  return (
    <section className="grid two fade-up">
      <div className="panel">
        <div className="section-title">
          <p className="eyebrow">Aisha / Community Health Volunteer</p>
          <h2>Field Intake</h2>
        </div>

        <div className="status-row">
          <label className="switch">
            <input type="checkbox" checked={offline} onChange={(event) => setOffline(event.target.checked)} />
            <span>Simulate offline mode</span>
          </label>
          <Metric label="Queued cases" value={queuedLabel} />
          <Metric label="Sync state" value={syncState.split(':')[0]} />
        </div>

        <button className="ghost" onClick={syncQueue}>Sync queue</button>

        <div className="voice-panel">
          <div>
            <p className="eyebrow">Voice-assisted intake</p>
            <h3>Speak naturally, then review the form</h3>
            <p>
              Example: "Two year old girl in Bambatha has fever and cough for three days,
              breathing fast, temperature thirty nine."
            </p>
          </div>
          <div className="voice-actions">
            {!isRecordingIntake && (
              <button
                className="primary"
                onClick={startIntakeRecording}
                type="button"
                disabled={isGeminiTranscribing || isWhisperTranscribing}
              >
                {isGeminiTranscribing || isWhisperTranscribing ? 'Processing voice...' : 'Record intake'}
              </button>
            )}
            {isRecordingIntake && (
              <button className="recording" onClick={stopIntakeRecording} type="button">
                Stop and prefill
              </button>
            )}
            <button className="ghost" onClick={extractVoiceIntake} type="button">Prefill from transcript</button>
          </div>
          <textarea
            value={voiceTranscript}
            onChange={(event) => setVoiceTranscript(event.target.value)}
            placeholder="Transcript appears here. You can edit it before Gemini extracts fields."
          />
          <small>{voiceStatus}</small>
        </div>

        <form className="case-form" onSubmit={submitCase}>
          <Input label="Patient pseudo ID" value={form.patient_pseudo_id} onChange={(value) => updateField('patient_pseudo_id', value)} />
          <Input label="Chief complaint" value={form.chief_complaint} onChange={(value) => updateField('chief_complaint', value)} />
          <Input label="Age in months" type="number" value={form.age_months} onChange={(value) => updateField('age_months', value)} />
          <Input label="Temperature C" type="number" step="0.1" value={form.temperature_c} onChange={(value) => updateField('temperature_c', value)} />
          <Input label="Respiratory rate" type="number" value={form.respiratory_rate} onChange={(value) => updateField('respiratory_rate', value)} />
          <label>
            Ward
            <select value={form.ward} onChange={(event) => updateField('ward', event.target.value)}>
              {['Bambatha', 'Kijani', 'Ndlovu', 'Mtoni'].map((ward) => <option key={ward}>{ward}</option>)}
            </select>
          </label>

          <Checklist title="Symptoms" items={symptoms} selected={form.symptoms} onToggle={(value) => toggleList('symptoms', value)} />
          <Checklist
            title="Danger signs"
            items={Object.entries(dangerSigns)}
            selected={form.danger_signs}
            onToggle={(value) => toggleList('danger_signs', value)}
            pair
          />

          <button className="primary" type="submit">Submit case</button>
        </form>
      </div>

      <ResultCard result={lastResult} />
    </section>
  );
}

function formatLabel(value) {
  return String(value || 'Unknown').replaceAll('_', ' ');
}

function countBy(items, key) {
  return items.reduce((counts, item) => {
    const value = item[key] || 'Unknown';
    return { ...counts, [value]: (counts[value] || 0) + 1 };
  }, {});
}

function Dashboard({ data, bqStatus, refreshDashboard, triggerCluster }) {
  const summary = data?.summary || {};
  const cases = data?.cases || [];
  const alerts = data?.alerts || [];
  const totalVisibleCases = Math.max(cases.length, 1);
  const urgencyCounts = countBy(cases, 'urgency');
  const wardRows = Object.entries(countBy(cases, 'ward')).sort((a, b) => b[1] - a[1]);
  const syndromeRows = Object.entries(countBy(cases, 'classification')).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const maxWardCases = Math.max(...wardRows.map(([, count]) => count), 1);
  const lastRefresh = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  return (
    <section className="fade-up">
      <div className="section-title">
        <p className="eyebrow">Dr Kwame / District Health Officer</p>
        <h2>District Command Dashboard</h2>
        <p className="muted">
          A live operating picture: where cases are clustering, how urgent they are, and which alerts need action.
        </p>
      </div>

      <div className="actions">
        <button className="ghost" onClick={refreshDashboard}>Refresh dashboard</button>
        <button className="primary" onClick={triggerCluster}>Trigger demo diarrhoea cluster</button>
      </div>

      <div className="grid four">
        <Metric label="Cases today" value={summary.cases_today ?? 0} />
        <Metric label="Urgent today" value={summary.urgent_cases_today ?? 0} />
        <Metric label="Active alerts" value={summary.active_alerts ?? 0} />
        <Metric label="Data layer" value={bqStatus?.ready ? 'BigQuery' : 'Memory'} />
      </div>

      <div className="dashboard-command">
        <div className="panel map-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Ward burden</p>
              <h3>Where pressure is building</h3>
            </div>
            <span>Updated {lastRefresh}</span>
          </div>
          <div className="ward-grid">
            {wardRows.length === 0 && <p className="muted">No ward activity yet.</p>}
            {wardRows.map(([ward, count]) => (
              <article className="ward-card" key={ward} style={{ '--heat': count / maxWardCases }}>
                <span>{ward}</span>
                <strong>{count}</strong>
                <small>{count === 1 ? 'case' : 'cases'}</small>
              </article>
            ))}
          </div>
        </div>

        <div className="panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Clinical mix</p>
              <h3>Urgency and syndromes</h3>
            </div>
          </div>
          <div className="urgency-bars">
            {['RED', 'YELLOW', 'GREEN'].map((urgency) => {
              const count = urgencyCounts[urgency] || 0;
              const width = `${Math.round((count / totalVisibleCases) * 100)}%`;
              return (
                <div className="bar-row" key={urgency}>
                  <span>{urgency}</span>
                  <div className="bar-track">
                    <i className={urgency.toLowerCase()} style={{ '--bar-width': width }} />
                  </div>
                  <b>{count}</b>
                </div>
              );
            })}
          </div>
          <div className="syndrome-list">
            {syndromeRows.length === 0 && <p className="muted">No syndrome mix yet.</p>}
            {syndromeRows.map(([classification, count]) => (
              <div className="syndrome-row" key={classification}>
                <span>{formatLabel(classification)}</span>
                <strong>{count}</strong>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="grid two dashboard-grid">
        <div className="panel outbreak-panel">
          <h3>Outbreak Watch</h3>
          {alerts.length === 0 && <p className="muted">No active alerts yet. Trigger the demo cluster to show threshold detection.</p>}
          {alerts.map((alert) => {
            const progress = Math.min(100, Math.round(((alert.case_count || 0) / Math.max(alert.threshold || 1, 1)) * 100));
            return (
              <article className="alert" key={alert.id}>
                <div className="alert-topline">
                  <strong>{formatLabel(alert.classification)}</strong>
                  <b>{alert.status}</b>
                </div>
                <p>{alert.message}</p>
                <div className="alert-progress">
                  <i style={{ '--bar-width': `${progress}%` }} />
                </div>
                <span>
                  {alert.ward} / {alert.case_count} of {alert.threshold} threshold / {alert.window_hours}h window
                </span>
              </article>
            );
          })}
        </div>

        <div className="panel">
          <h3>Latest Cases</h3>
          <div className="case-list">
            {cases.map((item) => (
              <article className="case-row" key={item.id}>
                <div>
                  <strong>{formatLabel(item.classification)}</strong>
                  <span>{item.ward} / {item.age_months} months / {item.chv_name}</span>
                </div>
                <b className={`pill ${(item.urgency || 'pending').toLowerCase()}`}>{item.urgency}</b>
              </article>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function Story() {
  return (
    <section className="grid three fade-up">
      <Metric label="Human need" value="24h" caption="A severe case can turn fatal fast." />
      <Metric label="Google AI" value="Gemini" caption="Reasoning support for non-critical cases." />
      <Metric label="Cloud path" value="Run + BigQuery" caption="Two services plus analytics-ready data." />
    </section>
  );
}

function ResultCard({ result }) {
  if (!result) {
    return (
      <div className="panel result-card empty">
        <p className="eyebrow">Triage output</p>
        <h2>Submit a case to generate decision support.</h2>
      </div>
    );
  }
  return (
    <div className="panel result-card">
      <p className="eyebrow">Triage output</p>
      <b className={`pill ${(result.urgency || 'pending').toLowerCase()}`}>{result.urgency}</b>
      <h2>{result.classification?.replaceAll('_', ' ')}</h2>
      <p>{result.rationale}</p>
      <div className="actions-list">
        {(result.actions || []).map((action) => <span key={action}>{action}</span>)}
      </div>
      <small>{result.model}</small>
    </div>
  );
}

function Metric({ label, value, caption }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
      {caption && <p>{caption}</p>}
    </div>
  );
}

function Input({ label, value, onChange, type = 'text', step }) {
  return (
    <label>
      {label}
      <input type={type} step={step} value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function Checklist({ title, items, selected, onToggle, pair = false }) {
  return (
    <fieldset>
      <legend>{title}</legend>
      <div className="chips">
        {items.map((item) => {
          const value = pair ? item[0] : item;
          const label = pair ? item[1] : item.replaceAll('_', ' ');
          return (
            <button
              className={selected.includes(value) ? 'chip selected' : 'chip'}
              key={value}
              type="button"
              onClick={() => onToggle(value)}
            >
              {label}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

createRoot(document.getElementById('root')).render(<App />);
