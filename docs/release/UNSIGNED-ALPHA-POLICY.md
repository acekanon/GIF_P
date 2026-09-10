# GIFP unsigned Alpha distribution policy

GIFP currently produces a portable Windows executable rather than a signed
installer. An unsigned build is allowed only as an explicitly labelled Alpha
artifact after the mechanical release-compliance gates pass. It must never be
presented as a signed or generally available production release.

## Distribution channels

| Channel | Intended use | Public redistribution |
| --- | --- | --- |
| `internal` | Local development, QA and named evaluator hand-off | No |
| `public-alpha` | Limited public Alpha after all release gates pass | Yes, subject to the selected project license and legal review |
| `public` | Formal public release; valid allowlisted Authenticode is mandatory | Yes, subject to the selected project license and legal review |

The unsigned exception in this policy applies only to `public-alpha`.
`public` rejects `NotSigned`, rejects invalid signature states, and forbids
`GIFP_ALLOW_UNSIGNED_ALPHA` even when it is present in the environment.

`public-alpha` packaging requires all of the following:

1. A clean, identified Git commit and matching current production assets.
2. An explicit GIFP project-license identifier and the exact license text.
3. The pinned FFmpeg runtime, immutable binary/source/build-recipe provenance,
   and a reviewed Corresponding Source bundle with a verified SHA-256 digest.
4. A generated third-party dependency manifest and the applicable notices.
5. A valid Authenticode signature, or an explicit
   `GIFP_ALLOW_UNSIGNED_ALPHA=1` override that keeps this policy in the package.
6. SHA-256 checksums for the portable archive and its packaged files.

## User-facing rules for an unsigned Alpha

- Label the artifact **Unsigned Alpha** on the release page and in its build
  record. Do not imply that Windows, Microsoft, FFmpeg or Gyan.dev endorses it.
- Publish the archive SHA-256 next to the download and tell users how to verify
  it before running the executable.
- Explain that Windows SmartScreen may warn because no trusted publisher
  signature is present. Never instruct users to disable SmartScreen globally.
- Do not request administrator privileges. GIFP remains portable and stores no
  updater or background service.
- Do not auto-update an unsigned build. A future updater must verify a signed
  manifest before replacing executable code.
- Keep the exact source/provenance materials available for at least as long as
  the corresponding binary remains available.

The packaging gates are evidence controls, not a legal opinion. Public release
still requires a human review of the selected GIFP license, the selected FFmpeg
runtime's license terms, all linked components and the actual distribution
method.
