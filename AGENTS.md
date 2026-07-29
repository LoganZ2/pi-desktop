# AGENTS.md

## Before Pushing

Before every push to the remote repository, increment the project version exactly once. Choose the command that matches the change:

```bash
# Bug fixes and small changes: 1.0.0 -> 1.0.1
npm run version:patch

# Backward-compatible features: 1.0.0 -> 1.1.0
npm run version:minor

# Breaking changes or major milestones: 1.0.0 -> 2.0.0
npm run version:major
```

These commands update both `package.json` and `package-lock.json`. Include both updated files in the commit being pushed.

Do not push without performing one appropriate version bump. Do not run more than one version command for the same push. If a push fails and you retry the same commit without making additional changes, do not bump the version again.
