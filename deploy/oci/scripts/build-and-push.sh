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
platform="${FIRSTTRACE_CONTAINER_PLATFORM:-}"
dockerfile="${FIRSTTRACE_DOCKERFILE:-Dockerfile}"
platform_args=()
build_args=()
container_runtime="${CONTAINER_RUNTIME:-docker}"

if [[ -n "${platform}" ]]; then
  platform_args+=(--platform "${platform}")
fi

if [[ -n "${FIRSTTRACE_PACKAGE_SPEC:-}" ]]; then
  build_args+=(--build-arg "FIRSTTRACE_PACKAGE_SPEC=${FIRSTTRACE_PACKAGE_SPEC}")
fi

if [[ -n "${FIRSTTRACE_CONFIG_FILE:-}" ]]; then
  build_args+=(--build-arg "FIRSTTRACE_CONFIG_FILE=${FIRSTTRACE_CONFIG_FILE}")
fi

if [[ -n "${FIRSTTRACE_CONFIG_DEST:-}" ]]; then
  build_args+=(--build-arg "FIRSTTRACE_CONFIG_DEST=${FIRSTTRACE_CONFIG_DEST}")
fi

if [[ -n "${FIRSTTRACE_BUILD_REF:-}" ]]; then
  build_args+=(--build-arg "FIRSTTRACE_BUILD_REF=${FIRSTTRACE_BUILD_REF}")
fi

if [[ "${container_runtime}" == "docker" ]] && docker buildx build --help 2>/dev/null | grep -q -- "--push"; then
  docker buildx build "${platform_args[@]}" -f "${dockerfile}" "${build_args[@]}" -t "${image}" --push .
else
  "${container_runtime}" build "${platform_args[@]}" -f "${dockerfile}" "${build_args[@]}" -t "${image}" .
  "${container_runtime}" push "${image}"
fi

echo "${image}"
