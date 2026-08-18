#!/usr/bin/env bash

set -euo pipefail

readonly EXPECTED_DEVELOPER_NAME="ISHII 2BIT PROGRAM OFFICE"
readonly BUNDLE_ID_PREFIX="jp.2bit"

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

require_env() {
  local name
  for name in "$@"; do
    [[ -n "${!name:-}" ]] || die "required environment variable is missing: ${name}"
  done
}

require_macos() {
  [[ "$(uname -s)" == "Darwin" ]] || die "this command must run on macOS"
}

sanitize_identifier_component() {
  printf '%s' "$1" \
    | tr '[:upper:]' '[:lower:]' \
    | sed -E 's/[^a-z0-9.-]+/-/g; s/^-+//; s/-+$//'
}

expected_identity() {
  require_env APPLE_TEAM_ID
  printf 'Developer ID Application: %s (%s)' \
    "$EXPECTED_DEVELOPER_NAME" "$APPLE_TEAM_ID"
}

bundle_identifier() {
  local name component
  name="$(basename "$1" .mxo)"
  component="$(sanitize_identifier_component "$name")"
  [[ -n "$component" ]] || die "cannot derive a signing identifier from: $1"
  printf '%s.%s' "$BUNDLE_ID_PREFIX" "$component"
}

mxo_count() {
  find "$1" -type d -name '*.mxo' -prune | wc -l | tr -d ' '
}

assert_bundle_metadata() {
  local bundle="$1" expected actual
  expected="$(bundle_identifier "$bundle")"
  actual="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' \
    "$bundle/Contents/Info.plist" 2>/dev/null)" \
    || die "missing CFBundleIdentifier: $bundle"
  [[ "$actual" == "$expected" ]] \
    || die "CFBundleIdentifier mismatch for $bundle: expected $expected, got $actual"
}

assert_signature() {
  local bundle="$1" identity details identifier actual_identifier
  identity="$(expected_identity)"
  identifier="$(bundle_identifier "$bundle")"
  codesign --verify --deep --strict --verbose=2 "$bundle"
  details="$(codesign -dv --verbose=4 "$bundle" 2>&1)"
  grep -Fq "Authority=${identity}" <<<"$details" \
    || die "unexpected signing authority: $bundle"
  grep -Fq "TeamIdentifier=${APPLE_TEAM_ID}" <<<"$details" \
    || die "unexpected TeamIdentifier: $bundle"
  actual_identifier="$(sed -n 's/^Identifier=//p' <<<"$details")"
  [[ "$actual_identifier" == "$identifier" ]] \
    || die "signing identifier mismatch for $bundle: expected $identifier, got $actual_identifier"
}

verify_tree() {
  local root="$1" count bundle
  count="$(mxo_count "$root")"
  [[ "$count" -gt 0 ]] || die "no .mxo bundles found under: $root"
  while IFS= read -r -d '' bundle; do
    assert_bundle_metadata "$bundle"
    assert_signature "$bundle"
  done < <(find "$root" -type d -name '*.mxo' -prune -print0)
  printf 'verified %s signed Max external bundle(s)\n' "$count"
}

sign_tree() {
  require_macos
  require_env MACOS_CERTIFICATE_P12_BASE64 MACOS_CERTIFICATE_PASSWORD APPLE_TEAM_ID RUNNER_TEMP

  local root="$1" identity cert_path keychain_path keychain_password count bundle candidate
  root="$(cd "$root" && pwd)"
  count="$(mxo_count "$root")"
  [[ "$count" -gt 0 ]] || die "no .mxo bundles found under: $root"

  identity="$(expected_identity)"
  cert_path="$RUNNER_TEMP/developer-id-application.p12"
  keychain_path="$RUNNER_TEMP/release-signing.keychain-db"
  keychain_password="$(uuidgen)$(uuidgen)"

  cleanup_signing() {
    security delete-keychain "$keychain_path" >/dev/null 2>&1 || true
    rm -f "$cert_path"
  }
  trap cleanup_signing RETURN

  printf '%s' "$MACOS_CERTIFICATE_P12_BASE64" | base64 --decode > "$cert_path"
  chmod 600 "$cert_path"
  security create-keychain -p "$keychain_password" "$keychain_path"
  security set-keychain-settings -lut 21600 "$keychain_path"
  security unlock-keychain -p "$keychain_password" "$keychain_path"
  security import "$cert_path" -P "$MACOS_CERTIFICATE_PASSWORD" \
    -t cert -f pkcs12 -k "$keychain_path" -T /usr/bin/codesign -T /usr/bin/security
  security set-key-partition-list -S apple-tool:,apple:,codesign: \
    -s -k "$keychain_password" "$keychain_path"
  security list-keychains -d user -s "$keychain_path"
  security find-identity -v -p codesigning "$keychain_path" \
    | grep -Fq "\"${identity}\"" \
    || die "expected Developer ID identity is absent: ${identity}"

  while IFS= read -r -d '' bundle; do
    assert_bundle_metadata "$bundle"
    while IFS= read -r -d '' candidate; do
      if file -b "$candidate" | grep -q 'Mach-O'; then
        chmod 755 "$candidate"
        codesign --force --options runtime --timestamp \
          --keychain "$keychain_path" --sign "$identity" "$candidate"
      fi
    done < <(find "$bundle/Contents" -type f -print0)
    codesign --force --options runtime --timestamp \
      --identifier "$(bundle_identifier "$bundle")" \
      --keychain "$keychain_path" --sign "$identity" "$bundle"
    assert_signature "$bundle"
  done < <(find "$root" -type d -name '*.mxo' -prune -print0)

  printf 'signed %s Max external bundle(s) as %s\n' "$count" "$identity"
}

archive_tree() {
  require_macos
  local source="$1" archive="$2"
  [[ -d "$source" ]] || die "archive source does not exist: $source"
  mkdir -p "$(dirname "$archive")"
  rm -f "$archive"
  ditto -c -k --keepParent "$source" "$archive"
  [[ -s "$archive" ]] || die "archive was not created: $archive"
}

extract_archive() {
  require_macos
  local archive="$1" destination="$2"
  [[ -f "$archive" ]] || die "archive does not exist: $archive"
  mkdir -p "$destination"
  ditto -x -k "$archive" "$destination"
}

write_checksum() {
  local archive="$1" directory filename
  directory="$(cd "$(dirname "$archive")" && pwd)"
  filename="$(basename "$archive")"
  (cd "$directory" && shasum -a 256 "$filename" > "${filename}.sha256")
}

notarize_and_verify() {
  require_macos
  require_env APPLE_TEAM_ID APPLE_API_KEY_ID APPLE_API_ISSUER_ID \
    APPLE_API_PRIVATE_KEY_P8_BASE64 RUNNER_TEMP

  local archive="$1" package_root="$2" key_path response_path log_path status submission_id check_dir
  [[ -f "$archive" ]] || die "archive does not exist: $archive"
  key_path="$RUNNER_TEMP/AuthKey_${APPLE_API_KEY_ID}.p8"
  response_path="$RUNNER_TEMP/notary-response.json"
  log_path="$RUNNER_TEMP/notary-log.json"
  check_dir="$(mktemp -d "$RUNNER_TEMP/release-check.XXXXXX")"

  cleanup_notarization() {
    rm -f "$key_path" "$response_path"
    rm -rf "$check_dir"
  }
  trap cleanup_notarization RETURN

  printf '%s' "$APPLE_API_PRIVATE_KEY_P8_BASE64" | base64 --decode > "$key_path"
  chmod 600 "$key_path"
  xcrun notarytool submit "$archive" \
    --key "$key_path" \
    --key-id "$APPLE_API_KEY_ID" \
    --issuer "$APPLE_API_ISSUER_ID" \
    --wait --timeout 30m --output-format json > "$response_path"

  status="$(plutil -extract status raw -o - "$response_path")"
  submission_id="$(plutil -extract id raw -o - "$response_path")"
  if [[ "$status" != "Accepted" ]]; then
    xcrun notarytool log "$submission_id" "$log_path" \
      --key "$key_path" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER_ID" || true
    [[ -f "$log_path" ]] && cat "$log_path" >&2
    die "notarization was not accepted (status: $status, id: $submission_id)"
  fi

  extract_archive "$archive" "$check_dir"
  [[ -d "$check_dir/$package_root" ]] \
    || die "expected package root is missing from final archive: $package_root"
  verify_tree "$check_dir/$package_root"
  write_checksum "$archive"
  printf 'notarization accepted: %s\n' "$submission_id"
}

self_test() {
  [[ "$(sanitize_identifier_component 'BBB.Noise~')" == 'bbb.noise' ]] \
    || die "identifier sanitizer failed for tilde suffix"
  [[ "$(sanitize_identifier_component ' bbb.agent.chat ')" == 'bbb.agent.chat' ]] \
    || die "identifier sanitizer failed for surrounding whitespace"
  APPLE_TEAM_ID=ABCDE12345
  [[ "$(expected_identity)" == \
    'Developer ID Application: ISHII 2BIT PROGRAM OFFICE (ABCDE12345)' ]] \
    || die "expected identity construction failed"
  printf 'self-test passed\n'
}

usage() {
  cat >&2 <<'USAGE'
Usage:
  macos-direct-distribution.sh sign <externals-dir>
  macos-direct-distribution.sh archive <source-dir> <archive.zip>
  macos-direct-distribution.sh extract <archive.zip> <destination-dir>
  macos-direct-distribution.sh notarize-and-verify <release.zip> <package-root>
  macos-direct-distribution.sh checksum <archive.zip>
  macos-direct-distribution.sh self-test
USAGE
  exit 2
}

command_name="${1:-}"
case "$command_name" in
  sign)
    [[ $# -eq 2 ]] || usage
    sign_tree "$2"
    ;;
  archive)
    [[ $# -eq 3 ]] || usage
    archive_tree "$2" "$3"
    ;;
  extract)
    [[ $# -eq 3 ]] || usage
    extract_archive "$2" "$3"
    ;;
  notarize-and-verify)
    [[ $# -eq 3 ]] || usage
    notarize_and_verify "$2" "$3"
    ;;
  checksum)
    [[ $# -eq 2 ]] || usage
    write_checksum "$2"
    ;;
  self-test)
    [[ $# -eq 1 ]] || usage
    self_test
    ;;
  *)
    usage
    ;;
esac
