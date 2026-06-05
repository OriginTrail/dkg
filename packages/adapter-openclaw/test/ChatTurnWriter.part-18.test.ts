import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ChatTurnWriter } from "../src/ChatTurnWriter";
import type { AgentEndContext, InternalMessageEvent } from "../src/ChatTurnWriter";

/** Wait long enough for fire-and-forget persistOne() to complete. */
const flushMicrotasks = () => new Promise((r) => setTimeout(r, 20));

const conversationInfoMetadataBlock = [
  "Conversation info (untrusted metadata):",
  "```json",
  "{",
  " \"chat_id\": \"telegram:test-chat-001\",",
  " \"message_id\": \"test-message-1021\",",
  " \"sender_id\": \"test-sender-001\",",
  " \"sender\": \"Test Sender\",",
  " \"timestamp\": \"Mon 2026-05-04 13:08 GMT+2\"",
  "}",
  "```",
].join("\n");

const senderMetadataBlock = [
  "Sender (untrusted metadata):",
  "```json",
  "{",
  " \"label\": \"Test Sender (test-sender-001)\",",
  " \"id\": \"test-sender-001\",",
  " \"name\": \"Test Sender\",",
  " \"username\": \"test_sender_001\"",
  "}",
  "```",
].join("\n");

const pastedSenderMetadataBlock = [
  "Sender (untrusted metadata):",
  "```json",
  "{",
  " \"label\": \"Pasted Sender (user-pasted-sender-999)\",",
  " \"id\": \"user-pasted-sender-999\",",
  " \"name\": \"Pasted Sender\",",
  " \"username\": \"pasted_sender_999\"",
  "}",
  "```",
].join("\n");

const channelContextMetadataBlock = [
  "Channel context (untrusted metadata):",
  "```json",
  "{",
  " \"example\": \"user-pasted channel context\"",
  "}",
  "```",
].join("\n");

function telegramWrappedUserText(userText: string, opts: { sender?: boolean } = {}): string {
  const blocks = [conversationInfoMetadataBlock];
  if (opts.sender !== false) blocks.push(senderMetadataBlock);
  return [...blocks, userText].join("\n\n");
}

describe("ChatTurnWriter", () => {

    let writer: ChatTurnWriter;

    let mockClient: {
      storeChatTurn: ReturnType<typeof vi.fn>;
      getChatTurnStoreStatus?: ReturnType<typeof vi.fn>;
    };

    let mockLogger: {
      debug: ReturnType<typeof vi.fn>;
      info: ReturnType<typeof vi.fn>;
      warn: ReturnType<typeof vi.fn>;
      error: ReturnType<typeof vi.fn>;
    };

    let stateDir: string;


    beforeEach(() => {
      stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatturnwriter-test-"));
      mockLogger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };
      mockClient = {
        storeChatTurn: vi.fn().mockResolvedValue(undefined),
      };
      writer = new ChatTurnWriter({ client: mockClient, logger: mockLogger, stateDir });
    });


    afterEach(() => {
      writer.flushSync();
      try {
        fs.rmSync(stateDir, { recursive: true, force: true });
      } catch {
        // best effort
      }
      vi.clearAllMocks();
    });


    it("T27 — setStateDir leaves stateDir/watermarkFilePath unchanged when the new-path write fails (retry-safe)", async () => {
      // Regression for T27: pre-fix `setStateDir` swapped internal
      // `stateDir` / `watermarkFilePath` BEFORE attempting the write.
      // A failed write left the writer pointing at the broken new path,
      // and a retry of `setStateDir(newStateDir)` short-circuited under
      // the same-path guard — the migration never re-attempted.
      const dkw = writer as any;
      dkw.cachedWatermarks.set("openclaw:tg:::sk", 5);
      dkw.writeWatermarkFile();
      const oldStateDir = dkw.stateDir;
      const oldWatermarkFilePath = dkw.watermarkFilePath;

      // Force write failure via parent-is-a-file ENOTDIR.
      const blockingFile = path.join(stateDir, "blocker27.txt");
      fs.writeFileSync(blockingFile, "blocker");
      const badStateDir = path.join(blockingFile, "nested-not-a-dir");

      await writer.setStateDir(badStateDir);

      // Internal state MUST still point at the OLD path so a follow-up
      // setStateDir(badStateDir) (or any other target) re-attempts
      // instead of short-circuiting on the same-path guard.
      expect(dkw.stateDir).toBe(oldStateDir);
      expect(dkw.watermarkFilePath).toBe(oldWatermarkFilePath);

      // A retry to a VALID destination must now succeed normally —
      // proves the failed migration didn't poison the writer.
      const goodStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatturnwriter-t27-good-"));
      try {
        await writer.setStateDir(goodStateDir);
        expect(dkw.stateDir).toBe(goodStateDir);
        const goodFile = path.join(goodStateDir, "dkg-adapter", "chat-turn-watermarks.json");
        expect(fs.existsSync(goodFile)).toBe(true);
      } finally {
        try { fs.rmSync(goodStateDir, { recursive: true, force: true }); } catch { /* best effort */ }
      }
    });


    it("T28 — computeDelta skips image-only user messages (no blank-user assistant pair)", async () => {
      // Regression for T28: pre-fix `computeDelta` queued every user
      // message into `pendingUsers`, including ones whose multi-modal
      // content array had no `type === "text"` parts (extractText
      // returns ""). The next assistant reply was then persisted as
      // `{ user: "", assistant: reply }` — a blank-user turn.
      // Post-fix W4a mirrors W4b's R15.2 invariant: image-only user
      // messages are skipped in `pendingUsers`, so an immediately-
      // following reply pairs only with the most recent text user
      // message (or bails per R22.1 if there is none).
      const event: AgentEndContext = {
        sessionId: "test",
        messages: [
          { role: "user", content: "real text question" },
          { role: "user", content: [{ type: "image", text: undefined } as any] }, // image-only
          { role: "assistant", content: "reply" },
        ],
      };
      writer.onAgentEnd(event, { channelId: "tg", sessionKey: "sk" });
      await flushMicrotasks();
      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
      const call = mockClient.storeChatTurn.mock.calls[0];
      // user side must be the text question — NOT an empty string from
      // the image-only message blowing away the join, NOT a "real text
      // question\n" with a trailing blank from the join with "".
      expect(call[1]).toBe("real text question");
      expect(call[2]).toBe("reply");
    });


    it("T28 — image-only user followed by another text user collapses ONLY the text users (consistent with W4b R15.2)", async () => {
      // Edge case: [text-u1, image-u2, text-u3, reply]. The image
      // contributes nothing; the join is "u1\nu3", not "u1\n\nu3".
      const event: AgentEndContext = {
        sessionId: "test",
        messages: [
          { role: "user", content: "u1" },
          { role: "user", content: [{ type: "image", text: undefined } as any] },
          { role: "user", content: "u3" },
          { role: "assistant", content: "reply" },
        ],
      };
      writer.onAgentEnd(event, { channelId: "tg", sessionKey: "sk" });
      await flushMicrotasks();
      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
      expect(mockClient.storeChatTurn.mock.calls[0][1]).toBe("u1\nu3");
    });


    it("T23 — setStateDir does NOT delete the old file when the write at the new path fails", async () => {
      // Regression for T23: pre-fix, `setStateDir` unconditionally
      // unlinked the OLD file after calling `writeWatermarkFile()`,
      // which silently swallows errors. If the new location was
      // unwritable (permissions, ENOSPC, ENOENT on parent), the
      // migration would delete the only valid watermark file —
      // restart would backfill every previously-persisted turn as
      // new (daemon duplicate writes). Post-fix, the old file is
      // preserved when the new write fails.
      // Seed and persist some state at the old path so we have a file
      // to protect across the migration.
      const dkw = writer as any;
      dkw.cachedWatermarks.set("openclaw:tg:::sk", 5);
      // Write directly via the private helper — `flushSync()` is a no-op
      // when there are no pending debounce timers.
      dkw.writeWatermarkFile();
      const oldFile = path.join(stateDir, "dkg-adapter", "chat-turn-watermarks.json");
      expect(fs.existsSync(oldFile)).toBe(true);

      // Make the new destination unwritable: point setStateDir at a path
      // where the parent ITSELF is a file, not a directory. The internal
      // `mkdirSync(dir, { recursive: true })` call will throw ENOTDIR on
      // the file ancestor, the catch in writeWatermarkFile returns false,
      // and the old file deletion must be skipped.
      const blockingFile = path.join(stateDir, "blocker.txt");
      fs.writeFileSync(blockingFile, "blocker");
      const newStateDir = path.join(blockingFile, "nested-not-a-dir");

      await writer.setStateDir(newStateDir);
      // The old file MUST still exist — preserved as recovery source
      // because the write at the new path failed.
      expect(fs.existsSync(oldFile)).toBe(true);
    });


    it("T22 — setStateDir merges destination state via max(w)/max(b) instead of overwriting (no rollback)", async () => {
      // Regression for T22: the earlier T18 migration used
      // `fs.copyFileSync` unconditionally, which rolled back any newer
      // state at the destination from a prior run. Post-fix, the merge
      // takes max(watermark) and max(w4bCount) per session.
      const newStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatturnwriter-t22-"));
      const newDir = path.join(newStateDir, "dkg-adapter");
      fs.mkdirSync(newDir, { recursive: true });
      const newFile = path.join(newDir, "chat-turn-watermarks.json");
      // Pre-seed destination with NEWER state for one session and a
      // unique-to-destination session.
      fs.writeFileSync(newFile, JSON.stringify({
        "openclaw:tg:::sk-shared": { w: 10, b: 5 },     // newer than source
        "openclaw:tg:::sk-onlydst": { w: 99, b: 99 },   // not in source
      }));

      // Source writer has OLDER state for sk-shared and a unique session.
      const dkw = writer as any;
      dkw.cachedWatermarks.set("openclaw:tg:::sk-shared", 3);    // older
      dkw.w4bSessionCounts.set("openclaw:tg:::sk-shared", 2);    // older
      dkw.cachedWatermarks.set("openclaw:tg:::sk-onlysrc", 7);   // not in destination
      dkw.w4bSessionCounts.set("openclaw:tg:::sk-onlysrc", 4);

      await writer.setStateDir(newStateDir);

      // Read the merged file at the new location.
      const merged = JSON.parse(fs.readFileSync(newFile, "utf-8"));
      // sk-shared: max(3, 10) = 10; max(2, 5) = 5 → destination's wins.
      expect(merged["openclaw:tg:::sk-shared"]).toEqual({ w: 10, b: 5 });
      // sk-onlydst: preserved unchanged.
      expect(merged["openclaw:tg:::sk-onlydst"]).toEqual({ w: 99, b: 99 });
      // sk-onlysrc: source values carried over.
      expect(merged["openclaw:tg:::sk-onlysrc"]).toEqual({ w: 7, b: 4 });

      try { fs.rmSync(newStateDir, { recursive: true, force: true }); } catch { /* best effort */ }
    });


    it("T43 — setStateDir restores in-memory watermarks when the new-path write fails (no destination-state pollution)", async () => {
      // Regression for T43: pre-fix the merge mutated `cachedWatermarks`
      // / `w4bSessionCounts` BEFORE attempting the write. If the write
      // failed, the writer kept old paths but carried the destination's
      // (newer) watermarks in memory, so the next persist would skip
      // turns whose pair index is < the merged watermark.
      const newStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatturnwriter-t43-"));
      const newDir = path.join(newStateDir, "dkg-adapter");
      fs.mkdirSync(newDir, { recursive: true });
      const newFile = path.join(newDir, "chat-turn-watermarks.json");
      // Destination file exists with NEWER state for one session, so the
      // merge phase has something to merge.
      fs.writeFileSync(newFile, JSON.stringify({
        "openclaw:tg:::sk-shared": { w: 99, b: 50 },
      }));

      // Source writer has OLDER state.
      const dkw = writer as any;
      dkw.cachedWatermarks.set("openclaw:tg:::sk-shared", 5);
      dkw.w4bSessionCounts.set("openclaw:tg:::sk-shared", 2);

      // Force the write to fail via vi.spyOn — first call returns false
      // (the new-path write inside setStateDir), subsequent calls fall
      // through to the real implementation.
      const writeSpy = vi.spyOn(dkw, "writeWatermarkFile").mockImplementationOnce(() => false);

      await writer.setStateDir(newStateDir);

      // In-memory state MUST be the old values, not the destination's.
      expect(dkw.cachedWatermarks.get("openclaw:tg:::sk-shared")).toBe(5);
      expect(dkw.w4bSessionCounts.get("openclaw:tg:::sk-shared")).toBe(2);
      // stateDir / watermarkFilePath unchanged on failure.
      expect(dkw.stateDir).not.toBe(newStateDir);

      writeSpy.mockRestore();
      try { fs.rmSync(newStateDir, { recursive: true, force: true }); } catch { /* best effort */ }
    });


    it("T45 — concurrent persist during setStateDir merge+write is preserved (no wipe on failure, no clobber on success)", async () => {
      // Regression for T45: pre-fix `setStateDir` mutated live maps
      // during merge. A concurrent persist firing AFTER `flush()`
      // returned but BEFORE the write committed could be wiped by
      // the snapshot restore (failure path) or clobbered by the
      // merged destination value (success path). Post-fix the merge
      // uses TEMP maps; live state mutates only on commit, and the
      // commit unions back via max-merge so concurrent advances
      // survive.
      const newStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatturnwriter-t45-"));
      const newDir = path.join(newStateDir, "dkg-adapter");
      fs.mkdirSync(newDir, { recursive: true });
      const newFile = path.join(newDir, "chat-turn-watermarks.json");
      // Destination has w=10 for sk-shared.
      fs.writeFileSync(newFile, JSON.stringify({
        "openclaw:tg:::sk-shared": { w: 10, b: 5 },
      }));

      const dkw = writer as any;
      dkw.cachedWatermarks.set("openclaw:tg:::sk-shared", 3);
      dkw.w4bSessionCounts.set("openclaw:tg:::sk-shared", 2);
      // Stage 1 — failure path: simulate write failure. Live state
      // must NOT be mutated by the merge attempt.
      const writeSpy = vi.spyOn(dkw, "writeWatermarkFile").mockImplementationOnce(() => false);
      await writer.setStateDir(newStateDir);
      expect(dkw.cachedWatermarks.get("openclaw:tg:::sk-shared")).toBe(3);
      expect(dkw.w4bSessionCounts.get("openclaw:tg:::sk-shared")).toBe(2);
      writeSpy.mockRestore();

      // Stage 2 — success path with simulated concurrent persist
      // increment that lands DURING the write. We simulate by
      // bumping live's watermark mid-call via the spy itself.
      dkw.cachedWatermarks.set("openclaw:tg:::sk-shared", 3);
      dkw.w4bSessionCounts.set("openclaw:tg:::sk-shared", 2);
      const writeSpy2 = vi.spyOn(dkw, "writeWatermarkFile").mockImplementationOnce((target: string, override: any) => {
        // Simulate a concurrent persist firing right before the
        // commit phase: bump live to 7. Without T45's max-union
        // commit, the merge-into-live (or restore) would clobber
        // this back to 3 or 10.
        dkw.cachedWatermarks.set("openclaw:tg:::sk-shared", 7);
        // Also write the override data to the new path so the
        // outer `wrote` boolean is true and the commit path runs.
        fs.writeFileSync(target, JSON.stringify(Object.fromEntries(override.wm.entries() as Iterable<[string, number]>)));
        return true;
      });
      // Use a different new state dir so setStateDir doesn't bail on
      // same-path. Required because Stage 1 left stateDir unchanged
      // but the same-path guard compares the constructed
      // newWatermarkFilePath, not the stateDir, so reusing newStateDir
      // would still pass the guard — but using a fresh dir keeps the
      // test assertions independent.
      const newStateDir2 = fs.mkdtempSync(path.join(os.tmpdir(), "chatturnwriter-t45-stage2-"));
      fs.mkdirSync(path.join(newStateDir2, "dkg-adapter"), { recursive: true });
      fs.writeFileSync(
        path.join(newStateDir2, "dkg-adapter", "chat-turn-watermarks.json"),
        JSON.stringify({ "openclaw:tg:::sk-shared": { w: 10, b: 5 } }),
      );
      await writer.setStateDir(newStateDir2);
      // Live MUST be max(merged=10, concurrent=7) = 10. The
      // concurrent persist's 7 doesn't shadow the merge — neither
      // does the merge clobber back below the concurrent value.
      expect(dkw.cachedWatermarks.get("openclaw:tg:::sk-shared")).toBe(10);
      writeSpy2.mockRestore();

      try { fs.rmSync(newStateDir, { recursive: true, force: true }); } catch { /* best effort */ }
      try { fs.rmSync(newStateDir2, { recursive: true, force: true }); } catch { /* best effort */ }
    });


    it("T54 — setStateDir does a final rewrite at new path so late-persist advances are durable", async () => {
      // Regression for T54: pre-fix, the success path wrote a SNAPSHOT
      // of mergedWm/Bc to the new file, then unioned live with merged.
      // A late persist arriving between `flush()` returning and the
      // union landed in live but NOT the file. A crash before the next
      // debounce would leave the new file stale; on restart the writer
      // would load a watermark below the daemon's actual state and
      // replay turns (daemon does not dedup — ADR-002).
      const newStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatturnwriter-t54-"));
      const newDir = path.join(newStateDir, "dkg-adapter");
      fs.mkdirSync(newDir, { recursive: true });
      const newFile = path.join(newDir, "chat-turn-watermarks.json");
      // Destination has older state than source.
      fs.writeFileSync(newFile, JSON.stringify({
        "openclaw:tg:::sk-shared": { w: 5, b: 3 },
      }));

      const dkw = writer as any;
      dkw.cachedWatermarks.set("openclaw:tg:::sk-shared", 7);
      dkw.w4bSessionCounts.set("openclaw:tg:::sk-shared", 4);

      // Simulate a late persist firing AFTER the snapshot is built but
      // before the write completes: spy on writeWatermarkFile, on the
      // FIRST call (the merge+write at new path with override maps),
      // bump live to 9 to simulate the concurrent advance, then call
      // through to the original implementation.
      const realWrite = dkw.writeWatermarkFile.bind(dkw);
      const writeSpy = vi.spyOn(dkw, "writeWatermarkFile").mockImplementationOnce((target: string, override: any) => {
        // Late persist fires DURING the migration write.
        dkw.cachedWatermarks.set("openclaw:tg:::sk-shared", 9);
        return realWrite(target, override);
      });

      await writer.setStateDir(newStateDir);

      // Read the new file. Pre-fix it would contain {w: 7, b: 4}
      // (the snapshot) instead of {w: 9, b: 4} (live with late
      // persist). The final rewrite must capture the post-union
      // live value of 9.
      const persisted = JSON.parse(fs.readFileSync(newFile, "utf-8"));
      expect(persisted["openclaw:tg:::sk-shared"]).toEqual({ w: 9, b: 4 });
      expect(dkw.stateDir).toBe(newStateDir);

      writeSpy.mockRestore();
      try { fs.rmSync(newStateDir, { recursive: true, force: true }); } catch { /* best effort */ }
    });


    it("T55 — onAgentEnd backfill stamps cross-path origin ONLY for the last pair (no stale stamp for repeated content)", async () => {
      // Regression for T55: pre-fix `markCrossPathStamp` ran for every
      // persisted pair in the backfill loop. If pair[0] and pair[N-1]
      // (the live one) shared `(user, assistant)` text, the stamp from
      // pair[0]'s persist would sit in the cross-path map. A
      // concurrent W4b `message:sent` arriving for the live pair would
      // see the stamp via its content-only check and drop the user
      // queue, even though pair[N-1]'s W4a persist hadn't completed
      // yet. If pair[N-1] then failed, the live turn was lost.
      //
      // Post-fix the stamp is gated on `i === lastIdx`; only the live
      // pair leaves a cross-path footprint, matching the in-flight-
      // reservation gate already in place. Spy on the stamp method to
      // count calls — pre-fix would be 3 (one per persisted pair),
      // post-fix is 1 (only the last).
      //
      // T362 — Seed past cold-start so the in-session backfill loop
      // actually walks 3 pairs (cold-start clamp would otherwise discard
      // historical pairs and emit only the latest, defeating this test's
      // purpose of asserting the per-pair stamp gating).
      writer.onAgentEnd(
        { sessionId: "test", messages: [
          { role: "user", content: "__seed__" },
          { role: "assistant", content: "__seed__reply__" },
        ]},
        { channelId: "tg", sessionKey: "sk" },
      );
      await flushMicrotasks();
      mockClient.storeChatTurn.mockClear();

      const dkw = writer as any;
      const stampSpy = vi.spyOn(dkw, "markCrossPathStamp");
      const event: AgentEndContext = {
        sessionId: "test",
        messages: [
          { role: "user", content: "__seed__" },              // saved
          { role: "assistant", content: "__seed__reply__" },
          { role: "user", content: "u0" },
          { role: "assistant", content: "a0" },  // pair[1]
          { role: "user", content: "u1" },
          { role: "assistant", content: "a1" },  // pair[2]
          { role: "user", content: "u2" },
          { role: "assistant", content: "a2" },  // pair[3] (last, live pair)
        ],
      };
      writer.onAgentEnd(event, { channelId: "tg", sessionKey: "sk" });
      await flushMicrotasks();
      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(3);
      // Filter to W4a-side stamp calls. The W4a key uses `w4aOriginKey`
      // (content hashed with the W4a discriminator); we only need to
      // count how many times the backfill loop stamped, which is
      // exactly the count of calls.
      expect(stampSpy).toHaveBeenCalledTimes(1);
      // Verify it was the LAST pair that got stamped, not pair[1] or pair[2].
      const lastKey = dkw.w4aOriginKey("u2", "a2");
      expect(stampSpy.mock.calls.some((c: any[]) => c[1] === lastKey)).toBe(true);
      stampSpy.mockRestore();
    });
});
