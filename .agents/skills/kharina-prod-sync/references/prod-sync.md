# Kharina Production Sync Reference

## Local checks

Run from the project root:

```bash
git status --short --branch
git log --oneline --decorate -n 6
```

If the project has a dedicated production worktree, also inspect it:

```bash
cd /home/guilherme/Documentos/GG.AI/WEGO-PROJECTS/bot-kharina-lang-prod
git status --short --branch
git rev-parse --short HEAD
```

## VPS checks

Current VPS checkout:

```bash
ssh -i ~/.ssh/id_vps_access -o IdentitiesOnly=yes -o StrictHostKeyChecking=no root@72.60.137.167 \
  'cd /root/kharina-bot-v2 && git rev-parse --short HEAD && git status --short --branch'
```

Current Swarm state:

```bash
ssh -i ~/.ssh/id_vps_access -o IdentitiesOnly=yes -o StrictHostKeyChecking=no root@72.60.137.167 \
  "docker service ls --format 'NAME={{.Name}} REPLICAS={{.Replicas}}' | grep 'kharina-bot-v2_' && \
   docker ps --format 'ID={{.ID}} IMAGE={{.Image}} NAMES={{.Names}} STATUS={{.Status}}' | grep 'kharina-bot-v2_'"
```

## Safe VPS drift handling

Inspect drift first:

```bash
ssh -i ~/.ssh/id_vps_access -o IdentitiesOnly=yes -o StrictHostKeyChecking=no root@72.60.137.167 \
  "cd /root/kharina-bot-v2 && git status --short --branch && git diff --stat"
```

If the drift is not the new source of truth, stash it:

```bash
ssh -i ~/.ssh/id_vps_access -o IdentitiesOnly=yes -o StrictHostKeyChecking=no root@72.60.137.167 \
  "cd /root/kharina-bot-v2 && git stash push -u -m 'pre-deploy-drift-YYYY-MM-DD'"
```

Confirm saved stashes:

```bash
ssh -i ~/.ssh/id_vps_access -o IdentitiesOnly=yes -o StrictHostKeyChecking=no root@72.60.137.167 \
  "cd /root/kharina-bot-v2 && git stash list | head -5"
```

## Deploy sequence

Push the intended commit first:

```bash
git push origin main
```

Update the VPS checkout and run the deploy:

```bash
ssh -i ~/.ssh/id_vps_access -o IdentitiesOnly=yes -o StrictHostKeyChecking=no root@72.60.137.167 \
  "cd /root/kharina-bot-v2 && git pull --no-rebase origin main && ./deploy.sh production"
```

If the stack is still using `latest`, force the backend service to cycle after the build:

```bash
ssh -i ~/.ssh/id_vps_access -o IdentitiesOnly=yes -o StrictHostKeyChecking=no root@72.60.137.167 \
  "docker service update --force kharina-bot-v2_backend"
```

## Post-deploy verification

Confirm commit and backend service:

```bash
ssh -i ~/.ssh/id_vps_access -o IdentitiesOnly=yes -o StrictHostKeyChecking=no root@72.60.137.167 \
  "cd /root/kharina-bot-v2 && git rev-parse --short HEAD && \
   docker service ls --format 'NAME={{.Name}} REPLICAS={{.Replicas}}' | grep kharina-bot-v2_backend && \
   docker ps --format '{{.Image}} {{.Names}} {{.Status}}' | grep kharina-bot-v2_backend"
```

The expected success condition is:

- VPS checkout commit matches local `main`
- `kharina-bot-v2_backend` is `1/1`
- running backend container is `healthy`

## Production tagging

After a validated deploy, create a production tag:

```bash
git tag -a prod-YYYY-MM-DD-<shortsha> -m "Production snapshot YYYY-MM-DD"
git push origin prod-YYYY-MM-DD-<shortsha>
```

## Operating model

- Use `main` as the branch that must match production after reconciliation.
- Use production tags as immutable operational checkpoints.
- Avoid manual VPS edits without either:
  - porting them back into Git, or
  - stashing them explicitly before continuing.
