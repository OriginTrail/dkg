#!/usr/bin/env bash
# Sourceable helpers of scripts/devnet-read-graphs-build-run.sh: the gate's log watchers, which run in the
# background while the devnet's own scripts stop and start nodes. Function definitions only, no side effects on
# source. The caller sets DEVNET_DIR. bash 3.2 compatible.

# log_position <n>: "<size> <device:inode>" of node <n>'s daemon.log now, or "0 none" when there is none.
log_position() {
  node -e 'try { const s = require("fs").statSync(process.argv[1]); console.log(`${s.size} ${s.dev}:${s.ino}`); } catch { console.log("0 none"); }' \
    "$DEVNET_DIR/node$1/daemon.log"
}

# watch_mismatches <n> <out> <lost> <since> <start> <stopped>: in the background, append to <out> every read-graph check
# mismatch line that node <n> logs after <start> ("<size> <identity>" of its daemon.log, from log_position, taken before
# the gate starts, so a line written before this process opens the file is not missed). The daemon rotates daemon.log by
# renaming it to daemon.log.1: the watcher keeps each file open, reads it once more when it sees the rename, and goes on
# reading it until it has stayed unchanged for four polls, so a line written just before (or as) the file was renamed is
# read. When the daemon cannot rename, it trims the live file in place, and lines written since the last read may be
# gone: that is noted in <lost>, and the trimmed file is read again from its start (lines stamped before <since>, the
# log's local "YYYY-MM-DD HH:MM:SS", skipped). How the watcher ended goes into <stopped>. Prints the PID.
#
# The watcher must outlive the restarts it watches. Devnet process control (`devnet.sh stop-node`, `restart-node`,
# `stop`) stops every Node process whose command line or environment names a path under the node's home, so the
# watcher starts with an empty environment but PATH and HOME, and builds the log's path itself. A nohup'd run ignores
# SIGHUP, and its background jobs SIGINT, but Node resets an inherited ignore to the default, so the watcher ignores
# both itself; the runner stops it with SIGTERM.
watch_mismatches() {
  env -i PATH="$PATH" HOME="$HOME" WATCH_DEVNET="$DEVNET_DIR" WATCH_NODE="$1" OUT="$2" LOST="$3" SINCE="$4" START="$5" \
    STOPPED="$6" node -e '
    const fs = require("fs");
    const { WATCH_DEVNET, WATCH_NODE, OUT, LOST, SINCE, START, STOPPED } = process.env;
    const LOG = require("path").join(WATCH_DEVNET, `node${WATCH_NODE}`, "daemon.log");
    const stopped = (how) => { try { fs.appendFileSync(STOPPED, `${how} at ${new Date().toISOString()}\n`); } catch {} };
    process.on("SIGHUP", () => {});
    process.on("SIGINT", () => {});
    process.on("uncaughtException", (error) => { stopped(`uncaught ${error?.stack ?? error}`); process.exit(1); });
    const stamped = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d/;
    const keep = (line) => line.includes("[read-graph-check] Read graph <") && !(stamped.test(line) && line.slice(0, 19) < SINCE);
    const emit = (lines) => { const hits = lines.filter(keep); if (hits.length > 0) fs.appendFileSync(OUT, hits.join("\n") + "\n"); };
    const identity = (stat) => `${stat.dev}:${stat.ino}`;
    // A file being read: its descriptor, its identity, how far it was read, the unfinished last line, quiet polls.
    const openFile = (fromEnd) => {
      let fd;
      try { fd = fs.openSync(LOG, "r"); } catch { return null; }
      const stat = fs.fstatSync(fd);
      return { fd, id: identity(stat), offset: fromEnd ? stat.size : 0, rest: "", quiet: 0 };
    };
    // Read what was appended; whether anything was. A file shorter than what was read was trimmed in place.
    const drain = (file) => {
      const size = fs.fstatSync(file.fd).size;
      if (size < file.offset) {
        fs.appendFileSync(LOST, `${LOG} was trimmed in place at ${new Date().toISOString()}\n`); file.offset = 0; file.rest = "";
      }
      if (size === file.offset) return false;
      const buffer = Buffer.alloc(size - file.offset);
      fs.readSync(file.fd, buffer, 0, buffer.length, file.offset); file.offset = size;
      const lines = (file.rest + buffer.toString("utf8")).split("\n"); file.rest = lines.pop(); emit(lines);
      return true;
    };
    // Start where the log stood when the gate was about to start (START, "<size> <identity>"): what was written since,
    // also before this process opened the file, is read. If the file was renamed in between, its rest is read too.
    const [startSize, startId] = (START ?? "0 none").split(" ");
    let live = openFile(false);
    let rotated = [];
    if (live && live.id === startId) live.offset = Math.min(Number(startSize) || 0, fs.fstatSync(live.fd).size);
    else if (startId !== "none") {
      try {
        const fd = fs.openSync(`${LOG}.1`, "r"), stat = fs.fstatSync(fd);
        if (identity(stat) === startId) rotated.push({ fd, id: startId, offset: Math.min(Number(startSize) || 0, stat.size), rest: "", quiet: 0 });
        else fs.closeSync(fd);
      } catch { /* no rotated file */ }
    }
    const tick = () => {
      rotated = rotated.filter((file) => {
        file.quiet = drain(file) ? 0 : file.quiet + 1;
        if (file.quiet < 4) return true;
        emit([file.rest]); fs.closeSync(file.fd); return false;
      });
      if (live) drain(live);
      let stat;
      try { stat = fs.statSync(LOG); } catch { return; }
      if (!live) { live = openFile(false); if (live) drain(live); return; }
      if (identity(stat) !== live.id) {
        drain(live);
        rotated.push(live);
        live = openFile(false); if (live) drain(live);
      }
    };
    setInterval(tick, 500);
    process.on("SIGTERM", () => {
      try { tick(); for (const file of [...rotated, live]) if (file) { drain(file); emit([file.rest]); } } finally { stopped("SIGTERM"); process.exit(0); }
    });
  ' > /dev/null 2>&1 &
  echo $!
}
