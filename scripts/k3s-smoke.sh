#!/usr/bin/env bash
set -Eeuo pipefail

NAMESPACE="${NAMESPACE:-aibroker}"

kubectl -n "$NAMESPACE" rollout status deploy/aibroker-api
kubectl -n "$NAMESPACE" rollout status deploy/aibroker-web
kubectl -n "$NAMESPACE" rollout status deploy/aibroker-worker
kubectl -n "$NAMESPACE" get pods

API_POD="$(kubectl -n "$NAMESPACE" get pod -l app=aibroker-api -o jsonpath='{.items[0].metadata.name}')"
kubectl -n "$NAMESPACE" exec "$API_POD" -- node -e "const r=await fetch('http://127.0.0.1:8080/health/ready'); if(!r.ok) process.exit(1); console.log(await r.text())"
kubectl -n "$NAMESPACE" exec "$API_POD" -- node -e "const r=await fetch('http://127.0.0.1:8080/metrics'); if(!r.ok) process.exit(1); console.log((await r.text()).split('\n').slice(0,6).join('\n'))"
