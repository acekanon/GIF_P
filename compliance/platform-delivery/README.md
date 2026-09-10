# Platform delivery evidence registry

This directory defines the offline, auditable input accepted by
`scripts/verify-platform-delivery-evidence.mjs`. The repository intentionally
contains no real external-client evidence today. Do not add a record until the
complete controlled-client lifecycle in
`docs/platform-delivery/VALIDATION-PROTOCOL.md` has actually been performed.

Run the verifier with an explicit clock for reproducible review:

```text
node scripts/verify-platform-delivery-evidence.mjs evidence.json --now 2026-07-29T08:00:00.000Z
```

The command writes exactly one JSON summary to standard output. `valid: true`
and exit code 0 mean every record is current and structurally valid. Invalid,
expired, future-dated, duplicate, unknown-policy, revision-mismatched or
incomplete evidence returns `valid: false` and exit code 1. Input/usage failures
return exit code 2. Empty evidence is valid as a registry file, but has
`deviceVerifiedCount: 0` and does not establish platform verification.

The schema is deliberately closed: unknown fields are rejected at every level.
Evidence defaults to a 180-day lifetime. A policy revision or policy-set change
requires updating this contract and re-running the external-client test; it must
not be silently accepted as evidence for the new policy.
