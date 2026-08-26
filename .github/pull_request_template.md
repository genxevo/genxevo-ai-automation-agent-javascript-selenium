## What this changes

## Why

If this rejects an alternative that a reasonable reviewer would have chosen, say
which one and why — that belongs in `docs/decisions.md` if it is architectural.

## Verification

- [ ] `npm run verify` passes locally
- [ ] `scripts/check.sh` (or `check.ps1`) passes locally
- [ ] Every claimed capability has an automated test
- [ ] No stub, placeholder, or "not implemented" tool was added
- [ ] Coverage did not go down (thresholds are a ratchet)

## Contract impact

- [ ] No change to the published envelope
- [ ] Optional field added (minor)
- [ ] Breaking change — `contractVersion` bumped and an ADR added

## Security impact

- [ ] No change to the security surface
- [ ] Changes a control in `docs/security.md` — the document is updated in this PR
- [ ] Adds a new file-read path — it goes through `boundedRead`

## Synthetic credentials only

- [ ] Every credential-shaped literal added here is invented, and every domain is
      an RFC 2606 reserved name
