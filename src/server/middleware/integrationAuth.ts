import { timingSafeEqual } from "node:crypto";

import type { RequestHandler } from "express";

import { getIntegrationApiKeys, isIntegrationAuthEnabled } from "../config/integration.js";

function extractProvidedKey(authorizationHeader: string | undefined, apiKeyHeader: string | undefined) {
  if (apiKeyHeader?.trim()) {
    return apiKeyHeader.trim();
  }

  if (!authorizationHeader?.trim()) {
    return null;
  }

  const normalized = authorizationHeader.trim();
  if (!normalized.toLowerCase().startsWith("bearer ")) {
    return null;
  }

  return normalized.slice(7).trim() || null;
}

function safeEquals(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}

export const integrationAuthMiddleware: RequestHandler = (req, res, next) => {
  if (!isIntegrationAuthEnabled()) {
    next();
    return;
  }

  const providedKey = extractProvidedKey(req.header("authorization"), req.header("x-api-key"));
  if (!providedKey) {
    res.status(401).json({ error: "Integration API key required" });
    return;
  }

  const authorized = getIntegrationApiKeys().some((configuredKey) => safeEquals(configuredKey, providedKey));
  if (!authorized) {
    res.status(401).json({ error: "Invalid integration API key" });
    return;
  }

  next();
};