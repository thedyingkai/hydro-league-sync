# Security Policy

## Supported versions

The latest `0.1.x` release receives security fixes. Pre-release builds and
modified deployments are supported only after the issue is reproduced against
the latest tagged source.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use the repository's
[private vulnerability reporting form](https://github.com/thedyingkai/hydro-league-sync/security/advisories/new)
and include the affected version, deployment model, impact, reproduction steps,
and any proposed fix. Do not include real site HMAC secrets, administrator
tokens, contestant data, submission source, or production database contents.

Rotate credentials immediately if they may have been exposed. Acknowledgement
or remediation timelines depend on severity and the ability to reproduce the
issue; no fixed response SLA is promised.

## Deployment boundary

The Hub must listen on loopback or a private container network behind HTTPS.
Administrative endpoints must not be published by the reverse proxy. Each
school must receive a unique HMAC secret and must keep its Agent configuration
private. The school Agent intentionally uploads scoring metadata only.
