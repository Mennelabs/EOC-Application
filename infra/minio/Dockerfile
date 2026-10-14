# syntax=docker/dockerfile:1
# MinIO stopped publishing community container images in 2025, so the LOCAL
# S3 stand-in is built from its pinned source release (ADR-0010). Production
# uses the cloud provider's S3, not this image.
FROM golang:1.24-alpine AS build
ARG MINIO_RELEASE=RELEASE.2025-04-22T22-12-26Z
ENV CGO_ENABLED=0 GOFLAGS=-mod=mod
# Checksums stay verified (sum.golang.org); a dropped connection to it is retried
# with backoff instead of failing the build, and the module cache carries over.
RUN for attempt in 1 2 3 4; do \
      go install github.com/minio/minio@${MINIO_RELEASE} && exit 0; \
      echo "go install failed (attempt $attempt of 4); retrying" >&2; sleep $((attempt * 15)); \
    done; exit 1

FROM alpine:3.22
RUN apk add --no-cache ca-certificates curl \
 && adduser -D -u 1000 minio && mkdir -p /data && chown minio /data
COPY --from=build /go/bin/minio /usr/local/bin/minio
USER minio
EXPOSE 9000
ENTRYPOINT ["minio"]
CMD ["server", "/data", "--address", ":9000", "--console-address", ":9001"]
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD curl -fsS http://127.0.0.1:9000/minio/health/ready || exit 1
