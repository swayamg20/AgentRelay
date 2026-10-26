#!/usr/bin/env bash
# Runs repeated Codex sessions until the run deadline, the session cap, or a STOP file.
# Each session starts with a fresh context and resumes from autopilot/STATE.md.
#
# The harness (this script, PROMPT.md, codex-config.toml, GOALS.md) is read from
# AUTOPILOT_HARNESS, a root-owned copy taken from main, so the agent cannot change its
# own instructions. The model is reached through a key-injecting proxy at
# AUTOPILOT_MODEL_URL that runs as another user; no API key is in this environment.
#
# Required env: AUTOPILOT_OUT, AUTOPILOT_DEADLINE (epoch seconds), AUTOPILOT_HARNESS,
#               AUTOPILOT_MODEL_URL (for example http://127.0.0.1:18080/v1)
# Optional env: AUTOPILOT_MODEL, AUTOPILOT_FALLBACK_MODEL, AUTOPILOT_MAX_SESSIONS,
#               AUTOPILOT_RUN_ID
set -uo pipefail

: "${AUTOPILOT_OUT:?}" "${AUTOPILOT_DEADLINE:?}" "${AUTOPILOT_HARNESS:?}" "${AUTOPILOT_MODEL_URL:?}"
model="${AUTOPILOT_MODEL:-gpt-6.1-sol}"
fallback="${AUTOPILOT_FALLBACK_MODEL:-FW-GLM-5.3}"
max_sessions="${AUTOPILOT_MAX_SESSIONS:-8}"
run_id="${AUTOPILOT_RUN_ID:-local}"

export CODEX_HOME="$AUTOPILOT_OUT/codex-home"
mkdir -p "$CODEX_HOME" "$AUTOPILOT_OUT/questions"
cp "$AUTOPILOT_HARNESS/codex-config.toml" "$CODEX_HOME/config.toml"
touch "$AUTOPILOT_OUT/inbox.md" "$AUTOPILOT_OUT/sessions.log"

build_prompt() {
	local session="$1" minutes_left="$2" active_model="$3"
	cat "$AUTOPILOT_HARNESS/PROMPT.md"
	printf '\n## Goals (from main, owner-controlled)\n\n'
	cat "$AUTOPILOT_HARNESS/GOALS.md"
	printf '\n## Owner inbox\n\n'
	if [[ -s "$AUTOPILOT_OUT/inbox.md" ]]; then cat "$AUTOPILOT_OUT/inbox.md"; else echo "No open questions."; fi
	printf '\n## This session\n\n'
	printf -- '- Run id: %s\n- Model: %s\n- Session %s of at most %s\n- About %s minutes remain in this run. Leave time to commit and update memory.\n' \
		"$run_id" "$active_model" "$session" "$max_sessions" "$minutes_left"
}

for ((session = 1; session <= max_sessions; session++)); do
	[[ -e "$AUTOPILOT_OUT/STOP" ]] && { echo "STOP file present; ending run."; break; }
	minutes_left=$(((AUTOPILOT_DEADLINE - $(date +%s)) / 60))
	((minutes_left < 15)) && { echo "Less than 15 minutes left; ending run."; break; }

	ok=false
	for active_model in "$model" "$fallback"; do
		# Recomputed per attempt, so a fallback never runs past the deadline.
		minutes_left=$(((AUTOPILOT_DEADLINE - $(date +%s)) / 60))
		((minutes_left < 10)) && { echo "Too little time left for $active_model."; break; }
		budget=$((minutes_left < 75 ? minutes_left - 5 : 70))
		echo "::group::session $session · $active_model · ${budget}m budget"
		build_prompt "$session" "$minutes_left" "$active_model" |
			timeout -k 2m "${budget}m" codex exec \
				--model "$active_model" \
				-c "model_providers.keyproxy.base_url=\"$AUTOPILOT_MODEL_URL\"" \
				--dangerously-bypass-approvals-and-sandbox \
				--output-last-message "$AUTOPILOT_OUT/session-$session.md" \
				-
		rc=$?
		echo "::endgroup::"
		printf '%s\tsession=%s\tmodel=%s\texit=%s\n' "$(date -u +%FT%TZ)" "$session" "$active_model" "$rc" >>"$AUTOPILOT_OUT/sessions.log"
		# 0 is a normal finish; 124 means the session used its whole time budget.
		if ((rc == 0 || rc == 124)); then
			ok=true
			break
		fi
		echo "::warning::$active_model exited with $rc"
	done
	$ok || { echo "::error::All models failed in session $session; ending run."; break; }
done
