#!/usr/bin/env bash

set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <package-directory>" >&2
  exit 2
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
package_dir="$1"

if [[ ! -d "$package_dir" ]]; then
  echo "package directory does not exist: $package_dir" >&2
  exit 1
fi
package_dir="$(cd "$package_dir" && pwd)"
if [[ "$package_dir" == "$repo_root" || "$package_dir" == "/" ]]; then
  echo "refusing unsafe package directory: $package_dir" >&2
  exit 1
fi

if [[ ! -d "$package_dir/externals/maxforge.sync.mxo" ]]; then
  echo "missing macOS external: $package_dir/externals/maxforge.sync.mxo" >&2
  exit 1
fi
if [[ ! -f "$package_dir/externals/maxforge.sync.mxe64" ]]; then
  echo "missing Windows external: $package_dir/externals/maxforge.sync.mxe64" >&2
  exit 1
fi

for file in package-info.json README.md LICENSE; do
  if [[ ! -f "$repo_root/$file" ]]; then
    echo "missing required package source: $file" >&2
    exit 1
  fi
  cp "$repo_root/$file" "$package_dir/"
done

for directory in help docs examples; do
  if [[ ! -d "$repo_root/$directory" ]]; then
    echo "missing required package source directory: $directory" >&2
    exit 1
  fi
  rm -rf "$package_dir/$directory"
  cp -R "$repo_root/$directory" "$package_dir/"
done

find "$package_dir/externals" -path '*/Contents/MacOS/*' -type f -exec chmod 755 {} +
