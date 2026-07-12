#!/bin/sh
# Foreground Squid, logging to std streams. `cache deny all` means there is
# nothing to initialize, but -z is harmless and keeps startup robust.
set -e

# Validate the config early so a broken allowlist fails loudly (not silently open).
squid -k parse -f /etc/squid/squid.conf

squid -N -f /etc/squid/squid.conf -z 2>/dev/null || true

# -N: no daemon (stay in foreground for Docker). -d1: log to stderr.
exec squid -N -d1 -f /etc/squid/squid.conf
