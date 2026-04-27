---
name: kharina-prod-sync
description: Align the Kharina bot source of truth across the local checkout, GitHub main/tags, and the VPS deployment. Use when production is the authoritative state, when another agent changed the VPS directly, when drift is suspected between local, remote, and running services, or before and after production deploys to verify that code, commit, and container state all match.
---

# Kharina Prod Sync

Keep the repository, GitHub, and VPS aligned around a single production truth.

## Workflow

1. Inspect the three states:
   - local checkout commit and branch status
   - `origin/main`
   - VPS checkout commit and running Swarm services
2. Decide whether production is the source of truth or whether Git already contains the intended state.
3. If the VPS has uncommitted drift, inspect it before changing anything.
4. Preserve drift with `git stash` on the VPS instead of overwriting it blindly.
5. Pull the intended commit into the VPS checkout.
6. Rebuild and redeploy from the VPS checkout.
7. Verify the real state after deploy:
   - VPS git commit
   - Swarm replica count
   - healthy running containers
8. Tag the deployed commit in Git after the deploy is confirmed.

## Rules

- Prefer `main` as the long-term canonical branch.
- Treat production as the source of truth only when the running system is known-good.
- Do not leave manual VPS edits unrecorded; stash them or port them back into Git.
- Do not assume `latest` means aligned. Always confirm the Git commit on the VPS checkout and the running Swarm task.
- If the deploy script reports a noisy health-check failure during a rolling update, verify the real Swarm state before declaring failure.

## Current Kharina Environment

- Local repo: `/home/guilherme/Documentos/GG.AI/WEGO-PROJECTS/bot-kharina-lang`
- Production-sync local worktree: `/home/guilherme/Documentos/GG.AI/WEGO-PROJECTS/bot-kharina-lang-prod`
- VPS repo: `/root/kharina-bot-v2`
- Stack: `kharina-bot-v2`
- Backend service: `kharina-bot-v2_backend`
- LangChain service: `kharina-bot-v2_langchain`

## Decision Points

### Production already matches `main`

- Confirm local `main`, `origin/main`, and the VPS checkout are on the same commit.
- Create a production tag after validation.
- Continue work from `main`.

### VPS checkout has drift

- Read the drift before acting.
- If it is not the new source of truth, stash it on the VPS with a dated message.
- Pull the intended commit after stashing.
- If the drift is valid production behavior, bring it back into Git first.

### Production is ahead of Git

- Snapshot production into a dedicated sync branch or worktree.
- Review and validate the extracted code.
- Merge or fast-forward that state into `main`.
- Only then continue feature work or redeploy.

## References

- Read `references/prod-sync.md` for the concrete command sequence and verification checklist.
