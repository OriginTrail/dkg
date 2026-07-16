import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const DEVNET_DIR = join(REPO_ROOT, ".devnet");
const DEVNET_SH = join(REPO_ROOT, "scripts/devnet.sh");
const RESULT_DIR = join(DEVNET_DIR, "chat-access-matrix-results");
const RUN_ID = `chat-access-${Date.now()}`;

interface NodeInfo {
  num: number;
  apiPort: number;
  listenPort: number;
  home: string;
  token: string;
  peerId: string;
}

interface MatrixRow {
  id: string;
  senderNode: number;
  senderPeerId: string;
  receiverNode: number;
  receiverPeerId: string;
  trustBasis: string;
  contextGraphId?: string;
  textBytes: number;
  expected: "allow" | "deny";
  delivered: boolean;
  receiverStored: boolean;
  error?: string;
  httpAttempts: number;
  enforcementLayer: "application-acl" | "libp2p-transport";
  pass: boolean;
}

interface MatrixArtifact {
  runId: string;
  startedAt: string;
  finishedAt?: string;
  trustedContextGraphId?: string;
  untrustedContextGraphId?: string;
  policy: Record<string, unknown>;
  nodes: Array<Pick<NodeInfo, "num" | "apiPort" | "listenPort" | "peerId">>;
  rows: MatrixRow[];
  passed?: boolean;
}

function readToken(home: string): string {
  return (
    readFileSync(join(home, "auth.token"), "utf8")
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith("#")) ?? ""
  );
}

function authHeaders(node: NodeInfo): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...(node.token ? { Authorization: `Bearer ${node.token}` } : {}),
  };
}

async function apiJson(
  node: NodeInfo,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: any }> {
  const response = await fetch(`http://127.0.0.1:${node.apiPort}${path}`, {
    ...init,
    headers: { ...authHeaders(node), ...(init.headers ?? {}) },
  });
  const raw = await response.text();
  let body: any = raw;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    /* retain text */
  }
  return { status: response.status, body };
}

async function waitForApi(node: NodeInfo, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "not attempted";
  while (Date.now() < deadline) {
    try {
      const response = await apiJson(node, "/api/status");
      if (response.status === 200) return;
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 500));
  }
  throw new Error(
    `node${node.num} API did not recover within ${timeoutMs}ms: ${last}`,
  );
}

async function ensureConnected(
  sender: NodeInfo,
  receiver: NodeInfo,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  let last = "not attempted";
  while (Date.now() < deadline) {
    try {
      const response = await apiJson(sender, "/api/connect", {
        method: "POST",
        body: JSON.stringify({ peerId: receiver.peerId }),
      });
      if (response.status === 200 && response.body?.connected === true) return;
      last = `HTTP ${response.status} ${JSON.stringify(response.body)}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 750));
  }
  throw new Error(
    `node${sender.num} could not establish transport to node${receiver.num}: ${last}`,
  );
}

async function loadNode(num: number): Promise<NodeInfo> {
  const home = join(DEVNET_DIR, `node${num}`);
  const config = JSON.parse(
    readFileSync(join(home, "config.json"), "utf8"),
  ) as {
    apiPort: number;
    listenPort: number;
  };
  const node: NodeInfo = {
    num,
    apiPort: config.apiPort,
    listenPort: config.listenPort,
    home,
    token: readToken(home),
    peerId: "",
  };
  const status = await apiJson(node, "/api/status");
  if (status.status !== 200 || typeof status.body?.peerId !== "string") {
    throw new Error(
      `node${num} has no usable /api/status peerId: ${JSON.stringify(status.body)}`,
    );
  }
  node.peerId = status.body.peerId;
  return node;
}

function patchConfig(node: NodeInfo, mutate: (config: any) => void): void {
  const path = join(node.home, "config.json");
  const config = JSON.parse(readFileSync(path, "utf8"));
  mutate(config);
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}

function restartNode(node: NodeInfo, node1: NodeInfo): void {
  const node1Config = JSON.parse(
    readFileSync(join(node1.home, "config.json"), "utf8"),
  );
  const rpcPort = new URL(node1Config.chain.rpcUrl).port || "8545";
  execFileSync(DEVNET_SH, ["restart-node", String(node.num)], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DKG_NO_BLUE_GREEN: "1",
      HARDHAT_PORT: rpcPort,
      API_PORT_BASE: String(node1.apiPort),
      LIBP2P_PORT_BASE: String(node1.listenPort),
    },
    stdio: "pipe",
    timeout: 90_000,
  });
}

async function createCg(
  curator: NodeInfo,
  id: string,
  allowedPeers: string[],
): Promise<void> {
  const response = await apiJson(curator, "/api/context-graph/create", {
    method: "POST",
    body: JSON.stringify({ id, name: id, accessPolicy: 1, allowedPeers }),
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      `create CG ${id} failed: HTTP ${response.status} ${JSON.stringify(response.body)}`,
    );
  }
}

async function receiverStored(
  receiver: NodeInfo,
  senderPeerId: string,
  text: string,
): Promise<boolean> {
  const response = await apiJson(
    receiver,
    `/api/messages?direction=in&peer=${encodeURIComponent(senderPeerId)}&limit=200`,
  );
  return (
    response.status === 200 &&
    Array.isArray(response.body?.messages) &&
    response.body.messages.some((message: any) => message.text === text)
  );
}

async function waitForStored(
  receiver: NodeInfo,
  senderPeerId: string,
  text: string,
  expected: boolean,
): Promise<boolean> {
  if (!expected) {
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 500));
    return receiverStored(receiver, senderPeerId, text);
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await receiverStored(receiver, senderPeerId, text)) return true;
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 250));
  }
  return false;
}

function writeArtifact(artifact: MatrixArtifact): string {
  mkdirSync(RESULT_DIR, { recursive: true });
  const path = join(RESULT_DIR, `${artifact.runId}.json`);
  writeFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`);
  return path;
}

describe("secure chat six-machine access matrix", () => {
  it("proves trusted machine, trusted CG, default-off, deny, size, rate, and loopback boundaries", async () => {
    const nodes = await Promise.all([1, 2, 3, 4, 5, 6].map(loadNode));
    const [node1, node2, node3, node4, node5, node6] = nodes;
    const trustedCg = `${RUN_ID}-trusted`;
    const untrustedCg = `${RUN_ID}-untrusted`;
    const rows: MatrixRow[] = [];
    const artifact: MatrixArtifact = {
      runId: RUN_ID,
      startedAt: new Date().toISOString(),
      trustedContextGraphId: trustedCg,
      untrustedContextGraphId: untrustedCg,
      policy: {
        receiverNode1: {
          enabled: true,
          mode: "trusted",
          peerAllowlist: [node2.peerId],
          trustedContextGraphIds: [trustedCg],
          limits: { maxTextBytes: 64, maxMessagesPerMinute: 3 },
        },
        receiverNode5: { enabled: false },
        receiverNode6: { enabled: true, mode: "deny" },
      },
      nodes: nodes.map(({ num, apiPort, listenPort, peerId }) => ({
        num,
        apiPort,
        listenPort,
        peerId,
      })),
      rows,
    };
    writeArtifact(artifact);

    await createCg(node1, trustedCg, [node3.peerId]);
    await createCg(node1, untrustedCg, [node4.peerId]);

    patchConfig(node1, (config) => {
      config.chat = {
        enabled: true,
        allowLoopback: false,
        acl: {
          mode: "trusted",
          peerAllowlist: [node2.peerId],
          trustedContextGraphIds: [trustedCg],
        },
        limits: { maxTextBytes: 64, maxMessagesPerMinute: 3 },
      };
    });
    patchConfig(node5, (config) => {
      delete config.chat;
    });
    patchConfig(node6, (config) => {
      config.chat = { enabled: true, acl: { mode: "deny" } };
    });

    for (const receiver of [node1, node5, node6]) {
      restartNode(receiver, node1);
      await waitForApi(receiver);
    }
    for (const [sender, receiver] of [
      [node2, node1],
      [node3, node1],
      [node4, node1],
      [node2, node5],
      [node2, node6],
    ] as const) {
      await ensureConnected(sender, receiver);
    }

    async function runRow(input: {
      id: string;
      sender: NodeInfo;
      receiver: NodeInfo;
      trustBasis: string;
      expected: "allow" | "deny";
      contextGraphId?: string;
      text?: string;
    }): Promise<void> {
      const text = input.text ?? `${RUN_ID}:${input.id}`;
      let delivered = false;
      let error: string | undefined;
      let httpAttempts = 0;
      const maxAttempts = input.expected === "deny" ? 3 : 1;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        httpAttempts = attempt;
        try {
          const response = await apiJson(input.sender, "/api/chat", {
            method: "POST",
            body: JSON.stringify({
              to: input.receiver.peerId,
              text,
              ...(input.contextGraphId
                ? { contextGraphId: input.contextGraphId }
                : {}),
            }),
          });
          delivered =
            response.status === 200 && response.body?.delivered === true;
          error =
            typeof response.body?.error === "string"
              ? response.body.error
              : response.status === 200
                ? undefined
                : `HTTP ${response.status}`;
          break;
        } catch (caught) {
          error = caught instanceof Error ? caught.message : String(caught);
          if (attempt < maxAttempts) {
            await new Promise((resolveSleep) => setTimeout(resolveSleep, 500));
          }
        }
      }
      const stored = await waitForStored(
        input.receiver,
        input.sender.peerId,
        text,
        input.expected === "allow",
      );
      const expectedAllow = input.expected === "allow";
      const policyDenied =
        typeof error === "string" &&
        /unauthorized|resource limit|rate limit/i.test(error);
      const selfDialDenied =
        input.sender.peerId === input.receiver.peerId &&
        typeof error === "string" &&
        /dial self/i.test(error);
      rows.push({
        id: input.id,
        senderNode: input.sender.num,
        senderPeerId: input.sender.peerId,
        receiverNode: input.receiver.num,
        receiverPeerId: input.receiver.peerId,
        trustBasis: input.trustBasis,
        contextGraphId: input.contextGraphId,
        textBytes: Buffer.byteLength(text, "utf8"),
        expected: input.expected,
        delivered,
        receiverStored: stored,
        error,
        httpAttempts,
        enforcementLayer: selfDialDenied
          ? "libp2p-transport"
          : "application-acl",
        pass: expectedAllow
          ? delivered && stored
          : !delivered && !stored && (policyDenied || selfDialDenied),
      });
      writeArtifact(artifact);
    }

    await runRow({
      id: "exact-peer",
      sender: node2,
      receiver: node1,
      trustBasis: "exact peer allowlist",
      expected: "allow",
    });
    await runRow({
      id: "exact-peer-wrong-cg",
      sender: node2,
      receiver: node1,
      trustBasis: "exact peer overrides CG rule but does not verify the claim",
      contextGraphId: untrustedCg,
      expected: "allow",
    });
    await runRow({
      id: "trusted-cg",
      sender: node3,
      receiver: node1,
      trustBasis: "active allowed-peer membership in explicit trusted CG",
      contextGraphId: trustedCg,
      expected: "allow",
    });
    await runRow({
      id: "trusted-cg-no-claim",
      sender: node3,
      receiver: node1,
      trustBasis: "ambient membership is insufficient without a claim",
      expected: "deny",
    });
    await runRow({
      id: "trusted-peer-untrusted-cg-claim",
      sender: node3,
      receiver: node1,
      trustBasis: "membership in trusted CG cannot claim another CG",
      contextGraphId: untrustedCg,
      expected: "deny",
    });
    await runRow({
      id: "untrusted-cg-member",
      sender: node4,
      receiver: node1,
      trustBasis:
        "allowed-peer membership exists only in a CG not trusted for chat",
      contextGraphId: untrustedCg,
      expected: "deny",
    });
    await runRow({
      id: "false-trusted-cg-claim",
      sender: node4,
      receiver: node1,
      trustBasis: "trusted CG claim without membership",
      contextGraphId: trustedCg,
      expected: "deny",
    });
    await runRow({
      id: "unknown-peer",
      sender: node4,
      receiver: node1,
      trustBasis: "no peer or CG trust",
      expected: "deny",
    });
    await runRow({
      id: "loopback-disabled",
      sender: node1,
      receiver: node1,
      trustBasis:
        "libp2p rejects self-dial before the default-deny ACL; ACL loopback behavior is unit-pinned",
      expected: "deny",
    });
    await runRow({
      id: "receiver-default-off",
      sender: node2,
      receiver: node5,
      trustBasis: "chat config omitted",
      expected: "deny",
    });
    await runRow({
      id: "receiver-explicit-deny",
      sender: node2,
      receiver: node6,
      trustBasis: "enabled listener with deny ACL",
      expected: "deny",
    });
    await runRow({
      id: "oversize",
      sender: node2,
      receiver: node1,
      trustBasis: "trusted peer over receiver byte limit",
      text: "x".repeat(65),
      expected: "deny",
    });

    // Reset only the in-memory rolling window, then prove its exact boundary.
    restartNode(node1, node1);
    await waitForApi(node1);
    await ensureConnected(node2, node1);
    for (let index = 1; index <= 3; index += 1) {
      await runRow({
        id: `rate-${index}`,
        sender: node2,
        receiver: node1,
        trustBasis: `trusted peer rate slot ${index}/3`,
        expected: "allow",
      });
    }
    await runRow({
      id: "rate-4",
      sender: node2,
      receiver: node1,
      trustBasis: "trusted peer exceeds 3/minute",
      expected: "deny",
    });

    artifact.finishedAt = new Date().toISOString();
    artifact.passed = rows.every((row) => row.pass);
    const artifactPath = writeArtifact(artifact);
    const failures = rows.filter((row) => !row.pass);
    expect(
      failures,
      `access-matrix failures; full evidence: ${artifactPath}`,
    ).toEqual([]);
    expect(rows).toHaveLength(16);
  });
});
