export interface SiteFetchRewrite {
  url: string;
  handler: string;
  reason: string;
}

export function rewriteGitHubUrl(url: URL): SiteFetchRewrite | undefined {
  if (url.hostname !== "github.com") return undefined;
  const parts = url.pathname.split("/").filter(Boolean);
  const [owner, repo, kind, ...rest] = parts;
  if (!owner || !repo) return undefined;

  if (kind === "blob" && rest.length >= 2) {
    const [branch, ...pathParts] = rest;
    return {
      url: `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${pathParts.join("/")}`,
      handler: "github-raw-blob",
      reason: "GitHub blob URL rewritten to raw file content",
    };
  }

  if (!kind || kind === "tree") {
    const branch = kind === "tree" && rest[0] ? rest[0] : "HEAD";
    return {
      url: `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/README.md`,
      handler: "github-readme",
      reason: "GitHub repository URL rewritten to raw README.md",
    };
  }

  return undefined;
}
