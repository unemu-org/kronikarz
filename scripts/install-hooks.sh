#!/usr/bin/env bash
# Install local git hooks under .git/hooks/.
# Run once after cloning: bash scripts/install-hooks.sh

set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

cat > .git/hooks/pre-commit <<'EOF'
#!/usr/bin/env bash
set -e

# Skip when there is nothing JS/TS-related staged
if ! git diff --cached --name-only | grep -qE '\.(ts|tsx|js|jsx|json|yaml|md)$'; then
  exit 0
fi

# Only check staged files via prettier
files="$(git diff --cached --name-only --diff-filter=ACM | grep -E '\.(ts|tsx|js|jsx|json|yaml|md)$' || true)"
if [ -n "$files" ]; then
  echo "[pre-commit] prettier --check"
  echo "$files" | xargs npx --no-install prettier --check
fi

echo "[pre-commit] tsc --noEmit (shared, viewer, export)"
npm run typecheck --workspaces --if-present
EOF
chmod +x .git/hooks/pre-commit
echo "installed .git/hooks/pre-commit"
