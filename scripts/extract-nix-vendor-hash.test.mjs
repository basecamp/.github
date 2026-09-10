// node --test fixtures for extract-nix-vendor-hash.sh: every guard in the
// script's header has a log here that only that guard rejects.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

const SCRIPT = new URL("./extract-nix-vendor-hash.sh", import.meta.url).pathname;

const VENDOR_HASH = "sha256-epvdZN17f1Ui3khPEUz1L6sQncs1FWlcg/IZlVbTtaI=";
const OTHER_HASH = "sha256-wa0/kiCrQ/7SbRDx4YEzIoGpWmMiUOOQYDynoL3wWvE=";

// The go-modules mismatch as Nix prints it (basecamp-cli #700's job log).
const GO_MODULES_MISMATCH = [
  "building '/nix/store/kghm9bfkv37amlpxrw549zprrwapl62i-basecamp-0.11.0-go-modules.drv'...",
  "error: hash mismatch in fixed-output derivation '/nix/store/kghm9bfkv37amlpxrw549zprrwapl62i-basecamp-0.11.0-go-modules.drv':",
  "         specified: sha256-MdVsRrJ3SEEtFFU6X2gP5s414kEhulSkxLqoD9GxiIg=",
  `            got:    ${VENDOR_HASH}`,
  "error: Cannot build '/nix/store/szd0fwdn05x89csg3dh26irb4ciky9rk-basecamp-0.11.0.drv'.",
  "       Reason: 1 dependency failed.",
].join("\n");

// A second fixed-output derivation in the same flake: the Go source tarball
// hey-cli fetched while nixpkgs lagged go.mod.
const OTHER_MISMATCH = [
  "error: hash mismatch in fixed-output derivation '/nix/store/0p5b3w9c5fhz6z6x1r3q3r0c6l8x9v1m-go1.26.7.src.tar.gz.drv':",
  "         specified: sha256-4gpQp6AEEO64sxSC1gJa7EgYjcJEShqLQx1ktnU7aQY=",
  `            got:    ${OTHER_HASH}`,
].join("\n");

function extract(input, args = []) {
  const result = spawnSync("bash", [SCRIPT, ...args], { input, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("extract-nix-vendor-hash.sh", () => {
  it("returns the hash from a go-modules fixed-output mismatch", () => {
    const { status, stdout } = extract(GO_MODULES_MISMATCH);
    assert.equal(status, 0);
    assert.equal(stdout, `${VENDOR_HASH}\n`);
  });

  it("reads a log file argument as well as stdin", () => {
    const log = join(mkdtempSync(join(tmpdir(), "extract-nix-")), "build.log");
    writeFileSync(log, GO_MODULES_MISMATCH);
    const { status, stdout } = extract("", [log]);
    assert.equal(status, 0);
    assert.equal(stdout, `${VENDOR_HASH}\n`);
  });

  it("reports nothing for a build that succeeded", () => {
    const { status, stdout } = extract("building '/nix/store/abc-basecamp-0.11.0.drv'...\n");
    assert.equal(status, 1);
    assert.equal(stdout, "");
  });

  it("reports nothing for a failure whose log merely contains `got:`", () => {
    const log = [
      "--- FAIL: TestVendorHashParse (0.00s)",
      "    parse_test.go:12: want: 41, got: 42",
      "error: builder for '/nix/store/abc-basecamp-0.11.0.drv' failed with exit code 1",
    ].join("\n");
    const { status, stdout } = extract(log);
    assert.equal(status, 1);
    assert.equal(stdout, "");
  });

  it("ignores a fixed-output mismatch for a derivation other than go-modules", () => {
    const { status, stdout } = extract(OTHER_MISMATCH);
    assert.equal(status, 1);
    assert.equal(stdout, "");
  });

  it("takes the go-modules hash when another derivation's mismatch precedes it", () => {
    const { status, stdout } = extract(`${OTHER_MISMATCH}\n${GO_MODULES_MISMATCH}`);
    assert.equal(status, 0);
    assert.equal(stdout, `${VENDOR_HASH}\n`);
  });

  it("takes the go-modules hash when another derivation's mismatch follows it", () => {
    const { status, stdout } = extract(`${GO_MODULES_MISMATCH}\n${OTHER_MISMATCH}`);
    assert.equal(status, 0);
    assert.equal(stdout, `${VENDOR_HASH}\n`);
  });

  it("does not let a later mismatch supply a go-modules block that has no `got:`", () => {
    const truncated = GO_MODULES_MISMATCH.split("\n").filter((line) => !line.includes("got:")).join("\n");
    const { status, stdout } = extract(`${truncated}\n${OTHER_MISMATCH}`);
    assert.equal(status, 1);
    assert.equal(stdout, "");
  });

  for (const [name, value] of [
    ["truncated", VENDOR_HASH.slice(0, -2) + "="],
    ["unpadded", VENDOR_HASH.slice(0, -1)],
    ["overlong", VENDOR_HASH.slice(0, -1) + "AA="],
    ["not base64", "sha256-not_a_hash="],
    ["another algorithm", "sha512-" + VENDOR_HASH.slice(7)],
  ]) {
    it(`rejects a malformed SRI value (${name})`, () => {
      const log = GO_MODULES_MISMATCH.replace(VENDOR_HASH, value);
      const { status, stdout } = extract(log);
      assert.equal(status, 1, `${value} must not be reported as a hash`);
      assert.equal(stdout, "");
    });
  }
});
