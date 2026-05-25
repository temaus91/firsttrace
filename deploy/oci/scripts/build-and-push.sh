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
dockerfile="${FIRSTTRACE_DOCKERFILE:-Dockerfile}"
build_args=()

if [[ -n "${FIRSTTRACE_PACKAGE_TARBALL:-}" ]]; then
  build_args+=(--build-arg "FIRSTTRACE_PACKAGE_TARBALL=${FIRSTTRACE_PACKAGE_TARBALL}")
fi

if [[ -n "${FIRSTTRACE_CONFIG_FILE:-}" ]]; then
  build_args+=(--build-arg "FIRSTTRACE_CONFIG_FILE=${FIRSTTRACE_CONFIG_FILE}")
fi

if [[ -n "${FIRSTTRACE_CONFIG_DEST:-}" ]]; then
  build_args+=(--build-arg "FIRSTTRACE_CONFIG_DEST=${FIRSTTRACE_CONFIG_DEST}")
fi

if docker buildx build --help 2>/dev/null | grep -q -- "--push"; then
  docker buildx build --platform "${platform}" -f "${dockerfile}" "${build_args[@]}" -t "${image}" --push .
else
  docker build --platform "${platform}" -f "${dockerfile}" "${build_args[@]}" -t "${image}" .
  docker push "${image}"
fi

echo "${image}"
