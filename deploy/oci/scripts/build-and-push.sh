#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 3 ]]; then
  echo "Usage: $0 <region-key> <namespace> <repository> [tag]" >&2
  echo "Example: $0 iad mytenancynamespace firsttrace latest" >&2
  exit 64
fi

region_key="$1"
namespace="$2"
repository="$3"
tag="${4:-latest}"
image="${region_key}.ocir.io/${namespace}/${repository}:${tag}"
platform="${FIRSTTRACE_CONTAINER_PLATFORM:-linux/amd64}"

if docker buildx version >/dev/null 2>&1; then
  docker buildx build --platform "${platform}" -t "${image}" --push .
else
  docker build --platform "${platform}" -t "${image}" .
  docker push "${image}"
fi

echo "${image}"
