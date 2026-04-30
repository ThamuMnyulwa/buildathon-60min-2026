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
          setVoiceTranscript={setVoiceTranscript}
          startVoiceIntake={startVoiceIntake}
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
    setVoiceTranscript,
    startVoiceIntake,
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
            <button className={isListening ? 'recording' : 'ghost'} onClick={startVoiceIntake} type="button">
              {isListening ? 'Stop voice' : 'Start voice'}
            </button>
            <button className="primary" onClick={extractVoiceIntake} type="button">Prefill with Gemini</button>
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

function Dashboard({ data, bqStatus, refreshDashboard, triggerCluster }) {
  const summary = data?.summary || {};
  return (
    <section className="fade-up">
      <div className="section-title">
        <p className="eyebrow">Dr Kwame / District Health Officer</p>
        <h2>District Command Dashboard</h2>
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

      <div className="grid two dashboard-grid">
        <div className="panel">
          <h3>Active Alerts</h3>
          {(data?.alerts || []).length === 0 && <p className="muted">No active alerts yet.</p>}
          {(data?.alerts || []).map((alert) => (
            <article className="alert" key={alert.id}>
              <strong>{alert.classification.replaceAll('_', ' ')}</strong>
              <p>{alert.message}</p>
              <span>{alert.status} / threshold {alert.threshold}</span>
            </article>
          ))}
        </div>

        <div className="panel">
          <h3>Latest Cases</h3>
          <div className="case-list">
            {(data?.cases || []).map((item) => (
              <article className="case-row" key={item.id}>
                <div>
                  <strong>{item.classification.replaceAll('_', ' ')}</strong>
                  <span>{item.ward} / {item.age_months} months</span>
                </div>
                <b className={`pill ${item.urgency.toLowerCase()}`}>{item.urgency}</b>
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
