#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-oceanhub-dev}"
PROJECT_NUMBER="${PROJECT_NUMBER:-744360072255}"
REGION="${REGION:-us-central1}"
BACKEND_SERVICE="${BACKEND_SERVICE:-sentinel-backend}"
FRONTEND_SERVICE="${FRONTEND_SERVICE:-sentinel-frontend}"
GEMINI_MODEL="${GEMINI_MODEL:-gemini-2.5-flash}"
GEMINI_SECRET_NAME="${GEMINI_SECRET_NAME:-sentinel-gemini-api-key}"

if ! command -v gcloud >/dev/null 2>&1; then
  echo "gcloud CLI is required. Install it and run: gcloud auth login"
  exit 1
fi

echo "Deploying Sentinel Health to project ${PROJECT_ID} (${PROJECT_NUMBER}) in ${REGION}"
gcloud config set project "${PROJECT_ID}"
RUNTIME_SERVICE_ACCOUNT="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

echo "Enabling required Google Cloud APIs"
if ! gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  bigquery.googleapis.com \
  secretmanager.googleapis.com \
  logging.googleapis.com \
  --project "${PROJECT_ID}"; then
  echo
  echo "Could not enable required APIs."
  echo "Most common cause: billing is not enabled on project ${PROJECT_ID} (${PROJECT_NUMBER})."
  echo "Enable billing for the project in Google Cloud Console, then rerun:"
  echo "  ./scripts/deploy-cloud-run.sh"
  exit 1
fi

echo "Ensuring Cloud Run source build service account has required roles"
for ROLE in roles/run.builder roles/storage.objectViewer roles/artifactregistry.writer roles/logging.logWriter; do
  gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member "serviceAccount:${RUNTIME_SERVICE_ACCOUNT}" \
    --role "${ROLE}" \
    --quiet >/dev/null
done

BACKEND_ENV="GEMINI_MODEL=${GEMINI_MODEL},SEED_DEMO_DATA=true,BIGQUERY_ENABLED=true,BIGQUERY_DATASET=sentinel_demo"
BACKEND_SECRET_ARGS=()
if gcloud secrets describe "${GEMINI_SECRET_NAME}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud secrets add-iam-policy-binding "${GEMINI_SECRET_NAME}" \
    --project "${PROJECT_ID}" \
    --member "serviceAccount:${RUNTIME_SERVICE_ACCOUNT}" \
    --role "roles/secretmanager.secretAccessor" \
    --quiet >/dev/null
  BACKEND_SECRET_ARGS=(--set-secrets "GEMINI_API_KEY=${GEMINI_SECRET_NAME}:latest")
else
  echo "Secret ${GEMINI_SECRET_NAME} was not found; backend will use deterministic demo fallback."
  echo "Create it with: ./scripts/create-gemini-secret.sh"
fi

echo "Deploying backend Cloud Run service: ${BACKEND_SERVICE}"
(
  cd backend
  gcloud run deploy "${BACKEND_SERVICE}" \
    --source . \
    --project "${PROJECT_ID}" \
    --region "${REGION}" \
    --allow-unauthenticated \
    --set-env-vars "${BACKEND_ENV}" \
    "${BACKEND_SECRET_ARGS[@]}"
)

BACKEND_URL="$(gcloud run services describe "${BACKEND_SERVICE}" \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --format 'value(status.url)')"

echo "Backend URL: ${BACKEND_URL}"

echo "Deploying frontend Cloud Run service: ${FRONTEND_SERVICE}"
(
  cd frontend
  gcloud run deploy "${FRONTEND_SERVICE}" \
    --source . \
    --project "${PROJECT_ID}" \
    --region "${REGION}" \
    --allow-unauthenticated \
    --set-env-vars "BACKEND_URL=${BACKEND_URL}"
)

FRONTEND_URL="$(gcloud run services describe "${FRONTEND_SERVICE}" \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --format 'value(status.url)')"

echo
echo "Deployment complete"
echo "Frontend: ${FRONTEND_URL}"
echo "Backend:  ${BACKEND_URL}"
echo "Health:   ${BACKEND_URL}/api/v1/health"
