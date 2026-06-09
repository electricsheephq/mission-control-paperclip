import { isIP } from "node:net";
import { unprocessable } from "../errors.js";

function isGitHubDotCom(hostname: string) {
  const h = hostname.toLowerCase();
  return h === "github.com" ||
    h === "www.github.com" ||
    h === "api.github.com" ||
    h === "raw.githubusercontent.com";
}

function configuredGitHubEnterpriseHosts() {
  return new Set(
    (process.env.PAPERCLIP_GITHUB_ENTERPRISE_HOSTS ?? "")
      .split(",")
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
  );
}

function safeGitHubHostname(hostname: string) {
  const normalized = hostname.trim().toLowerCase();
  if (!normalized) {
    throw unprocessable("GitHub hostname is required.");
  }
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    isIP(normalized) !== 0
  ) {
    throw unprocessable("GitHub URL must use github.com or a valid HTTPS GitHub Enterprise hostname.");
  }
  if (!isGitHubDotCom(normalized) && !configuredGitHubEnterpriseHosts().has(normalized)) {
    throw unprocessable(
      "GitHub Enterprise host is not allowlisted. Set PAPERCLIP_GITHUB_ENTERPRISE_HOSTS to allow it.",
    );
  }
  return normalized;
}

function trimLeadingSlashes(value: string) {
  let start = 0;
  while (start < value.length && value[start] === "/") start += 1;
  return value.slice(start);
}

export function gitHubApiBase(hostname: string) {
  const safeHostname = safeGitHubHostname(hostname);
  return isGitHubDotCom(safeHostname) ? "https://api.github.com" : `https://${safeHostname}/api/v3`;
}

export function resolveRawGitHubUrl(hostname: string, owner: string, repo: string, ref: string, filePath: string) {
  const safeHostname = safeGitHubHostname(hostname);
  const p = trimLeadingSlashes(filePath);
  return isGitHubDotCom(safeHostname)
    ? `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${p}`
    : `https://${safeHostname}/raw/${owner}/${repo}/${ref}/${p}`;
}

export async function ghFetch(url: string, init?: RequestInit): Promise<Response> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") {
    throw unprocessable("GitHub fetches must use HTTPS.");
  }
  safeGitHubHostname(parsed.hostname);
  try {
    // ghFetch rejects non-HTTPS, loopback, IP, local, and single-label non-GitHub hosts before dispatch.
    // codeql[js/request-forgery]
    return await fetch(parsed.toString(), init);
  } catch {
    throw unprocessable(`Could not connect to ${parsed.hostname} — ensure the URL points to a GitHub or GitHub Enterprise instance`);
  }
}
