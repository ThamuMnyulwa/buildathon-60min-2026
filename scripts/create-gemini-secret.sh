#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-oceanhub-dev}"
REGION="${REGION:-us-central1}"
GEMINI_SECRET_NAME="${GEMINI_SECRET_NAME:-sentinel-gemini-api-key}"

if ! command -v gcloud >/dev/null 2>&1; then
  echo "gcloud CLI is required. Install it and run: gcloud auth login"
  exit 1
fi

gcloud config set project "${PROJECT_ID}"
gcloud services enable secretmanager.googleapis.com --project "${PROJECT_ID}"

read -r -s -p "Paste Gemini API key for Secret Manager (input hidden): " GEMINI_KEY
echo

if [[ -z "${GEMINI_KEY}" ]]; then
  echo "No key provided."
  exit 1
fi

if gcloud secrets describe "${GEMINI_SECRET_NAME}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
  printf "%s" "${GEMINI_KEY}" | gcloud secrets versions add "${GEMINI_SECRET_NAME}" \
    --project "${PROJECT_ID}" \
    --data-file=-
else
  printf "%s" "${GEMINI_KEY}" | gcloud secrets create "${GEMINI_SECRET_NAME}" \
    --project "${PROJECT_ID}" \
    --replication-policy="automatic" \
    --data-file=-
fi

unset GEMINI_KEY

echo "Stored Gemini key in Secret Manager secret: ${GEMINI_SECRET_NAME}"
echo "Next deploy with: ./scripts/deploy-cloud-run.sh"
