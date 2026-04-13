function normalizeRoutePrefix(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return "/api/v1/integration";
  }

  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withLeadingSlash.replace(/\/+$/, "") || "/api/v1/integration";
}

export function getIntegrationRoutePrefix() {
  return normalizeRoutePrefix(process.env.INTEGRATION_BASE_PATH ?? "/api/v1/integration");
}

export function getIntegrationApiKeys() {
  return (process.env.INTEGRATION_API_KEYS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export function isIntegrationAuthEnabled() {
  return getIntegrationApiKeys().length > 0;
}