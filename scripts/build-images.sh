#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-oceanhub-dev}"
TAG="${TAG:-local}"
BACKEND_IMAGE="${BACKEND_IMAGE:-sentinel-backend:${TAG}}"
FRONTEND_IMAGE="${FRONTEND_IMAGE:-sentinel-frontend:${TAG}}"
REGISTRY_PREFIX="${REGISTRY_PREFIX:-}"

if [[ -n "${REGISTRY_PREFIX}" ]]; then
  BACKEND_IMAGE="${REGISTRY_PREFIX}/sentinel-backend:${TAG}"
  FRONTEND_IMAGE="${REGISTRY_PREFIX}/sentinel-frontend:${TAG}"
fi

echo "Building backend image: ${BACKEND_IMAGE}"
docker build -t "${BACKEND_IMAGE}" backend

echo "Building frontend image: ${FRONTEND_IMAGE}"
docker build -t "${FRONTEND_IMAGE}" frontend

echo
echo "Built Docker images:"
echo "  ${BACKEND_IMAGE}"
echo "  ${FRONTEND_IMAGE}"
echo
echo "Example local runs:"
echo "  docker run --rm -p 8000:8080 ${BACKEND_IMAGE}"
echo "  docker run --rm -p 8501:8080 -e BACKEND_URL=http://host.docker.internal:8000 ${FRONTEND_IMAGE}"
echo
echo "For Artifact Registry later, set REGISTRY_PREFIX, for example:"
echo "  REGISTRY_PREFIX=us-central1-docker.pkg.dev/${PROJECT_ID}/sentinel TAG=demo ./scripts/build-images.sh"
