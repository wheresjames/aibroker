# k3s Deployment

Apply order:

```sh
kubectl apply -f namespace.yaml
kubectl apply -f secret.example.yaml
kubectl apply -f api.yaml -f web.yaml -f worker.yaml
kubectl apply -f migrate-job.yaml
kubectl apply -f backup-pvc.yaml -f backup-cronjob.yaml
kubectl apply -f ingress.yaml -f network-policy.yaml
```

Replace `secret.example.yaml` values before production use. Prefer an external secret manager for production.

Rollback:

```sh
kubectl -n aibroker rollout undo deploy/aibroker-api
kubectl -n aibroker rollout undo deploy/aibroker-web
kubectl -n aibroker rollout undo deploy/aibroker-worker
```
