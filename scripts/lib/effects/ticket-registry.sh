#!/usr/bin/env bash
# Host-owned broker ticket registry. common.sh must be sourced first.

broker_ticket_registry_dir() {
  # Two guarded steps, NOT one nested substitution: `canonicalize_path
  # "$(state_root)/broker-tickets"` only propagates the OUTER command's
  # status — a dying state_root would silently yield the literal argument
  # "/broker-tickets" (filesystem root), which canonicalizes fine and passes
  # reject_tasks_path.
  local sr registry_dir
  sr="$(state_root)" || return $?
  registry_dir="$(canonicalize_path "$sr/broker-tickets")" || return $?
  reject_tasks_path "$registry_dir"
  printf '%s' "$registry_dir"
}

register_broker_ticket() {
  local ticket="$1" registry_dir entry tmp created_at
  validate_ticket_id "$ticket"
  registry_dir="$(broker_ticket_registry_dir)" || return $?
  entry="$(canonicalize_path "$registry_dir/$ticket")" || return $?
  reject_tasks_path "$entry"
  mkdir -p "$registry_dir"
  tmp="$(mktemp "$registry_dir/.ticket.tmp.XXXXXX")" || die "cannot create broker ticket registry entry"
  created_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  if ! printf '{"ticket":"%s","created_at":"%s"}\n' "$ticket" "$created_at" > "$tmp"; then
    rm -f "$tmp"
    die "cannot write broker ticket registry entry for $ticket"
  fi
  if ! mv -f "$tmp" "$entry"; then
    rm -f "$tmp"
    die "cannot install broker ticket registry entry for $ticket"
  fi
}

deregister_broker_ticket() {
  local ticket="$1" registry_dir entry
  validate_ticket_id "$ticket"
  registry_dir="$(broker_ticket_registry_dir)" || return $?
  entry="$(canonicalize_path "$registry_dir/$ticket")" || return $?
  reject_tasks_path "$entry"
  [ -d "$registry_dir" ] || return 0
  rm -f "$entry"
}
