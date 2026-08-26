# Security policy

## Reporting a vulnerability

Report privately, **not** as a public issue: use GitHub's private vulnerability
reporting on this repository, or email the maintainer.

Please include the version, the platform, what you were able to make the server
do, and a minimal reproduction. If your reproduction needs a credential, use a
synthetic one — never send a real secret.

You should get an acknowledgement within a few working days. A fix for a
confirmed issue in the security surface takes priority over feature work in any
phase.

## What counts as a vulnerability here

The security surface is documented in [docs/security.md](docs/security.md). The
following are in scope and are treated as defects, not as design trade-offs:

- Reading a file outside the approved workspace roots, by any route — traversal,
  symlink, junction, UNC path, device path, alternate data stream, or a
  case-sensitivity difference.
- Reading a file matched by the deny-list, from any code path — including a read
  the server initiated rather than one an agent asked for.
- A credential reaching a result, evidence item, warning, error or log line.
- An absolute path appearing in any field of any result.
- An internal exception message, stack trace or module path reaching the client.
- Executing anything from the automation project — importing, evaluating,
  requiring or spawning it.
- A byte reaching stdout that is not a JSON-RPC message.
- An input that makes the server stop answering: an unbounded regex scan, an
  unbounded read, or a scan that ignores its own limits.

## What is deliberate and not a vulnerability

- **Over-redaction.** A false positive costs one clarifying question; a false
  negative leaks a credential. If a legitimately non-secret key is redacted,
  please still report it — the exemption list is meant to grow — but it is a
  usability issue, not a security one.
- **The server starting unconfigured.** It starts and every capability returns an
  actionable `configurationError`. Exiting would leave the client showing a
  server that vanished.
- **`unknown` answers.** Discovery declines to guess. That is the product working.
- **`securityRefusal` echoing the candidate path you supplied.** It never echoes
  the resolved path.

## Supported versions

This is pre-1.0 and under active phased development. Security fixes land on the
latest release; there is no back-porting until 1.0.

## Credentials in this repository

Every credential-shaped literal in the tests, fixtures, examples and
documentation is **synthetic**: invented passwords, the textbook HS256 JWT that
signs nothing, a PEM body that is literally the alphabet, and RFC 2606 reserved
domains (`example.com`, `example.test`, `example.invalid`). Nothing here has ever
been valid anywhere. Contributions must keep it that way.
