# infra

Local development infrastructure only.

- `docker-compose.yml` — PostgreSQL 16 for local dev (`qualios`/`qualios`, database `qualios_dev`, port 5432). Start with `docker compose -f infra/docker-compose.yml up -d db`.
- Staging/production infrastructure (managed cloud, secret management, backups, monitoring, disaster recovery) is a later phase — blueprint §8, Phase 3 (months 5–8). It is not designed here.
