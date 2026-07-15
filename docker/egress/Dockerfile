# Egress gateway: an explicit Squid forward proxy (Approach A).
# Userspace only — no NET_ADMIN, no NET_RAW. The allowlist is BAKED INTO the
# image and owned by root/read-only; the coder (a separate container with no
# Docker API and no shared caps) cannot rewrite it.
FROM alpine:3.20

RUN apk add --no-cache squid

# Config + allowlist baked in. squid.conf reads the domain list from
# /etc/squid/allowlist.txt.
COPY squid.conf /etc/squid/squid.conf
COPY allowlist.txt /etc/squid/allowlist.txt
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 0644 /etc/squid/squid.conf /etc/squid/allowlist.txt \
 && chmod 0755 /usr/local/bin/entrypoint.sh

EXPOSE 3128

# Run as the unprivileged squid user (3128 > 1024, so no NET_BIND_SERVICE).
USER squid
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
