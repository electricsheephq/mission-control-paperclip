import { afterEach, describe, expect, it, vi } from "vitest";
import { ghFetch, gitHubApiBase, resolveRawGitHubUrl } from "../services/github-fetch.js";

describe("github-fetch", () => {
  const previousEnterpriseHosts = process.env.PAPERCLIP_GITHUB_ENTERPRISE_HOSTS;

  afterEach(() => {
    vi.unstubAllGlobals();
    if (previousEnterpriseHosts === undefined) {
      delete process.env.PAPERCLIP_GITHUB_ENTERPRISE_HOSTS;
    } else {
      process.env.PAPERCLIP_GITHUB_ENTERPRISE_HOSTS = previousEnterpriseHosts;
    }
  });

  it("rejects arbitrary dotted HTTPS hosts unless explicitly allowlisted", async () => {
    await expect(ghFetch("https://example.com/api/v3/repos/acme/repo")).rejects.toThrow(
      /GitHub Enterprise host is not allowlisted/,
    );
  });

  it("allows github.com and configured GitHub Enterprise hosts only", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    process.env.PAPERCLIP_GITHUB_ENTERPRISE_HOSTS = "ghe.example.com";

    expect(gitHubApiBase("github.com")).toBe("https://api.github.com");
    expect(gitHubApiBase("ghe.example.com")).toBe("https://ghe.example.com/api/v3");
    expect(resolveRawGitHubUrl("github.com", "acme", "repo", "main", "/skills/paperclip/SKILL.md"))
      .toBe("https://raw.githubusercontent.com/acme/repo/main/skills/paperclip/SKILL.md");
    expect(resolveRawGitHubUrl("ghe.example.com", "acme", "repo", "main", "/skills/paperclip/SKILL.md"))
      .toBe("https://ghe.example.com/raw/acme/repo/main/skills/paperclip/SKILL.md");

    await ghFetch("https://raw.githubusercontent.com/acme/repo/main/README.md");
    await ghFetch("https://ghe.example.com/api/v3/repos/acme/repo");
    expect(fetchMock).toHaveBeenCalledWith("https://raw.githubusercontent.com/acme/repo/main/README.md", undefined);
    expect(fetchMock).toHaveBeenCalledWith("https://ghe.example.com/api/v3/repos/acme/repo", undefined);
  });

  it("rejects local, IP, and non-HTTPS URLs before fetch", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(ghFetch("http://github.com/acme/repo")).rejects.toThrow(/must use HTTPS/);
    await expect(ghFetch("https://127.0.0.1/api/v3/repos/acme/repo")).rejects.toThrow(/GitHub URL/);
    await expect(ghFetch("https://localhost/api/v3/repos/acme/repo")).rejects.toThrow(/GitHub URL/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
