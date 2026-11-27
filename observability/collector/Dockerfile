FROM ghcr.io/open-telemetry/opentelemetry-collector-releases/opentelemetry-collector-contrib:0.136.0 AS dist
# The upstream scratch image has no HTTP client for a readiness probe.
FROM alpine:3.22@sha256:49340b346798875b5592e5d420241f2f9cfba5f47e62ebb1446a1b34734e898f
COPY --from=dist /otelcol-contrib /otelcol-contrib
USER 10001:10001
ENTRYPOINT ["/otelcol-contrib"]
