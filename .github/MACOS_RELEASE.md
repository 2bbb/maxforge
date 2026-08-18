# macOS direct distribution for Max packages

Public ZIP releases are a fail-closed pipeline:

```text
Release build -> Developer ID sign -> verify -> ditto transport archive
-> assemble final package -> notarize exact public ZIP -> extract and verify
-> SHA-256 -> publish ZIP and checksum
```

Pull requests build and package without credentials. A manual dispatch, push
to `main`, or published GitHub Release must have every required credential;
otherwise the package job fails instead of silently producing an unsigned ZIP.
Manual dispatch uploads a signed CI artifact without changing a GitHub Release,
which is the safe credential-validation path before enabling publication.

The expected signing identity is constructed rather than supplied as free-form
input:

```text
Developer ID Application: ISHII 2BIT PROGRAM OFFICE (${APPLE_TEAM_ID})
```

## Required GitHub Actions secrets

| Secret | Value |
|---|---|
| `MACOS_CERTIFICATE_P12_BASE64` | Password-protected Developer ID Application certificate and private key, base64 encoded |
| `MACOS_CERTIFICATE_PASSWORD` | Password used when exporting the PKCS#12 file |
| `APPLE_TEAM_ID` | Team ID for ISHII 2bit Program Office |
| `APPLE_API_KEY_ID` | App Store Connect Team API key ID |
| `APPLE_API_ISSUER_ID` | App Store Connect API issuer ID |
| `APPLE_API_PRIVATE_KEY_P8_BASE64` | Team API private key, base64 encoded |

Do not use an Individual API key. Do not commit `.p12`, `.p8`, passwords, or
decoded credentials. The script creates a temporary keychain and deletes the
decoded certificate/key files before the job ends.

Encode files locally without printing them:

```bash
base64 -i DeveloperIDApplication.p12 | pbcopy
base64 -i AuthKey_KEYID.p8 | pbcopy
```

## Vendoring into a package repository

Copy `templates/macos-direct-distribution.sh` to
`.github/scripts/macos-direct-distribution.sh`, keep the copy executable, and
call it only from a GitHub-hosted macOS runner. Vendor the script at the same
commit as the workflow: a signing job must not execute release tooling from a
mutable remote branch.

The package CMake must emit a `CFBundleIdentifier` matching
`jp.2bit.<sanitized-external-name>`. The script refuses to sign mismatched
metadata. It also validates signing authority, Team ID, signing identifier,
the notarization result, the re-extracted final ZIP, and the checksum.

`.mxo` and ZIP are not stapler-supported containers. The exact ZIP accepted by
the notary service is therefore the public artifact; do not rebuild it after
submission. A separate Max host load test remains a product-specific release
gate and is not replaced by notarization.

## Account-level limitation

`2bbb` is a GitHub user account, not a GitHub Organization. Organization-level
Actions secrets therefore cannot be shared across these repositories. Register
the six secret names above in every public package repository, or migrate the
repositories to an Organization before centralizing secrets. Secret values
cannot be recovered from GitHub, so keep the original certificate and API key
in an access-controlled credential backup and document their rotation dates.
