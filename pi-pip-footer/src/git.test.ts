import { describe, expect, it } from "vitest";
import { parseGitStatus } from "./git.ts";

describe("pi-pip-footer git", () => {
  it("parses git status", () => {
    const git = parseGitStatus("# branch.head main\n# branch.ab +2 -1\n1 .M N... 100644 100644 100644 a b file.ts");
    expect(git).toEqual({ branch: "main", dirty: true, ahead: 2, behind: 1 });
  });
});
