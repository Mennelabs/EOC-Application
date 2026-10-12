# Local development key service (ADR-0009). File storage on a Docker volume.
# TLS is off because the listener is reachable only on the private compose
# network; the cloud uses the provider's KMS instead of this container.
storage "file" {
  path = "/openbao/file"
}
listener "tcp" {
  address     = "0.0.0.0:8200"
  tls_disable = true
}
ui            = false
api_addr      = "http://keys:8200"
