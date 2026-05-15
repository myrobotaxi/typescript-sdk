#!/usr/bin/env bash
# Regression guard for the claude-review.yml verdict extractor (MYR-100).
#
# The extraction logic lives inline in .github/workflows/claude-review.yml
# (3 passes: HTML tag → bold markdown → prose fallback). This script
# mirrors passes 2 and 3 verbatim and asserts them against fixtures —
# notably the PR #17 (MYR-50) body shape that previously mis-extracted
# CHANGES_REQUESTED from the words "None of these are blockers".
#
# Keep the regexes here byte-identical with claude-review.yml. If you
# change one, change both, and add a fixture.

set -euo pipefail

fail=0

# The workflow runs `grep -oiP 'verdict[*: ]+\K(...)'` on ubuntu (GNU
# grep). This mirror uses perl for the SAME PCRE so the regression test
# is portable to the dev's macOS (BSD grep has no -P). The pattern is
# byte-identical to claude-review.yml's pass 2.
extract_pass2() {
  printf '%s' "$1" | perl -ne 'print "$1\n" if /verdict[*: ]+(approve|request_changes|comment)/i' \
    | tail -1 | tr '[:lower:]' '[:upper:]' || true
}

extract_pass3() {
  local body="$1"
  if echo "$body" | grep -qiE '\brequest[[:space:]_-]?changes\b|\brequesting[[:space:]]+changes\b|\bneeds?[[:space:]]+changes\b|\bblocking[[:space:]]+(issue|problem|item)s?[[:space:]]+(found|identified|present)\b'; then
    echo "REQUEST_CHANGES"
  elif echo "$body" | grep -qiE '\bapproved?\b|\bno[[:space:]]+blocking[[:space:]]+issues?\b|\blgtm\b|\blooks[[:space:]]+good[[:space:]]+to[[:space:]]+(merge|ship|go)\b|\bship[[:space:]]+it\b|\bready[[:space:]]+to[[:space:]]+merge\b|\bcorrectly[[:space:]]+resolved\b'; then
    echo "APPROVE"
  fi
}

check() {
  local name="$1" expected="$2" got="$3"
  if [ "$got" = "$expected" ]; then
    echo "PASS  $name → $got"
  else
    echo "FAIL  $name → expected '$expected', got '$got'"
    fail=1
  fi
}

# Pass-2 format variants.
check "colon-inside-bold (PR #17 form)" "APPROVE" "$(extract_pass2 '**Verdict: APPROVE**')"
check "classic bold colon"             "APPROVE" "$(extract_pass2 '**Verdict:** APPROVE')"
check "bold label, plain value"        "APPROVE" "$(extract_pass2 '**Verdict** APPROVE')"
check "plain lowercase"                "APPROVE" "$(extract_pass2 'Verdict: approve')"
check "request_changes bold"           "REQUEST_CHANGES" "$(extract_pass2 '**Verdict: REQUEST_CHANGES**')"
check "comment bold (third arm)"       "COMMENT" "$(extract_pass2 '**Verdict: COMMENT**')"

# Pass-3 must NOT flip a clean approve when prose merely mentions
# "blockers" in a reassuring sentence (the PR #17 regression).
PR17_BODY='### Findings
#### Critical (must fix)
*(none)*
#### Suggestions
3. None of these are blockers — they are defensive paths with low blast radius.'
check "pass-3 no false REQUEST_CHANGES on 'no blockers'" "" "$(extract_pass3 "$PR17_BODY")"

# Pass-3 still catches a genuine change request.
check "pass-3 real request changes" "REQUEST_CHANGES" \
  "$(extract_pass3 'I am requesting changes: the auth path is unsafe.')"

if [ "$fail" -ne 0 ]; then
  echo "verdict-extraction regression test FAILED"
  exit 1
fi
echo "verdict-extraction regression test passed"
