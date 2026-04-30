# Sentinel Health: AI-Powered Triage and Outbreak Detection for Community Health Volunteers

> One symptom intake. Two outputs: a CHV who knows what to do, and a district officer who knows when something's wrong.

| Field               | Value                        |
| ------------------- | ---------------------------- |
| **Project**         | Sentinel Health              |
| **Version**         | 0.1 (Hackathon POC)          |
| **Author**          | Thamu                        |
| **Date**            | April 2026                   |
| **Status**          | Draft - Implementation Phase |
| **Hackathon Track** | AI for Health                |

---

## 1. Executive Summary

Sentinel is an AI-enabled web application that helps Community Health Volunteers (CHVs) triage childhood illnesses (acute malaria, pneumonia, diarrhoea, severe malnutrition signs) at the point of contact, while simultaneously building a real-time outbreak detection system for District Health Officers from the same data flow.

The system is built on three primitives:

1. **Guided symptom intake** aligned with the WHO Integrated Management of Childhood Illness (IMCI) protocol that CHVs are already trained on
2. **AI triage layer** powered by Gemma (served via Vertex AI Model Garden) acting as a stand-in for MedGemma 1.5 4B, with a hard-coded IMCI rule engine as a safety floor for critical signs
3. **Spatio-temporal anomaly detector** that emits real-time outbreak alerts to district officials when geo-temporal case clusters exceed threshold

This POC ships as a **Streamlit frontend** talking to a **FastAPI backend** with a **PostgreSQL datastore**, fully containerised via docker-compose. Designed to demo end-to-end in 5 minutes.

---

## 2. Problem Statement

In rural Sub-Saharan Africa, a child with severe malaria or pneumonia can die within 24 hours of symptom onset. Community Health Volunteers are the first and often the only point of contact with the health system, but face three structural problems:

- **Diagnostic uncertainty**: CHVs have varying training depth and limited reference material at the point of care
- **Delayed escalation**: Critical danger signs are sometimes under-prioritised, delaying referral
- **Outbreak invisibility**: Cluster patterns (cholera, measles, viral haemorrhagic fevers) only become visible to district officials after days of paper-based reporting

Existing AI tools either target clinicians (not CHVs), require connectivity that rural wards do not have, or solve one of the three problems but not both.

---

## 3. Goals and Non-Goals

### In Scope (POC)

- **G1**: CHV completes a paediatric case intake in under 90 seconds
- **G2**: System produces an IMCI-aligned triage recommendation with explicit urgency tier and action
- **G3**: Critical signs hard-trigger urgent referral, bypassing AI inference entirely
- **G4**: District officer sees a live case feed and receives outbreak alerts when geo-temporal clusters exceed threshold
- **G5**: Whole stack runs locally via `docker-compose up` for the hackathon demo
- **G6**: Demo runs end-to-end in 5 minutes including outbreak simulation

### Out of Scope (Future)

- Production-grade authentication and multi-tenancy (POC uses a fixed CHV identity)
- Offline-first mobile sync (stretch; mentioned in pitch, not built)
- Real MedGemma 1.5 deployment (using Gemma stand-in per scope decision)
- Computer vision malnutrition detection (separate model, separate validation burden)
- Integration with national HIS (DHIS2)
- Multi-language UI (English only for the demo)
- Real geographic coordinates (using ward-level synthetic locations)

---

## 4. Personas

### Aisha - Community Health Volunteer (Primary User)

- Lives in a rural ward, serves around 150 households
- Smartphone-literate but not deeply tech-savvy
- Trained in basic IMCI but relies on memory under pressure
- Works alone, no immediate clinical supervision
- **Needs**: confidence, speed, an unambiguous next-action

### Dr Kwame - District Health Officer (Secondary User)

- Oversees around 20 CHVs across the district
- Sits in the district health office with reliable internet
- Currently relies on weekly paper reports for outbreak signals
- **Needs**: real-time visibility, threshold-based alerts, geographic context

### Mama Adeyemi - Caregiver (Indirect Beneficiary)

- Brings her sick child to Aisha
- Needs to feel her concerns are taken seriously and acted upon

---

## 5. User Stories

### US-01: CHV Guided Symptom Intake

**As** Aisha, a CHV
**I want** to enter a child's symptoms via a guided form
**So that** I capture all relevant clinical data without having to recall the full IMCI checklist

**Acceptance Criteria**
- Form captures: age in months (0-59), chief complaint, symptom multi-select, duration per symptom, vital signs (temp, respiratory rate)
- Form explicitly surfaces IMCI critical signs as a separate prominent checklist
- Total intake under 90 seconds for a typical case
- Form validates required fields before submit
- Submit action is one click

### US-02: AI-Powered Triage Recommendation

**As** Aisha
**I want** an AI-suggested classification and recommended action
**So that** I have decision support beyond my memory of IMCI

**Acceptance Criteria**
- Response within 5 seconds of submit
- Output includes: classification, urgency tier (RED/YELLOW/GREEN per IMCI colour coding), recommended actions, brief reasoning
- Output is framed as decision support, not diagnosis (visible disclaimer in UI)
- Confidence level (low/medium/high) is shown
- Follow-up questions surfaced when confidence is low

### US-03: Critical Sign Hard-Block (Safety Floor)

**As** Aisha
**When** my patient presents with any IMCI critical sign
**I want** the system to immediately flag URGENT REFERRAL
**So that** life-threatening cases cannot be missed even if the AI fails

**Acceptance Criteria**
- The IMCI critical-sign list bypasses LLM inference entirely (rule-based)
- Response is instant (under 200ms)
- Action is unambiguous: "URGENT REFERRAL - arrange transport now"
- Pre-referral treatment guidance is shown where applicable (e.g. rectal artesunate for suspected severe malaria with convulsions)
- This path is independently testable without LLM connectivity

### US-04: Case Persistence and Confirmation

**As** Aisha
**I want** each case I assess to be saved to a central system
**So that** my work is recorded and acted on by district officials

**Acceptance Criteria**
- Submitted case persists with timestamp, ward, de-identified patient ID
- Confirmation shown to the CHV
- Case appears in district feed within 10 seconds

### US-05: District Real-Time Case Feed

**As** Dr Kwame, a District Officer
**I want** to see cases as they are submitted across my district
**So that** I have situational awareness of disease patterns

**Acceptance Criteria**
- Live-updating feed (auto-refresh or websocket) without manual reload
- Each case shows: ward, age, classification, urgency, submitted-by, time
- Filters by ward, classification, urgency tier
- Summary KPIs (cases today, RED cases today, active outbreak alerts)

### US-06: Outbreak Alert

**As** Dr Kwame
**I want** to be alerted when geo-temporal clusters of similar cases exceed threshold
**So that** I can dispatch a rapid response team before an outbreak escalates

**Acceptance Criteria**
- Detection job runs every N minutes (default 5)
- Alert fires when N cases of the same syndromic class occur in one ward within a rolling time window (defaults: 3 cases / 48 hours / ward for diarrhoeal, measles-like rash, acute respiratory infection)
- Alert payload includes: location, count, classification, recommended action, time of detection
- Alert appears as a dashboard banner and a row in the alerts log
- One-click acknowledgement marks the alert as actioned

---

## 6. System Architecture

### 6.1 High-Level Diagram (text)

```
┌─────────────────────┐         ┌──────────────────────────────┐
│  Streamlit Frontend │  HTTPS  │       FastAPI Backend        │
│                     │ ──────> │                              │
│  - CHV Triage Form  │         │  /triage    /cases           │
│  - Case History     │         │  /outbreaks /health          │
│  - District Dash    │         │                              │
│  - Outbreak Alerts  │ <────── │                              │
└─────────────────────┘ stream  │  ┌─────────────────────┐    │
                                 │  │  IMCI Rule Engine   │    │
                                 │  │  (safety floor)     │    │
                                 │  └─────────┬───────────┘    │
                                 │            │ if no critical │
                                 │            ▼ signs          │
                                 │  ┌─────────────────────┐    │
                                 │  │  Triage Agent       │    │
                                 │  │  (Gemma client)     │────┼──> Vertex AI
                                 │  └─────────────────────┘    │    Gemma endpoint
                                 │                              │    (stand-in for
                                 │  ┌─────────────────────┐    │     MedGemma 1.5 4B)
                                 │  │  Outbreak Detector  │    │
                                 │  │  (scheduled job)    │    │
                                 │  └─────────┬───────────┘    │
                                 └────────────┼─────────────────┘
                                              ▼
                                       ┌────────────┐
                                       │ PostgreSQL │
                                       │            │
                                       │ - cases    │
                                       │ - alerts   │
                                       │ - chvs     │
                                       │ - wards    │
                                       └────────────┘
```

### 6.2 Component Responsibilities

| Component              | Responsibility                                                                                                                                                 |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Streamlit frontend** | Multi-page UI for CHV intake and District dashboard. Pure view layer, all logic delegated to backend                                                           |
| **FastAPI backend**    | REST API surface, request validation, orchestration, persistence                                                                                               |
| **IMCI rule engine**   | Deterministic Python module encoding WHO IMCI critical signs. Runs FIRST on every case. If any critical sign present, bypasses LLM and returns URGENT_REFERRAL |
| **Triage agent**       | Wraps Vertex AI Gemma endpoint. Builds structured prompt, parses JSON response, validates schema                                                               |
| **Outbreak detector**  | APScheduler job (or simple cron loop) that queries cases table, runs anomaly detection, writes alerts                                                          |
| **PostgreSQL**         | Single source of truth for cases, alerts, ward registry                                                                                                        |

### 6.3 Why this split

- **IMCI rule engine first** is the non-negotiable safety pattern: an LLM should never be the first or only line between a child with convulsions and a referral
- **Gemma now, MedGemma later** is a swap behind a stable interface. The triage agent module exposes `triage(case) -> TriageResponse`. Implementations are interchangeable
- **Outbreak as a separate scheduled job** keeps it decoupled. Same data, different consumer
- **PostgreSQL not SQLite** because (a) you prefer it, (b) docker-compose adds 30 seconds and gives you a production-shaped stack judges will recognise

---

## 7. Technical Stack

### 7.1 Runtime

| Layer              | Choice                    | Why                                                          |
| ------------------ | ------------------------- | ------------------------------------------------------------ |
| Language           | Python 3.12               | Aligns with `uv` workflow                                    |
| Package manager    | `uv`                      | Per your standing preference                                 |
| Backend framework  | FastAPI                   | Async, Pydantic schemas, OpenAPI auto-doc                    |
| Frontend framework | Streamlit                 | Fast to ship, multi-page support, good enough for hackathon  |
| Database           | PostgreSQL 16             | Per your preference; supports `tsrange` for outbreak queries |
| ORM                | SQLAlchemy 2.0 + Alembic  | Standard                                                     |
| LLM client         | `google-cloud-aiplatform` | Official Vertex AI SDK                                       |
| Scheduler          | APScheduler               | In-process, sufficient for POC                               |
| Containerisation   | Docker + docker-compose   | Single-command spin-up                                       |

### 7.2 Model

- **Primary**: Gemma served via Vertex AI Model Garden as an HTTPS endpoint
- **Demo fallback**: Local Gemma via Ollama (in case conference wifi misbehaves)
- **Mock mode**: A `TriageAgentMock` class returns deterministic responses keyed off input. Critical for offline rehearsal and unit tests

The `TriageAgent` interface is implementation-agnostic:

```python
class TriageAgent(Protocol):
    async def triage(self, case: CaseInput) -> TriageOutput: ...
```

Three implementations: `VertexGemmaAgent`, `OllamaGemmaAgent`, `MockAgent`. Selected by env var `TRIAGE_BACKEND`.

### 7.3 Repository Structure

```
sentinel-health/
├── README.md
├── PRD.md
├── docker-compose.yml
├── .env.example
├── pyproject.toml                  # workspace root
├── backend/
│   ├── pyproject.toml
│   ├── Dockerfile
│   ├── alembic.ini
│   ├── alembic/
│   │   └── versions/
│   ├── src/sentinel_backend/
│   │   ├── __init__.py
│   │   ├── main.py                 # FastAPI app factory
│   │   ├── config.py               # pydantic-settings
│   │   ├── api/
│   │   │   ├── __init__.py
│   │   │   ├── triage.py           # POST /triage
│   │   │   ├── cases.py            # GET/POST /cases
│   │   │   ├── outbreaks.py        # GET /outbreaks
│   │   │   └── health.py           # GET /health
│   │   ├── core/
│   │   │   ├── imci.py             # Rule engine (critical signs)
│   │   │   └── prompts.py          # System prompt for Gemma
│   │   ├── agents/
│   │   │   ├── base.py             # Protocol
│   │   │   ├── vertex_gemma.py     # Vertex AI client
│   │   │   ├── ollama_gemma.py     # Local fallback
│   │   │   └── mock.py             # Deterministic mock
│   │   ├── db/
│   │   │   ├── models.py           # SQLAlchemy models
│   │   │   └── session.py
│   │   ├── outbreak/
│   │   │   ├── detector.py         # Anomaly detection
│   │   │   └── scheduler.py        # APScheduler bootstrap
│   │   └── schemas/
│   │       ├── case.py
│   │       ├── triage.py
│   │       └── alert.py
│   └── tests/
│       ├── test_imci_rule_engine.py
│       ├── test_triage_endpoint.py
│       └── test_outbreak_detector.py
├── frontend/
│   ├── pyproject.toml
│   ├── Dockerfile
│   └── src/sentinel_frontend/
│       ├── app.py                  # Streamlit entry
│       ├── api_client.py           # httpx client
│       ├── pages/
│       │   ├── 1_🩺_CHV_Triage.py
│       │   ├── 2_📋_Case_History.py
│       │   ├── 3_🗺️_District_Dashboard.py
│       │   └── 4_🚨_Outbreak_Alerts.py
│       └── components/
│           ├── triage_card.py
│           └── case_table.py
└── seed/
    ├── wards.json                  # Synthetic ward registry
    ├── chvs.json                   # Synthetic CHV identities
    └── outbreak_simulator.py       # Generates demo outbreak cases
```

---

## 8. Data Model

### 8.1 Tables

```sql
-- wards: synthetic geographic units
CREATE TABLE wards (
    id           UUID PRIMARY KEY,
    name         TEXT NOT NULL,
    district     TEXT NOT NULL,
    centroid_lat NUMERIC(9,6),
    centroid_lng NUMERIC(9,6)
);

-- chvs: Community Health Volunteers
CREATE TABLE chvs (
    id      UUID PRIMARY KEY,
    name    TEXT NOT NULL,
    ward_id UUID NOT NULL REFERENCES wards(id)
);

-- cases: each triage event
CREATE TABLE cases (
    id                  UUID PRIMARY KEY,
    chv_id              UUID NOT NULL REFERENCES chvs(id),
    ward_id             UUID NOT NULL REFERENCES wards(id),
    patient_pseudo_id   TEXT NOT NULL,           -- hashed, not real PII
    age_months          INTEGER NOT NULL CHECK (age_months BETWEEN 0 AND 59),
    chief_complaint     TEXT NOT NULL,
    symptoms            JSONB NOT NULL,
    vitals              JSONB,
    critical_signs      JSONB NOT NULL DEFAULT '[]'::jsonb,
    classification      TEXT NOT NULL,
    urgency             TEXT NOT NULL CHECK (urgency IN ('RED','YELLOW','GREEN')),
    actions             JSONB NOT NULL,
    reasoning           TEXT,
    confidence          TEXT CHECK (confidence IN ('low','medium','high')),
    bypassed_llm        BOOLEAN NOT NULL DEFAULT FALSE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_cases_ward_created ON cases(ward_id, created_at DESC);
CREATE INDEX idx_cases_classification_created ON cases(classification, created_at DESC);

-- alerts: outbreak detections
CREATE TABLE alerts (
    id              UUID PRIMARY KEY,
    ward_id         UUID NOT NULL REFERENCES wards(id),
    classification  TEXT NOT NULL,
    case_count      INTEGER NOT NULL,
    window_start    TIMESTAMPTZ NOT NULL,
    window_end      TIMESTAMPTZ NOT NULL,
    threshold       INTEGER NOT NULL,
    status          TEXT NOT NULL DEFAULT 'OPEN'
                    CHECK (status IN ('OPEN','ACKNOWLEDGED','RESOLVED')),
    detected_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    acknowledged_at TIMESTAMPTZ,
    acknowledged_by TEXT
);
CREATE INDEX idx_alerts_status_detected ON alerts(status, detected_at DESC);
```

### 8.2 IMCI Classifications (subset for POC)

| Code                           | Label                                   | Default Urgency |
| ------------------------------ | --------------------------------------- | --------------- |
| `MALARIA_SEVERE`               | Severe malaria                          | RED             |
| `MALARIA_UNCOMPLICATED`        | Uncomplicated malaria                   | YELLOW          |
| `PNEUMONIA_SEVERE`             | Severe pneumonia                        | RED             |
| `PNEUMONIA`                    | Pneumonia                               | YELLOW          |
| `COUGH_NO_PNEUMONIA`           | Cough or cold                           | GREEN           |
| `DIARRHOEA_SEVERE_DEHYDRATION` | Severe dehydration                      | RED             |
| `DIARRHOEA_SOME_DEHYDRATION`   | Some dehydration                        | YELLOW          |
| `DIARRHOEA_NO_DEHYDRATION`     | No dehydration                          | GREEN           |
| `MEASLES_SEVERE`               | Severe complicated measles              | RED             |
| `MEASLES_UNCOMPLICATED`        | Measles                                 | YELLOW          |
| `SEVERE_MALNUTRITION`          | Severe acute malnutrition               | RED             |
| `NO_CLASSIFICATION_AVAILABLE`  | Insufficient data, refer for assessment | YELLOW          |

### 8.3 IMCI Critical Signs (rule-engine bypass list)

- Unable to drink or breastfeed
- Vomits everything
- History of convulsions in this illness
- Currently convulsing
- Lethargic or unconscious
- Stridor in calm child
- Severe respiratory distress (chest indrawing in age >= 12 months)
- Visible severe wasting
- Bilateral pitting oedema of the feet
- Severe palmar pallor

Any one of these triggers `URGENT_REFERRAL` immediately, no LLM call.

---

## 9. API Specification

### 9.1 POST /api/v1/triage

**Request**
```json
{
  "chv_id": "uuid",
  "patient": {
    "pseudo_id": "abcdef12",
    "age_months": 18,
    "sex": "F"
  },
  "chief_complaint": "fever and cough",
  "symptoms": [
    {"name": "fever", "duration_days": 3},
    {"name": "cough", "duration_days": 2},
    {"name": "fast_breathing", "duration_days": 1}
  ],
  "vitals": {
    "temp_c": 39.1,
    "respiratory_rate": 52
  },
  "critical_signs": []
}
```

**Response (no critical signs, LLM path)**
```json
{
  "case_id": "uuid",
  "classification": "PNEUMONIA",
  "urgency": "YELLOW",
  "actions": [
    "Give amoxicillin 250mg orally twice daily for 5 days",
    "Advise mother on warning signs (fast breathing, chest indrawing, inability to drink)",
    "Follow up in 2 days"
  ],
  "reasoning": "Child age 18 months with cough, fever, and respiratory rate 52/min meets IMCI threshold for pneumonia (RR >= 50 in 2-12 month, >= 40 in 12-59 month). No critical signs present.",
  "confidence": "high",
  "follow_up_questions": [],
  "bypassed_llm": false,
  "disclaimer": "Decision support only. Use clinical judgement."
}
```

**Response (critical sign present, rule-engine path)**
```json
{
  "case_id": "uuid",
  "classification": "MALARIA_SEVERE",
  "urgency": "RED",
  "actions": [
    "URGENT REFERRAL - arrange transport now",
    "Pre-referral: rectal artesunate 50mg if available",
    "Keep child warm and on side if convulsing"
  ],
  "reasoning": "Critical sign(s) detected: history_of_convulsions. Per IMCI, urgent referral required regardless of other findings.",
  "confidence": "high",
  "follow_up_questions": [],
  "bypassed_llm": true,
  "disclaimer": "Decision support only. Use clinical judgement."
}
```

### 9.2 GET /api/v1/cases

Query params: `ward_id`, `classification`, `urgency`, `since`, `limit`, `offset`
Returns paginated list of cases for the district feed.

### 9.3 GET /api/v1/outbreaks

Query params: `status` (default `OPEN`), `since`, `ward_id`
Returns outbreak alerts.

### 9.4 POST /api/v1/outbreaks/{id}/acknowledge

Marks an alert as acknowledged.

### 9.5 GET /api/v1/health

Liveness + dependency check (Postgres reachable, Vertex endpoint reachable).

---

## 10. The Triage Prompt (Gemma)

System prompt template, used only when the rule engine clears the case:

```
You are a clinical decision support assistant for Community Health Volunteers
in resource-limited settings. You are trained on the WHO Integrated Management
of Childhood Illness (IMCI) protocol.

You support trained CHVs. You do not replace clinical judgement and your
output is always considered preliminary.

The CHV has already screened for critical danger signs. You are only invoked
when no immediate referral is mandated by rule.

Given the patient information, output ONLY a JSON object matching this schema:

{
  "classification": "<one of the IMCI codes provided>",
  "urgency": "RED | YELLOW | GREEN",
  "actions": ["<concrete action 1>", "<concrete action 2>", ...],
  "reasoning": "<one short paragraph linking inputs to classification>",
  "confidence": "low | medium | high",
  "follow_up_questions": ["<question 1>", ...]
}

Rules:
- If you cannot classify with at least medium confidence, return
  "NO_CLASSIFICATION_AVAILABLE" and list follow_up_questions.
- Actions must be specific (drug, dose, follow-up window) drawing from IMCI.
- Do not output any text outside the JSON object.

Patient:
- Age: {age_months} months
- Sex: {sex}
- Chief complaint: {chief_complaint}
- Symptoms: {symptoms_json}
- Vitals: {vitals_json}
- IMCI critical signs (already cleared): none
```

Generation config: `temperature=0.1`, `top_p=0.95`, `max_output_tokens=512`, `response_mime_type=application/json`.

---

## 11. Outbreak Detection Logic

For the POC, a simple rolling-window threshold detector is enough to demo. Production would graduate to a SCAN statistic or an EARS C1/C2/C3 method.

```python
# Pseudocode
for ward in wards:
    for syndrome in OUTBREAK_SYNDROMES:  # {DIARRHOEA, MEASLES, ARI}
        case_count = count_cases(
            ward_id=ward.id,
            classification__in=syndromes_to_classifications(syndrome),
            since=now() - timedelta(hours=48)
        )
        threshold = THRESHOLDS[syndrome]  # default 3
        if case_count >= threshold:
            existing = get_open_alert(ward, syndrome)
            if not existing:
                create_alert(ward, syndrome, case_count, threshold)
```

Run every 5 minutes via APScheduler. For the demo, also expose a manual trigger endpoint `POST /api/v1/outbreaks/_run-detection` so we can fire the job on cue.

---

## 12. Demo Script (5 minutes)

This is what you will present. Practice it twice.

### Minute 0:00 - 0:30 - Hook

> "In 2026, a child in a rural district can die within 24 hours from a treatable illness because the volunteer who saw them couldn't escalate fast enough. Outbreak data reaches the Ministry days too late. Sentinel fixes both ends of that problem with one data flow."

### Minute 0:30 - 1:30 - Aisha's first case (ordinary)

1. Open the Streamlit app, header shows **"Aisha (CHV) - Ward 12, Western Cape"**
2. Click **"New Case"**
3. Fill in: child age **24 months**, chief complaint **"cough and fever"**
4. Symptoms: fever 3 days, cough 2 days, no chest indrawing, eating and drinking normally, RR 48
5. Critical signs panel: **all unchecked**
6. Click **Submit**
7. Triage card renders within 3 seconds:
   - 🟡 **PNEUMONIA - YELLOW**
   - Actions: "Give amoxicillin 250mg twice daily for 5 days. Advise mother on warning signs. Follow up in 2 days."
   - Confidence: high
   - Disclaimer visible

> "Aisha now has a clear plan. The case is logged centrally."

### Minute 1:30 - 2:30 - Aisha's second case (critical)

1. Click **"New Case"** again
2. Age **18 months**, chief complaint **"convulsions"**
3. Tick critical sign: **"History of convulsions in this illness"**
4. Click **Submit**
5. Response is **instant** (no spinner) - emphasise this on stage:

> "Watch this. The system is not asking the AI. It does not need to."

6. Triage card renders:
   - 🔴 **URGENT REFERRAL**
   - Actions: "Arrange transport now. Pre-referral: rectal artesunate 50mg if available. Keep child on side if convulsing."
   - Reasoning: "Critical sign detected. Per IMCI, urgent referral required regardless of other findings."
   - Tag: **"Bypassed LLM (rule engine)"**

> "This is the safety floor. An LLM should never be the only thing standing between a child with convulsions and a referral."

### Minute 2:30 - 3:30 - District dashboard

1. Switch to a second browser tab: **"Dr Kwame - District Officer view"**
2. Show the **live case feed** with the two cases Aisha just submitted at the top
3. Show the **map** with case markers across wards
4. Show the **KPIs**: cases today, RED today, active alerts
5. Open a terminal tab and run:
   ```bash
   uv run python seed/outbreak_simulator.py --ward "Bambatha" --syndrome diarrhoea --count 5
   ```
6. Watch the **alert banner** light up red within 5 seconds:

> "🚨 OUTBREAK ALERT: Acute diarrhoea cluster detected in Bambatha Village. 6 cases in 48 hours. Threshold: 3. Recommend rapid response team."

### Minute 3:30 - 4:00 - Architecture flash

Switch to a single architecture slide. Talk for 30 seconds:

> "Streamlit talks to FastAPI. FastAPI runs every case through an IMCI rule engine first - that is the safety floor. If the case is non-critical, it goes to Gemma on Vertex AI Model Garden, which we have stubbed in for MedGemma 1.5 4B - the production swap is one config change. Every case lands in Postgres. A scheduled detector watches for clusters and emits alerts. Same data, two products."

### Minute 4:00 - 4:30 - Impact

> "One symptom intake. Two outputs: a CHV who knows what to do, and a district officer who knows when something is wrong. The data Aisha captures for one child saves lives across the district."

### Minute 4:30 - 5:00 - Buffer / call to action

- Show the GitHub repo link
- Mention compliance posture: POPIA-aware, decision-support not diagnosis, IMCI-aligned
- Call out that the production swap to MedGemma 1.5 (which is open-weight, free for commercial use, deployable on Vertex AI) is a one-line change behind the agent interface

---

## 13. Implementation Phases (24-hour build plan)

Assumes you start at hour 0 with an empty repo.

| Hour    | Milestone                                                                           | Output                                                                    |
| ------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 0 - 1   | Repo scaffolding, docker-compose, Postgres up, Alembic init                         | `docker-compose up` brings up Postgres                                    |
| 1 - 2   | SQLAlchemy models, Alembic migration, seed wards/CHVs                               | `alembic upgrade head` populates schema, seeds insert                     |
| 2 - 4   | IMCI rule engine + unit tests                                                       | `pytest` green; rule engine returns URGENT_REFERRAL on each critical sign |
| 4 - 6   | FastAPI scaffolding, schemas, `/health`, `/cases` GET/POST                          | OpenAPI doc visible at `/docs`                                            |
| 6 - 8   | Triage agent: Mock implementation + Vertex Gemma implementation, `/triage` endpoint | curl test: critical sign bypasses LLM, normal path hits Gemma             |
| 8 - 10  | Outbreak detector + APScheduler + manual trigger endpoint                           | Synthetic case insert -> alert fires                                      |
| 10 - 14 | Streamlit frontend: CHV triage page + Case history page                             | End-to-end CHV flow works                                                 |
| 14 - 17 | Streamlit frontend: District dashboard + Outbreak alerts page                       | End-to-end officer flow works                                             |
| 17 - 19 | Outbreak simulator script + demo seed data                                          | One command fires the outbreak alert on stage                             |
| 19 - 21 | Polish: error states, loading spinners, disclaimer placement, IMCI colour coding    | UI passes a critical-eye review                                           |
| 21 - 22 | Demo dry run #1, fix bugs                                                           | Run-through completes in 5 minutes without surprises                      |
| 22 - 23 | Demo dry run #2, README, screenshots                                                | Repo is presentable                                                       |
| 23 - 24 | Slack buffer                                                                        | n/a                                                                       |

If hour 14 looms and frontend is not started, drop the Outbreak Alerts page and inline alerts into the District Dashboard banner.

---

## 14. Risks and Mitigations

| Risk                                                 | Likelihood | Impact | Mitigation                                                                                                                                                              |
| ---------------------------------------------------- | ---------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vertex AI Gemma endpoint quota / cold start mid-demo | Medium     | High   | `OllamaGemmaAgent` fallback running locally; switch via env var                                                                                                         |
| Conference wifi flaky                                | High       | High   | Run everything on laptop; only Vertex call needs internet; have Ollama warm                                                                                             |
| LLM returns malformed JSON                           | Medium     | Medium | Pydantic validation + retry once + fallback to NO_CLASSIFICATION_AVAILABLE                                                                                              |
| Outbreak detector doesn't fire on stage              | Low        | High   | Manual trigger endpoint; pre-loaded synthetic cases; rehearse the simulator command                                                                                     |
| Postgres container slow to start                     | Low        | Medium | Pre-start before demo; healthcheck in docker-compose                                                                                                                    |
| Judges question clinical liability                   | High       | Medium | Disclaimer baked into UI and API response; "decision support, not diagnosis" framing in pitch; align with MedGemma's stated intended-use                                |
| Judges question why Gemma not MedGemma               | High       | Low    | Honest answer: "MedGemma 1.5 swap is a one-line config change; we built the integration interface to be model-agnostic and validated the architecture works end-to-end" |

---

## 15. Compliance and Ethical Posture

- **POPIA / GDPR**: No real PII in the POC. Patient identifier is a pseudo-ID. Demo data is synthetic
- **Decision support, not diagnosis**: Disclaimer visible in UI and present in every API response
- **IMCI alignment**: Recommendations draw from a WHO-validated protocol designed for resource-limited settings, reducing bias risk vs Western-trained datasets
- **Safety floor**: The IMCI rule engine guarantees that critical signs always escalate, even if the LLM is offline or wrong
- **Auditability**: Every case persisted with `bypassed_llm` flag, reasoning text, and confidence; outbreak alerts log thresholds and windows
- **Open-weight path**: Production migration to MedGemma 1.5 4B keeps weights and inference inside the deploying organisation's infrastructure

---

## 16. Future Work (Post-Hackathon)

- Swap Gemma to MedGemma 1.5 4B on Vertex AI; revalidate prompts and outputs
- Offline-first PWA: Workbox service worker, IndexedDB queue, sync on reconnect
- Voice intake using MedASR (medical speech-to-text) for low-literacy CHVs
- Multi-language UI (isiZulu, isiXhosa, Swahili)
- DHIS2 integration for national HIS reporting
- Stretch: MUAC photo capture + MedSigLIP-based malnutrition screen
- Production-grade authn (Firebase Auth or WorkOS), RBAC, audit log
- Graduate outbreak detection from rolling-window threshold to SCAN statistic
- Submit to the Kaggle MedGemma Impact Challenge (USD 100k prize pool, due in 2026)

---

## 17. Appendix: Bootstrap Commands

```bash
# Clone and setup
git clone <repo>
cd sentinel-health

# Bring up Postgres
docker-compose up -d postgres

# Backend
cd backend
uv sync
uv run alembic upgrade head
uv run python -m sentinel_backend.seed
uv run uvicorn sentinel_backend.main:app --reload --port 8000

# Frontend (separate terminal)
cd frontend
uv sync
uv run streamlit run src/sentinel_frontend/app.py --server.port 8501

# Demo: trigger outbreak
cd seed
uv run python outbreak_simulator.py --ward "Bambatha" --syndrome diarrhoea --count 5
```

Required environment variables (see `.env.example`):

```
DATABASE_URL=postgresql+psycopg://sentinel:sentinel@localhost:5432/sentinel
TRIAGE_BACKEND=vertex   # one of: vertex | ollama | mock
GCP_PROJECT_ID=<your-project>
GCP_REGION=us-central1
VERTEX_GEMMA_ENDPOINT_ID=<endpoint-id>
OUTBREAK_DETECTION_INTERVAL_MIN=5
OUTBREAK_THRESHOLD_DIARRHOEA=3
OUTBREAK_THRESHOLD_MEASLES=2
OUTBREAK_THRESHOLD_ARI=4
```

---

*End of PRD v0.1*