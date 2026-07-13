import { execFileSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import { performNpmUpdateEdge } from "../src/daemon/auto-update.js";
import { _autoUpdateIo } from "../src/daemon/manifest.js";

describe("Edge auto-update restart-entry self-check (real child processes)", () => {
  const originalEdgeRestartCommand = _autoUpdateIo.edgeRestartCommand;
  const originalEnv = {
    DKG_HOME: process.env.DKG_HOME,
    PATH: process.env.PATH,
    FAKE_DKG_VERSION_FILE: process.env.FAKE_DKG_VERSION_FILE,
  };
  let root: string | undefined;

  afterEach(async () => {
    _autoUpdateIo.edgeRestartCommand = originalEdgeRestartCommand;
    for (const [name, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  it("rejects the restart entry's wrong version even when PATH's dkg reports the target", async () => {
    root = await mkdtemp(join(tmpdir(), "dkg-edge-entry-e2e-"));
    const binDir = join(root, "bin");
    const dkgHome = join(root, "home");
    const versionFile = join(root, "restart-entry-version");
    const restartEntry = join(root, "restart-entry.mjs");
    await mkdir(binDir, { recursive: true });
    await mkdir(dkgHome, { recursive: true });
    await writeFile(versionFile, "10.0.0-rc.0\n");

    const fakeNpm = join(binDir, "npm");
    await writeFile(
      fakeNpm,
      [
        "#!/bin/sh",
        'case "$*" in',
        '  *10.0.0-rc.1*) printf "%s\\n" "10.0.0-rc.12" >"$FAKE_DKG_VERSION_FILE" ;;',
        '  *10.0.0-rc.0*) printf "%s\\n" "10.0.0-rc.0" >"$FAKE_DKG_VERSION_FILE" ;;',
        "  *) exit 2 ;;",
        "esac",
      ].join("\n"),
    );
    const pathDkg = join(binDir, "dkg");
    await writeFile(pathDkg, '#!/bin/sh\nprintf "%s\\n" "dkg 10.0.0-rc.1"\n');
    await chmod(fakeNpm, 0o755);
    await chmod(pathDkg, 0o755);
    await writeFile(
      restartEntry,
      [
        "import { readFileSync } from 'node:fs';",
        "const version = readFileSync(process.env.FAKE_DKG_VERSION_FILE, 'utf8').trim();",
        "process.stdout.write(`dkg ${version}\\n`);",
      ].join("\n"),
    );

    process.env.DKG_HOME = dkgHome;
    process.env.FAKE_DKG_VERSION_FILE = versionFile;
    process.env.PATH = `${binDir}${delimiter}${originalEnv.PATH ?? ""}`;
    expect(
      execFileSync(pathDkg, ["--version"], { encoding: "utf8" }).trim(),
    ).toBe("dkg 10.0.0-rc.1");
    _autoUpdateIo.edgeRestartCommand = () => ({
      nodeExecutable: process.execPath,
      nodeExecArgv: [],
      restartEntryPoint: restartEntry,
    });

    const logs: string[] = [];
    const result = await performNpmUpdateEdge(
      "10.0.0-rc.1",
      "10.0.0-rc.0",
      (message) => logs.push(message),
    );

    expect(result).toBe("failed");
    expect(await readFile(versionFile, "utf8")).toBe("10.0.0-rc.0\n");
    expect(await readFile(join(dkgHome, "previous-version"), "utf8")).toBe(
      "10.0.0-rc.0",
    );
    expect(
      logs.some((message) =>
        message.includes("expected 10.0.0-rc.1, got 10.0.0-rc.12"),
      ),
    ).toBe(true);
    expect(
      logs.some((message) =>
        message.includes("rollback restored dkg 10.0.0-rc.0"),
      ),
    ).toBe(true);
  });
});
