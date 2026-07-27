// node --test port of openclaw-basecamp's vitest suite for
// sync-action-pin-comments.mjs. Zero dependencies, mirroring the script.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assertOnlyTokensChanged,
  chooseBestTag,
  collectRepoKeys,
  compareVersionTags,
  parseLsRemoteOutput,
  parsePinnedLine,
  planEdits,
  repoKeyFor,
  SyncError,
} from "./sync-action-pin-comments.mjs";

const SETUP_NODE_SHA = "820762786026740c76f36085b0efc47a31fe5020";
const CHECKOUT_SHA = "9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0";

// A real combined-comment line that Dependabot cannot rewrite.
const COMBINED_LINE =
  "      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v6.4.0 # zizmor: ignore[cache-poisoning] -- workflow only triggers on tag push and workflow_dispatch; cache is keyed by lockfile hash and default branch";
const COMBINED_ANNOTATION =
  " # zizmor: ignore[cache-poisoning] -- workflow only triggers on tag push and workflow_dispatch; cache is keyed by lockfile hash and default branch";

/** Build a tagIndex entry: repoKey -> Map(sha -> tags). */
function index(entries) {
  return new Map(Object.entries(entries).map(([repo, shas]) => [repo, new Map(Object.entries(shas))]));
}

/** Assert that every key in `expected` deep-equals the same key in `actual`. */
function assertMatchObject(actual, expected) {
  assert.ok(actual !== null && actual !== undefined, "expected an object, got null/undefined");
  for (const [key, value] of Object.entries(expected)) {
    assert.deepEqual(actual[key], value, `mismatch on ${key}`);
  }
}

describe("parsePinnedLine", () => {
  it("partitions a combined-comment line, preserving the annotation verbatim", () => {
    const parsed = parsePinnedLine(COMBINED_LINE);
    assert.deepEqual(parsed, {
      prefix: "      - uses: ",
      action: "actions/setup-node",
      sha: SETUP_NODE_SHA,
      leadIn: " # ",
      token: "v6.4.0",
      rest: COMBINED_ANNOTATION,
    });
  });

  it("parses plain pinned lines with and without list dashes", () => {
    assertMatchObject(parsePinnedLine(`        uses: actions/checkout@${CHECKOUT_SHA} # v7.0.0`), {
      action: "actions/checkout",
      token: "v7.0.0",
      rest: "",
    });
    assertMatchObject(parsePinnedLine(`      - uses: github/codeql-action/init@${CHECKOUT_SHA} # v3`), {
      action: "github/codeql-action/init",
      token: "v3",
    });
  });

  it("skips docker refs, local actions, non-SHA refs, and comment-less pins", () => {
    assert.equal(parsePinnedLine("      - uses: docker://alpine:3.20"), null);
    assert.equal(parsePinnedLine("      - uses: ./local/action"), null);
    assert.equal(parsePinnedLine("      - uses: actions/checkout@v7"), null);
    assert.equal(parsePinnedLine(`      - uses: actions/checkout@${CHECKOUT_SHA}`), null);
    assert.equal(parsePinnedLine("      - run: npm ci"), null);
  });
});

describe("repoKeyFor", () => {
  it("uses the first two path segments", () => {
    assert.equal(repoKeyFor("github/codeql-action/init"), "github/codeql-action");
    assert.equal(repoKeyFor("actions/checkout"), "actions/checkout");
  });

  it("rejects dot segments and single segments", () => {
    assert.equal(repoKeyFor("./local"), null);
    assert.equal(repoKeyFor("../escape"), null);
    assert.equal(repoKeyFor("bare"), null);
  });
});

describe("parseLsRemoteOutput", () => {
  it("indexes version tags by sha, preferring peeled annotated-tag targets", () => {
    const sha = CHECKOUT_SHA;
    const tagObject = "1111111111111111111111111111111111111111";
    const out = [
      `${tagObject}\trefs/tags/v7.0.0`,
      `${sha}\trefs/tags/v7.0.0^{}`,
      `${sha}\trefs/tags/v7`,
      `${sha}\trefs/tags/not-a-version`,
    ].join("\n");
    const map = parseLsRemoteOutput(out);
    assert.deepEqual([...map.get(sha)].sort(), ["v7", "v7.0.0"]);
    assert.equal(map.has(tagObject), false);
  });

  it("rejects malformed lines", () => {
    assert.throws(() => parseLsRemoteOutput("garbage output"), SyncError);
    assert.throws(() => parseLsRemoteOutput(`deadbeef\trefs/tags/v1`), SyncError);
    assert.throws(() => parseLsRemoteOutput(`${CHECKOUT_SHA} refs/tags/v1`), SyncError);
  });
});

describe("compareVersionTags / chooseBestTag", () => {
  it("prefers stable over prerelease", () => {
    assert.equal(chooseBestTag(["v7.0.0-rc.1", "v7.0.0"]), "v7.0.0");
    assert.equal(chooseBestTag(["v8.0.0-beta.1", "v7.0.0"]), "v7.0.0");
  });

  it("prefers more explicit segments among numerically equal tags", () => {
    assert.equal(chooseBestTag(["v7", "v7.0.0"]), "v7.0.0");
    assert.equal(chooseBestTag(["v7.0.0", "v7", "v7.0"]), "v7.0.0");
  });

  it("compares numerically, not lexically", () => {
    assert.equal(chooseBestTag(["v9", "v10"]), "v10");
    assert.equal(chooseBestTag(["v1.9.0", "v1.10.0"]), "v1.10.0");
  });

  it("orders prereleases per semver §11", () => {
    assert.ok(compareVersionTags("v1.0.0-alpha", "v1.0.0-alpha.1") < 0);
    assert.ok(compareVersionTags("v1.0.0-alpha.1", "v1.0.0-alpha.beta") < 0);
    assert.ok(compareVersionTags("v1.0.0-beta.2", "v1.0.0-beta.11") < 0);
    assert.ok(compareVersionTags("v1.0.0-rc.1", "v1.0.0-beta.11") > 0);
  });

  it("breaks exact ties deterministically and rejects non-version tags", () => {
    assert.equal(chooseBestTag(["v1.0.0", "1.0.0"]), "v1.0.0");
    assert.equal(compareVersionTags("v1.0.0", "v1.0.0"), 0);
    assert.throws(() => compareVersionTags("v1.0.0", "nope"), SyncError);
  });
});

describe("planEdits", () => {
  it("fixes the combined-comment line, preserving the zizmor annotation byte for byte", () => {
    const files = [{ path: ".github/workflows/release.yml", content: `${COMBINED_LINE}\n` }];
    const tagIndex = index({
      "actions/setup-node": { [SETUP_NODE_SHA]: ["v7.0.0", "v7"] },
    });
    const { edits, newContents } = planEdits(files, tagIndex);
    assert.equal(edits.length, 1);
    assertMatchObject(edits[0], { lineNo: 1, oldToken: "v6.4.0", newToken: "v7.0.0" });
    assert.equal(
      newContents.get(".github/workflows/release.yml"),
      `      - uses: actions/setup-node@${SETUP_NODE_SHA} # v7.0.0${COMBINED_ANNOTATION}\n`,
    );
  });

  it("updates plain stale comments and leaves correct or alias comments untouched", () => {
    const content = [
      `      - uses: actions/checkout@${CHECKOUT_SHA} # v6.9.9`, // stale
      `      - uses: actions/checkout@${CHECKOUT_SHA} # v7`, // alias tag pointing at the sha
      `      - uses: actions/setup-node@${SETUP_NODE_SHA} # v7.0.0`, // already correct
      "",
    ].join("\n");
    const files = [{ path: "ci.yml", content }];
    const tagIndex = index({
      "actions/checkout": { [CHECKOUT_SHA]: ["v7", "v7.0.0"] },
      "actions/setup-node": { [SETUP_NODE_SHA]: ["v7.0.0"] },
    });
    const { edits, newContents } = planEdits(files, tagIndex);
    assert.equal(edits.length, 1);
    assertMatchObject(edits[0], { lineNo: 1, oldToken: "v6.9.9", newToken: "v7.0.0" });
    assert.equal(
      newContents.get("ci.yml"),
      [
        `      - uses: actions/checkout@${CHECKOUT_SHA} # v7.0.0`,
        `      - uses: actions/checkout@${CHECKOUT_SHA} # v7`,
        `      - uses: actions/setup-node@${SETUP_NODE_SHA} # v7.0.0`,
        "",
      ].join("\n"),
    );
  });

  it("returns no edits when everything is in sync", () => {
    const files = [{ path: "ci.yml", content: `      - uses: actions/checkout@${CHECKOUT_SHA} # v7.0.0\n` }];
    const tagIndex = index({ "actions/checkout": { [CHECKOUT_SHA]: ["v7.0.0"] } });
    const { edits, newContents } = planEdits(files, tagIndex);
    assert.equal(edits.length, 0);
    assert.equal(newContents.size, 0);
  });

  it("aborts the whole run when a repo is unresolvable — no partial writes", () => {
    const content = [
      `      - uses: actions/checkout@${CHECKOUT_SHA} # v6.9.9`,
      `      - uses: actions/setup-node@${SETUP_NODE_SHA} # v6.4.0`,
      "",
    ].join("\n");
    const files = [{ path: "ci.yml", content }];
    const tagIndex = index({ "actions/checkout": { [CHECKOUT_SHA]: ["v7.0.0"] } }); // setup-node missing
    assert.throws(() => planEdits(files, tagIndex), /no tag data for actions\/setup-node/);
  });

  it("aborts when no version tag points at a pinned sha", () => {
    const files = [{ path: "ci.yml", content: `      - uses: actions/checkout@${CHECKOUT_SHA} # v6.9.9\n` }];
    const tagIndex = index({ "actions/checkout": { "0000000000000000000000000000000000000000": ["v7.0.0"] } });
    assert.throws(() => planEdits(files, tagIndex), /no version tag points at actions\/checkout@/);
  });
});

describe("assertOnlyTokensChanged", () => {
  const original = `      - uses: actions/checkout@${CHECKOUT_SHA} # v6.9.9\n`;
  const files = [{ path: "ci.yml", content: original }];

  it("passes for a pure token substitution", () => {
    const good = new Map([["ci.yml", `      - uses: actions/checkout@${CHECKOUT_SHA} # v7.0.0\n`]]);
    assert.doesNotThrow(() => assertOnlyTokensChanged(files, good));
  });

  it("trips on any change outside the version token", () => {
    const shaChanged = new Map([
      ["ci.yml", `      - uses: actions/checkout@0000000000000000000000000000000000000000 # v7.0.0\n`],
    ]);
    assert.throws(() => assertOnlyTokensChanged(files, shaChanged), /not confined to the version token/);

    const annotationDropped = new Map([["ci.yml", "      - run: echo hijacked\n"]]);
    assert.throws(() => assertOnlyTokensChanged(files, annotationDropped), /not confined to the version token/);

    const lineCount = new Map([["ci.yml", `${original}extra: line\n`]]);
    assert.throws(() => assertOnlyTokensChanged(files, lineCount), /line count changed/);
  });
});

describe("collectRepoKeys", () => {
  it("collects unique sorted owner/repo keys across files", () => {
    const files = [
      { path: "a.yml", content: `uses: actions/setup-node@${SETUP_NODE_SHA} # v6\nuses: docker://alpine:3.20\n` },
      {
        path: "b.yml",
        content: `uses: actions/checkout@${CHECKOUT_SHA} # v7\nuses: github/codeql-action/init@${CHECKOUT_SHA} # v3\n`,
      },
    ];
    assert.deepEqual(collectRepoKeys(files), ["actions/checkout", "actions/setup-node", "github/codeql-action"]);
  });
});
