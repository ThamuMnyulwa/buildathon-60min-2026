## Infrastructure And Deployment

This folder is reserved for Terraform/OpenTofu infrastructure. At the moment there are no `.tf` files here; the demo deploys through the checked-in Cloud Run helper scripts.

## Current Deployment Flow

The current production-like demo path is:

```bash
gcloud auth login
gcloud auth application-default login
./scripts/create-gemini-secret.sh
./scripts/deploy-cloud-run.sh
```

`scripts/create-gemini-secret.sh` stores the Gemini API key in Google Secret Manager as `sentinel-gemini-api-key`. The key should not be committed and should not be placed in frontend env files.

`scripts/deploy-cloud-run.sh` then:

- Enables the required Google Cloud APIs for Cloud Run, Cloud Build, Artifact Registry, BigQuery, Secret Manager, and Logging.
- Grants the Cloud Run runtime service account access to the Gemini secret when it exists.
- Deploys `sentinel-backend` from `backend/` with `BIGQUERY_ENABLED=true`.
- Reads the backend Cloud Run URL.
- Deploys `sentinel-frontend` from `frontend/` with `BACKEND_URL` pointed at the backend.

Default deployment values are defined in the scripts:

- Project: `oceanhub-dev`
- Project number: `744360072255`
- Region: `us-central1`
- Backend service: `sentinel-backend`
- Frontend service: `sentinel-frontend`
- BigQuery dataset: `sentinel_demo`

The backend creates the BigQuery dataset and tables at startup when BigQuery is enabled. Runtime case and alert data is streamed by the FastAPI backend.

## Terraform Notes

When Terraform is added, keep state and secret inputs out of git. The root `.gitignore` excludes `.terraform/`, `*.tfstate`, `*.tfvars`, crash logs, and local credential JSON files.

Recommended first Terraform resources:

- Google project services/APIs
- Secret Manager secret for Gemini
- Cloud Run backend and frontend services
- IAM bindings for the Cloud Run runtime service account
- Optional BigQuery dataset/table definitions if we want schema ownership in IaC instead of app startup

Use remote state before collaborating on real infrastructure. Do not commit local state files, generated plans, service account keys, or environment-specific `tfvars`.
