from __future__ import annotations

import base64
import json
import os
import uuid
from collections import Counter
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from urllib import request

from fastapi import FastAPI, File, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field


app = FastAPI(
    title="Sentinel Health Backend",
    description="Demo backend for CHV triage, offline sync, and outbreak alerts.",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("CORS_ORIGINS", "*").split(","),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

DANGER_SIGN_ACTIONS = [
    "URGENT REFERRAL - arrange transport now",
    "Keep the child warm and positioned safely during transport",
    "Call the nearest facility before arrival if possible",
]

DANGER_SIGNS = {
    "unable_to_drink": "Unable to drink or breastfeed",
    "vomits_everything": "Vomits everything",
    "convulsions": "History of convulsions in this illness",
    "currently_convulsing": "Currently convulsing",
    "lethargic_unconscious": "Lethargic or unconscious",
    "stridor": "Stridor in calm child",
    "severe_respiratory_distress": "Severe respiratory distress",
    "visible_severe_wasting": "Visible severe wasting",
    "bilateral_oedema": "Bilateral pitting oedema of the feet",
    "severe_pallor": "Severe palmar pallor",
}

OUTBREAK_CLASSES = {
    "DIARRHOEA_SOME_DEHYDRATION",
    "DIARRHOEA_NO_DEHYDRATION",
    "PNEUMONIA",
    "COUGH_NO_PNEUMONIA",
    "MEASLES_UNCOMPLICATED",
}

CASES: list[dict[str, Any]] = []
ALERTS: list[dict[str, Any]] = []
CLIENT_CASE_IDS: dict[str, str] = {}
BIGQUERY_READY = False
BIGQUERY_LAST_ERROR: str | None = None

try:
    from google.cloud import bigquery
except ImportError:
    bigquery = None

DEFAULT_SEED_CASES = [
    {
        "client_case_id": "seed-bambatha-pneumonia-001",
        "chv_name": "Aisha",
        "ward": "Bambatha",
        "patient_pseudo_id": "seed-child-001",
        "age_months": 24,
        "sex": "F",
        "chief_complaint": "cough and fever",
        "symptoms": ["fever", "cough", "fast_breathing"],
        "temperature_c": 38.7,
        "respiratory_rate": 48,
        "danger_signs": [],
        "captured_offline": False,
    },
    {
        "client_case_id": "seed-kijani-referral-001",
        "chv_name": "Miriam",
        "ward": "Kijani",
        "patient_pseudo_id": "seed-child-002",
        "age_months": 18,
        "sex": "M",
        "chief_complaint": "convulsions and fever",
        "symptoms": ["fever"],
        "temperature_c": 39.3,
        "respiratory_rate": 44,
        "danger_signs": ["convulsions"],
        "captured_offline": False,
    },
    {
        "client_case_id": "seed-bambatha-diarrhoea-001",
        "chv_name": "Aisha",
        "ward": "Bambatha",
        "patient_pseudo_id": "seed-child-003",
        "age_months": 30,
        "sex": "F",
        "chief_complaint": "diarrhoea",
        "symptoms": ["diarrhoea", "dehydration"],
        "temperature_c": 37.9,
        "respiratory_rate": 34,
        "danger_signs": [],
        "captured_offline": True,
    },
    {
        "client_case_id": "seed-bambatha-diarrhoea-002",
        "chv_name": "Aisha",
        "ward": "Bambatha",
        "patient_pseudo_id": "seed-child-004",
        "age_months": 20,
        "sex": "M",
        "chief_complaint": "watery diarrhoea",
        "symptoms": ["diarrhoea"],
        "temperature_c": 37.5,
        "respiratory_rate": 30,
        "danger_signs": [],
        "captured_offline": False,
    },
    {
        "client_case_id": "seed-bambatha-diarrhoea-003",
        "chv_name": "Joseph",
        "ward": "Bambatha",
        "patient_pseudo_id": "seed-child-005",
        "age_months": 36,
        "sex": "F",
        "chief_complaint": "diarrhoea and vomiting",
        "symptoms": ["diarrhoea", "vomiting"],
        "temperature_c": 38.1,
        "respiratory_rate": 32,
        "danger_signs": [],
        "captured_offline": False,
    },
]


class CaseInput(BaseModel):
    client_case_id: str | None = None
    chv_name: str = "Aisha"
    ward: str = "Bambatha"
    patient_pseudo_id: str = Field(default_factory=lambda: f"child-{uuid.uuid4().hex[:6]}")
    age_months: int = Field(ge=0, le=59)
    sex: str = "F"
    chief_complaint: str
    symptoms: list[str] = Field(default_factory=list)
    temperature_c: float | None = None
    respiratory_rate: int | None = None
    danger_signs: list[str] = Field(default_factory=list)
    captured_offline: bool = False
    captured_at: datetime | None = None


class SyncRequest(BaseModel):
    cases: list[CaseInput]


class VoiceExtractRequest(BaseModel):
    transcript: str


class AlertAck(BaseModel):
    acknowledged_by: str = "Dr Kwame"


def now_utc() -> datetime:
    return datetime.now(UTC)


def bigquery_enabled() -> bool:
    return os.getenv("BIGQUERY_ENABLED", "false").lower() == "true" and bigquery is not None


def bigquery_ids() -> tuple[str, str, str, str]:
    project_id = os.getenv("GOOGLE_CLOUD_PROJECT") or os.getenv("PROJECT_ID") or "oceanhub-dev"
    dataset = os.getenv("BIGQUERY_DATASET", "sentinel_demo")
    cases_table = os.getenv("BIGQUERY_CASES_TABLE", "cases")
    alerts_table = os.getenv("BIGQUERY_ALERTS_TABLE", "alerts")
    return project_id, dataset, cases_table, alerts_table


def ensure_bigquery() -> None:
    global BIGQUERY_LAST_ERROR, BIGQUERY_READY
    if not bigquery_enabled():
        return

    project_id, dataset_name, cases_table_name, alerts_table_name = bigquery_ids()
    client = bigquery.Client(project=project_id)
    dataset_id = f"{project_id}.{dataset_name}"

    try:
        client.create_dataset(bigquery.Dataset(dataset_id), exists_ok=True)
        client.create_table(
            bigquery.Table(
                f"{dataset_id}.{cases_table_name}",
                schema=[
                    bigquery.SchemaField("id", "STRING", mode="REQUIRED"),
                    bigquery.SchemaField("client_case_id", "STRING"),
                    bigquery.SchemaField("ward", "STRING"),
                    bigquery.SchemaField("chv_name", "STRING"),
                    bigquery.SchemaField("patient_pseudo_id", "STRING"),
                    bigquery.SchemaField("age_months", "INTEGER"),
                    bigquery.SchemaField("sex", "STRING"),
                    bigquery.SchemaField("chief_complaint", "STRING"),
                    bigquery.SchemaField("classification", "STRING"),
                    bigquery.SchemaField("urgency", "STRING"),
                    bigquery.SchemaField("confidence", "STRING"),
                    bigquery.SchemaField("bypassed_ai", "BOOLEAN"),
                    bigquery.SchemaField("model", "STRING"),
                    bigquery.SchemaField("captured_offline", "BOOLEAN"),
                    bigquery.SchemaField("captured_at", "TIMESTAMP"),
                    bigquery.SchemaField("synced_at", "TIMESTAMP"),
                    bigquery.SchemaField("payload_json", "STRING"),
                ],
            ),
            exists_ok=True,
        )
        client.create_table(
            bigquery.Table(
                f"{dataset_id}.{alerts_table_name}",
                schema=[
                    bigquery.SchemaField("id", "STRING", mode="REQUIRED"),
                    bigquery.SchemaField("ward", "STRING"),
                    bigquery.SchemaField("classification", "STRING"),
                    bigquery.SchemaField("case_count", "INTEGER"),
                    bigquery.SchemaField("threshold", "INTEGER"),
                    bigquery.SchemaField("window_hours", "INTEGER"),
                    bigquery.SchemaField("status", "STRING"),
                    bigquery.SchemaField("detected_at", "TIMESTAMP"),
                    bigquery.SchemaField("message", "STRING"),
                    bigquery.SchemaField("payload_json", "STRING"),
                ],
            ),
            exists_ok=True,
        )
        BIGQUERY_READY = True
        BIGQUERY_LAST_ERROR = None
    except Exception as exc:
        BIGQUERY_READY = False
        BIGQUERY_LAST_ERROR = str(exc)


def write_case_to_bigquery(record: dict[str, Any]) -> None:
    global BIGQUERY_LAST_ERROR
    if not bigquery_enabled():
        return

    project_id, dataset, cases_table, _ = bigquery_ids()
    table_id = f"{project_id}.{dataset}.{cases_table}"
    client = bigquery.Client(project=project_id)
    row = {
        "id": record["id"],
        "client_case_id": record.get("client_case_id"),
        "ward": record.get("ward"),
        "chv_name": record.get("chv_name"),
        "patient_pseudo_id": record.get("patient_pseudo_id"),
        "age_months": record.get("age_months"),
        "sex": record.get("sex"),
        "chief_complaint": record.get("chief_complaint"),
        "classification": record.get("classification"),
        "urgency": record.get("urgency"),
        "confidence": record.get("confidence"),
        "bypassed_ai": record.get("bypassed_ai"),
        "model": record.get("model"),
        "captured_offline": record.get("captured_offline"),
        "captured_at": record.get("captured_at"),
        "synced_at": record.get("synced_at"),
        "payload_json": json.dumps(record, default=str),
    }
    errors = client.insert_rows_json(table_id, [row], row_ids=[record["id"]])
    BIGQUERY_LAST_ERROR = json.dumps(errors) if errors else None


def write_alert_to_bigquery(alert: dict[str, Any]) -> None:
    global BIGQUERY_LAST_ERROR
    if not bigquery_enabled():
        return

    project_id, dataset, _, alerts_table = bigquery_ids()
    table_id = f"{project_id}.{dataset}.{alerts_table}"
    client = bigquery.Client(project=project_id)
    row = {
        "id": alert["id"],
        "ward": alert.get("ward"),
        "classification": alert.get("classification"),
        "case_count": alert.get("case_count"),
        "threshold": alert.get("threshold"),
        "window_hours": alert.get("window_hours"),
        "status": alert.get("status"),
        "detected_at": alert.get("detected_at"),
        "message": alert.get("message"),
        "payload_json": json.dumps(alert, default=str),
    }
    errors = client.insert_rows_json(table_id, [row], row_ids=[alert["id"]])
    BIGQUERY_LAST_ERROR = json.dumps(errors) if errors else None


def classify_locally(case: CaseInput) -> dict[str, Any]:
    symptoms = {symptom.lower() for symptom in case.symptoms}
    complaint = case.chief_complaint.lower()
    respiratory_rate = case.respiratory_rate or 0
    age_months = case.age_months

    if "diarrhoea" in symptoms or "diarrhea" in symptoms or "diarrhoea" in complaint:
        urgency = "YELLOW" if "dehydration" in symptoms else "GREEN"
        return {
            "classification": "DIARRHOEA_SOME_DEHYDRATION" if urgency == "YELLOW" else "DIARRHOEA_NO_DEHYDRATION",
            "urgency": urgency,
            "actions": [
                "Give oral rehydration solution after each loose stool",
                "Assess for dehydration warning signs",
                "Follow up within 24 hours if symptoms continue",
            ],
            "rationale": "Diarrhoeal symptoms were reported without IMCI danger signs.",
            "confidence": "medium",
        }

    if "rash" in symptoms or "measles" in complaint:
        return {
            "classification": "MEASLES_UNCOMPLICATED",
            "urgency": "YELLOW",
            "actions": [
                "Refer for measles assessment and vitamin A per local protocol",
                "Advise caregiver to isolate child from other children",
                "Notify district officer if more similar cases appear",
            ],
            "rationale": "Rash/measles-like symptoms were reported without danger signs.",
            "confidence": "medium",
        }

    if "cough" in symptoms or "fast_breathing" in symptoms or "cough" in complaint:
        fast_threshold = 50 if age_months < 12 else 40
        if respiratory_rate >= fast_threshold:
            return {
                "classification": "PNEUMONIA",
                "urgency": "YELLOW",
                "actions": [
                    "Treat as pneumonia per local IMCI protocol",
                    "Advise caregiver on danger signs",
                    "Follow up in 2 days",
                ],
                "rationale": f"Respiratory rate {respiratory_rate}/min meets the fast-breathing threshold for age.",
                "confidence": "high",
            }
        return {
            "classification": "COUGH_NO_PNEUMONIA",
            "urgency": "GREEN",
            "actions": [
                "Soothe cough and advise fluids",
                "Return immediately if breathing becomes fast or difficult",
                "Follow up if fever persists",
            ],
            "rationale": "Cough was reported without fast breathing or danger signs.",
            "confidence": "medium",
        }

    if "fever" in symptoms or "malaria" in complaint:
        return {
            "classification": "MALARIA_UNCOMPLICATED",
            "urgency": "YELLOW",
            "actions": [
                "Perform rapid diagnostic test if available",
                "Treat or refer according to local malaria protocol",
                "Return immediately for convulsions, lethargy, or inability to drink",
            ],
            "rationale": "Fever/malaria-like presentation without danger signs.",
            "confidence": "medium",
        }

    return {
        "classification": "NO_CLASSIFICATION_AVAILABLE",
        "urgency": "YELLOW",
        "actions": [
            "Ask follow-up questions and reassess",
            "Refer to nearest facility if the CHV is uncertain",
        ],
        "rationale": "The available symptoms are not enough for a confident demo classification.",
        "confidence": "low",
    }


def maybe_gemini_triage(case: CaseInput) -> dict[str, Any]:
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        return classify_locally(case)

    model = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"
    prompt = {
        "role": "user",
        "parts": [
            {
                "text": (
                    "You are supporting a Community Health Volunteer using IMCI-style decision support. "
                    "Return only JSON with classification, urgency, actions, rationale, confidence. "
                    f"Case: {case.model_dump(mode='json')}"
                )
            }
        ],
    }
    payload = json.dumps({"contents": [prompt]}).encode("utf-8")
    req = request.Request(url, data=payload, headers={"Content-Type": "application/json"}, method="POST")

    try:
        with request.urlopen(req, timeout=8) as response:
            data = json.loads(response.read().decode("utf-8"))
        text = data["candidates"][0]["content"]["parts"][0]["text"].strip()
        if text.startswith("```"):
            text = text.strip("`").replace("json\n", "", 1).strip()
        result = json.loads(text)
        return {
            "classification": result.get("classification", "NO_CLASSIFICATION_AVAILABLE"),
            "urgency": result.get("urgency", "YELLOW"),
            "actions": result.get("actions", ["Refer for clinical assessment"]),
            "rationale": result.get("rationale", "Gemini returned structured decision support."),
            "confidence": result.get("confidence", "medium"),
        }
    except Exception:
        return classify_locally(case)


def fallback_extract_from_transcript(transcript: str) -> dict[str, Any]:
    text = transcript.lower()
    extracted_symptoms = [symptom for symptom in ["fever", "cough", "diarrhoea", "vomiting", "rash"] if symptom in text]
    if "fast breathing" in text or "breathing fast" in text:
        extracted_symptoms.append("fast_breathing")
    if "dehydrat" in text:
        extracted_symptoms.append("dehydration")

    extracted_danger_signs = []
    if "convulsion" in text or "fit" in text or "seizure" in text:
        extracted_danger_signs.append("convulsions")
    if "not drinking" in text or "unable to drink" in text:
        extracted_danger_signs.append("unable_to_drink")
    if "vomits everything" in text:
        extracted_danger_signs.append("vomits_everything")
    if "lethargic" in text or "unconscious" in text:
        extracted_danger_signs.append("lethargic_unconscious")

    age_months = 24
    for token in text.replace("-", " ").split():
        if token.isdigit():
            value = int(token)
            if "year" in text and value <= 5:
                age_months = value * 12
            elif value <= 59:
                age_months = value
            break

    return {
        "patient_pseudo_id": f"voice-{uuid.uuid4().hex[:5]}",
        "age_months": age_months,
        "sex": "M" if " boy" in f" {text}" or " male" in f" {text}" else "F",
        "ward": "Bambatha",
        "chief_complaint": transcript[:90] or "voice intake",
        "symptoms": sorted(set(extracted_symptoms)),
        "temperature_c": 39.0 if "fever" in text else 37.5,
        "respiratory_rate": 52 if "fast breathing" in text or "breathing fast" in text else 36,
        "danger_signs": sorted(set(extracted_danger_signs)),
        "extraction_confidence": "demo-fallback",
        "human_review_required": True,
    }


def extract_case_with_gemini(transcript: str) -> dict[str, Any]:
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        return fallback_extract_from_transcript(transcript)

    model = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"
    prompt = {
        "role": "user",
        "parts": [
            {
                "text": (
                    "Extract a pediatric CHV intake form from this spoken note. "
                    "Return only JSON with keys: patient_pseudo_id, age_months, sex, ward, "
                    "chief_complaint, symptoms, temperature_c, respiratory_rate, danger_signs, "
                    "extraction_confidence, human_review_required. "
                    "Allowed symptoms: ['fever', 'cough', 'fast_breathing', 'diarrhoea', "
                    "'dehydration', 'rash', 'vomiting']. "
                    f"Allowed danger_signs: {list(DANGER_SIGNS.keys())}. "
                    "Use null for unknown numeric values. Set human_review_required true. "
                    f"Transcript: {transcript}"
                )
            }
        ],
    }
    payload = json.dumps({"contents": [prompt]}).encode("utf-8")
    req = request.Request(url, data=payload, headers={"Content-Type": "application/json"}, method="POST")

    try:
        with request.urlopen(req, timeout=8) as response:
            data = json.loads(response.read().decode("utf-8"))
        text = data["candidates"][0]["content"]["parts"][0]["text"].strip()
        if text.startswith("```"):
            text = text.strip("`").replace("json\n", "", 1).strip()
        result = json.loads(text)
        result["human_review_required"] = True
        return result
    except Exception:
        return fallback_extract_from_transcript(transcript)


def extract_case_from_audio_with_gemini(audio_bytes: bytes, mime_type: str) -> dict[str, Any]:
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        return {
            "transcript": "",
            "case": fallback_extract_from_transcript(""),
            "model": "deterministic fallback",
            "error": "GEMINI_API_KEY is not configured, so audio transcription is unavailable.",
        }

    model = os.getenv("GEMINI_MODEL", "gemini-2.0-flash")
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"
    prompt = (
        "You are helping a Community Health Volunteer in an African rural health setting. "
        "The audio may be noisy, accented, informal, and recorded on a phone. "
        "First produce the best possible verbatim transcript. Then extract a pediatric intake form. "
        "Prefer medically plausible interpretations: 'breathing fast' means fast_breathing, "
        "'fits' or 'seizure' means convulsions, and 'not drinking' means unable_to_drink. "
        "Return only JSON with this exact shape: "
        "{\"transcript\":\"...\",\"case\":{\"patient_pseudo_id\":\"...\",\"age_months\":24,"
        "\"sex\":\"F\",\"ward\":\"Bambatha\",\"chief_complaint\":\"...\","
        "\"symptoms\":[\"fever\"],\"temperature_c\":39.0,\"respiratory_rate\":48,"
        "\"danger_signs\":[],\"extraction_confidence\":\"high\","
        "\"human_review_required\":true}}. "
        "Allowed symptoms: fever, cough, fast_breathing, diarrhoea, dehydration, rash, vomiting. "
        f"Allowed danger_signs: {', '.join(DANGER_SIGNS.keys())}. "
        "Use null for unknown numbers and always set human_review_required true."
    )
    payload = {
        "contents": [
            {
                "role": "user",
                "parts": [
                    {"text": prompt},
                    {
                        "inline_data": {
                            "mime_type": mime_type or "audio/webm",
                            "data": base64.b64encode(audio_bytes).decode("utf-8"),
                        }
                    },
                ],
            }
        ]
    }
    req = request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with request.urlopen(req, timeout=20) as response:
            data = json.loads(response.read().decode("utf-8"))
        text = data["candidates"][0]["content"]["parts"][0]["text"].strip()
        if text.startswith("```"):
            text = text.strip("`").replace("json\n", "", 1).strip()
        result = json.loads(text)
        result.setdefault("case", {})
        result["case"]["human_review_required"] = True
        result["model"] = model
        return result
    except Exception as exc:
        return {
            "transcript": "",
            "case": fallback_extract_from_transcript(""),
            "model": model,
            "error": f"Gemini audio extraction failed: {exc}",
        }


def triage_case(case: CaseInput) -> dict[str, Any]:
    matched_danger_signs = [sign for sign in case.danger_signs if sign in DANGER_SIGNS]
    if matched_danger_signs:
        labels = [DANGER_SIGNS[sign] for sign in matched_danger_signs]
        return {
            "classification": "URGENT_REFERRAL",
            "urgency": "RED",
            "actions": DANGER_SIGN_ACTIONS,
            "rationale": f"Danger sign detected: {', '.join(labels)}. Rule engine bypassed AI.",
            "confidence": "high",
            "bypassed_ai": True,
            "model": "IMCI rule engine",
        }

    result = maybe_gemini_triage(case)
    result["bypassed_ai"] = False
    result["model"] = "Gemini" if os.getenv("GEMINI_API_KEY") else "Deterministic demo fallback"
    return result


def persist_case(case: CaseInput) -> dict[str, Any]:
    if case.client_case_id and case.client_case_id in CLIENT_CASE_IDS:
        case_id = CLIENT_CASE_IDS[case.client_case_id]
        return next(saved for saved in CASES if saved["id"] == case_id)

    triage = triage_case(case)
    case_id = str(uuid.uuid4())
    record = {
        "id": case_id,
        "client_case_id": case.client_case_id,
        "chv_name": case.chv_name,
        "ward": case.ward,
        "patient_pseudo_id": case.patient_pseudo_id,
        "age_months": case.age_months,
        "sex": case.sex,
        "chief_complaint": case.chief_complaint,
        "symptoms": case.symptoms,
        "temperature_c": case.temperature_c,
        "respiratory_rate": case.respiratory_rate,
        "danger_signs": case.danger_signs,
        "captured_offline": case.captured_offline,
        "captured_at": (case.captured_at or now_utc()).isoformat(),
        "synced_at": now_utc().isoformat(),
        "disclaimer": "Decision support only. Use clinical judgement and local protocols.",
        **triage,
    }
    CASES.insert(0, record)
    if case.client_case_id:
        CLIENT_CASE_IDS[case.client_case_id] = case_id
    try:
        write_case_to_bigquery(record)
    except Exception as exc:
        global BIGQUERY_LAST_ERROR
        BIGQUERY_LAST_ERROR = str(exc)
    detect_outbreaks()
    return record


def detect_outbreaks() -> None:
    window_start = now_utc() - timedelta(hours=48)
    grouped: Counter[tuple[str, str]] = Counter()

    for case in CASES:
        classification = case["classification"]
        if classification not in OUTBREAK_CLASSES:
            continue
        captured_at = datetime.fromisoformat(case["captured_at"])
        if captured_at >= window_start:
            grouped[(case["ward"], classification)] += 1

    for (ward, classification), count in grouped.items():
        threshold = 3
        if count < threshold:
            continue
        existing = next(
            (
                alert
                for alert in ALERTS
                if alert["ward"] == ward and alert["classification"] == classification and alert["status"] == "OPEN"
            ),
            None,
        )
        if existing:
            existing["case_count"] = count
            existing["updated_at"] = now_utc().isoformat()
            continue
        alert = {
            "id": str(uuid.uuid4()),
            "ward": ward,
            "classification": classification,
            "case_count": count,
            "threshold": threshold,
            "window_hours": 48,
            "status": "OPEN",
            "detected_at": now_utc().isoformat(),
            "message": f"Potential {classification.lower().replace('_', ' ')} cluster in {ward}: {count} cases in 48h.",
        }
        ALERTS.insert(0, alert)
        try:
            write_alert_to_bigquery(alert)
        except Exception as exc:
            global BIGQUERY_LAST_ERROR
            BIGQUERY_LAST_ERROR = str(exc)


def dashboard_summary() -> dict[str, Any]:
    today = now_utc().date()
    today_cases = [case for case in CASES if datetime.fromisoformat(case["captured_at"]).date() == today]
    return {
        "cases_today": len(today_cases),
        "urgent_cases_today": sum(1 for case in today_cases if case["urgency"] == "RED"),
        "active_alerts": sum(1 for alert in ALERTS if alert["status"] == "OPEN"),
        "total_cases": len(CASES),
    }


def load_seed_cases() -> list[dict[str, Any]]:
    path = Path(os.getenv("DEMO_DATA_PATH", "../data/demo_cases.json"))
    try:
        with path.open("r", encoding="utf-8") as handle:
            data = json.load(handle)
        if isinstance(data, list):
            return data
    except (OSError, json.JSONDecodeError):
        pass
    return DEFAULT_SEED_CASES


@app.on_event("startup")
def seed_demo_data() -> None:
    ensure_bigquery()
    if os.getenv("SEED_DEMO_DATA", "true").lower() != "true" or CASES:
        return
    for raw_case in load_seed_cases():
        persist_case(CaseInput(**raw_case))


@app.get("/health")
@app.get("/api/v1/health")
def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "service": "sentinel-backend",
        "gemini_configured": bool(os.getenv("GEMINI_API_KEY")),
        "bigquery_enabled": bigquery_enabled(),
        "bigquery_ready": BIGQUERY_READY,
        "bigquery_last_error": BIGQUERY_LAST_ERROR,
        "cases": len(CASES),
        "alerts": len(ALERTS),
    }


@app.get("/api/v1/bigquery/status")
def bigquery_status() -> dict[str, Any]:
    project_id, dataset, cases_table, alerts_table = bigquery_ids()
    return {
        "enabled": bigquery_enabled(),
        "ready": BIGQUERY_READY,
        "last_error": BIGQUERY_LAST_ERROR,
        "project_id": project_id,
        "dataset": dataset,
        "cases_table": cases_table,
        "alerts_table": alerts_table,
    }


@app.post("/api/v1/triage")
def triage(case: CaseInput) -> dict[str, Any]:
    return persist_case(case)


@app.post("/api/v1/sync")
def sync_cases(payload: SyncRequest) -> dict[str, Any]:
    synced = [persist_case(case) for case in payload.cases]
    return {
        "status": "synced",
        "synced_count": len(synced),
        "cases": synced,
        "server_time": now_utc().isoformat(),
    }


@app.post("/api/v1/voice/extract")
def extract_voice_intake(payload: VoiceExtractRequest) -> dict[str, Any]:
    extracted = extract_case_with_gemini(payload.transcript)
    return {
        "transcript": payload.transcript,
        "case": extracted,
        "message": "Review and edit before submitting. The CHV remains the final decision-maker.",
    }


@app.post("/api/v1/voice/audio-extract")
async def extract_voice_audio(file: UploadFile = File(...)) -> dict[str, Any]:
    audio_bytes = await file.read()
    result = extract_case_from_audio_with_gemini(audio_bytes, file.content_type or "audio/webm")
    return {
        **result,
        "message": "Review and edit before submitting. The CHV remains the final decision-maker.",
    }


@app.get("/api/v1/cases")
def list_cases(limit: int = 50, ward: str | None = None) -> dict[str, Any]:
    rows = [case for case in CASES if ward is None or case["ward"] == ward]
    return {"cases": rows[:limit]}


@app.get("/api/v1/alerts")
def list_alerts(status: str | None = None) -> dict[str, Any]:
    rows = [alert for alert in ALERTS if status is None or alert["status"] == status]
    return {"alerts": rows}


@app.post("/api/v1/alerts/{alert_id}/acknowledge")
def acknowledge_alert(alert_id: str, payload: AlertAck) -> dict[str, Any]:
    for alert in ALERTS:
        if alert["id"] == alert_id:
            alert["status"] = "ACKNOWLEDGED"
            alert["acknowledged_by"] = payload.acknowledged_by
            alert["acknowledged_at"] = now_utc().isoformat()
            return alert
    return {"error": "alert not found"}


@app.post("/api/v1/demo/outbreak")
def seed_outbreak(ward: str = "Bambatha", count: int = 3) -> dict[str, Any]:
    for index in range(count):
        persist_case(
            CaseInput(
                client_case_id=f"demo-outbreak-{ward}-{uuid.uuid4().hex[:6]}-{index}",
                ward=ward,
                patient_pseudo_id=f"demo-{uuid.uuid4().hex[:6]}",
                age_months=24,
                sex="F",
                chief_complaint="diarrhoea",
                symptoms=["diarrhoea", "dehydration"],
                captured_at=now_utc() - timedelta(minutes=index),
            )
        )
    detect_outbreaks()
    return {"status": "seeded", "summary": dashboard_summary(), "alerts": ALERTS}


@app.get("/api/v1/dashboard")
def dashboard() -> dict[str, Any]:
    return {
        "summary": dashboard_summary(),
        "cases": CASES[:20],
        "alerts": ALERTS[:10],
    }
