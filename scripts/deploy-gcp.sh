#!/usr/bin/env bash
set -euo pipefail

: "${PROJECT_ID:?Set PROJECT_ID to the target Google Cloud project.}"
REGION="${REGION:-asia-southeast2}"
SERVICE="${SERVICE:-mini-task-manager}"
REPOSITORY="${REPOSITORY:-mini-task-manager}"
MONGO_SECRET="${MONGO_SECRET:-mini-task-mongodb-uri}"
REDIS_SECRET="${REDIS_SECRET:-mini-task-redis-url}"
MONGO_DB_NAME="${MONGO_DB_NAME:-mini_tasks}"
SERVICE_ACCOUNT="mini-task-runtime@${PROJECT_ID}.iam.gserviceaccount.com"
IMAGE_URI="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY}/${SERVICE}:$(date -u +%Y%m%d%H%M%S)"

command -v gcloud >/dev/null || { echo 'Install the Google Cloud CLI before deployment.' >&2; exit 1; }
gcloud services enable run.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com secretmanager.googleapis.com iam.googleapis.com --project "$PROJECT_ID"

if ! gcloud artifacts repositories describe "$REPOSITORY" --location "$REGION" --project "$PROJECT_ID" >/dev/null 2>&1; then
  gcloud artifacts repositories create "$REPOSITORY" --repository-format docker --location "$REGION" --project "$PROJECT_ID"
fi
if ! gcloud iam service-accounts describe "$SERVICE_ACCOUNT" --project "$PROJECT_ID" >/dev/null 2>&1; then
  gcloud iam service-accounts create mini-task-runtime --display-name 'Mini Task Manager runtime' --project "$PROJECT_ID"
fi
for secret in "$MONGO_SECRET" "$REDIS_SECRET"; do
  gcloud secrets versions describe latest --secret "$secret" --project "$PROJECT_ID" >/dev/null
  gcloud secrets add-iam-policy-binding "$secret" --member "serviceAccount:${SERVICE_ACCOUNT}" --role roles/secretmanager.secretAccessor --project "$PROJECT_ID" >/dev/null
done

gcloud builds submit --tag "$IMAGE_URI" --project "$PROJECT_ID" .
deployment_flags=(--no-allow-unauthenticated)
if [[ "${PUBLIC_DEMO:-false}" == 'true' ]]; then deployment_flags=(--allow-unauthenticated); fi
if [[ -n "${GCP_NETWORK:-}" || -n "${GCP_SUBNET:-}" ]]; then
  : "${GCP_NETWORK:?Set both GCP_NETWORK and GCP_SUBNET for private Redis networking.}"
  : "${GCP_SUBNET:?Set both GCP_NETWORK and GCP_SUBNET for private Redis networking.}"
  deployment_flags+=(--network "$GCP_NETWORK" --subnet "$GCP_SUBNET" --vpc-egress private-ranges-only)
fi
gcloud run deploy "$SERVICE" --image "$IMAGE_URI" --project "$PROJECT_ID" --region "$REGION" \
  --service-account "$SERVICE_ACCOUNT" --port 8080 --timeout 3600 --concurrency 80 --min-instances 0 --max-instances 3 \
  --set-env-vars "NODE_ENV=production,MONGO_DB_NAME=${MONGO_DB_NAME}" \
  --set-secrets "MONGODB_URI=${MONGO_SECRET}:latest,REDIS_URL=${REDIS_SECRET}:latest" \
  "${deployment_flags[@]}" --quiet
gcloud run services describe "$SERVICE" --project "$PROJECT_ID" --region "$REGION" --format 'value(status.url)'
