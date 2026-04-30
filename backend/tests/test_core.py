import os

os.environ["SEED_DEMO_DATA"] = "false"

from main import CaseInput, classify_locally, fallback_extract_from_transcript, triage_case


def test_danger_sign_bypasses_ai():
    result = triage_case(
        CaseInput(
            age_months=18,
            chief_complaint="convulsions and fever",
            symptoms=["fever"],
            danger_signs=["convulsions"],
        )
    )

    assert result["urgency"] == "RED"
    assert result["classification"] == "URGENT_REFERRAL"
    assert result["bypassed_ai"] is True


def test_local_pneumonia_classification_for_fast_breathing():
    result = classify_locally(
        CaseInput(
            age_months=24,
            chief_complaint="cough and fever",
            symptoms=["cough", "fever", "fast_breathing"],
            respiratory_rate=48,
        )
    )

    assert result["classification"] == "PNEUMONIA"
    assert result["urgency"] == "YELLOW"


def test_transcript_fallback_extracts_reviewable_form_fields():
    result = fallback_extract_from_transcript(
        "Two year old girl in Bambatha has fever and cough for three days, breathing fast, temperature thirty nine"
    )

    assert result["age_months"] == 24
    assert result["sex"] == "F"
    assert "fever" in result["symptoms"]
    assert "cough" in result["symptoms"]
    assert "fast_breathing" in result["symptoms"]
    assert result["human_review_required"] is True
