# Database backup sidecar: pg_dump, encrypt with age, copy offsite (any
# S3-compatible bucket), keep a short local history, and prove restores work.
FROM postgres:15-alpine
RUN apk add --no-cache aws-cli age bash coreutils
COPY backup.sh restore.sh verify-restore.sh entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/*.sh
ENV PGHOST=postgres PGUSER=agent PGDATABASE=salesagent
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
