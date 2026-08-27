/**
 * lethe plugin for opencode.
 *
 * The Claude Code equivalent is a UserPromptSubmit hook, configured in
 * settings.json. opencode has no hook config -- it has plugins -- so this is the
 * same idea in the shape opencode provides: chat.message hands over a mutable
 * `parts` array before the model sees the turn, and TextPart carries a
 * `synthetic` flag for exactly this, content the user did not type.
 *
 * Why a plugin at all: adoption. Measured across 79 sessions, 76% never called
 * lethe and only 10% called recall. Strengthened tool descriptions did not fix
 * it, and neither did the rules file, so the only mechanism left is one that
 * does not depend on the model choosing to ask.
 *
 * It shells out to `lethe hook prompt` rather than reimplementing retrieval,
 * so both hosts share one tested path -- including the relevance filter, which
 * took three attempts to get right and is the difference between useful context
 * and noise on every turn.
 *
 * Install: copy to ~/.config/opencode/plugins/lethe.js
 */

import { spawn } from "node:child_process";

/** Absolute, because a plugin's PATH is not a shell's and nvm lives off it. */
const NODE = process.env.LETHE_NODE ?? process.execPath;
const CLI = process.env.LETHE_CLI ?? "/Users/a.arvanitidis/Projects/lethe/dist/cli.js";
/** Short: this sits between the user pressing enter and the model starting. */
const TIMEOUT_MS = 3000;

function recall(prompt, directory) {
  return new Promise((resolve) => {
    let out = "";
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    let child;
    try {
      child = spawn(NODE, ["--disable-warning=ExperimentalWarning", CLI, "hook", "prompt"], {
        stdio: ["pipe", "pipe", "ignore"],
      });
    } catch {
      return done(""); // lethe not installed here; that is not an error
    }

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done("");
    }, TIMEOUT_MS);
    timer.unref?.(); // never hold the event loop open

    child.stdout.on("data", (d) => (out += d));
    child.on("error", () => {
      clearTimeout(timer);
      done("");
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done(code === 0 ? out.trim() : "");
    });

    try {
      child.stdin.on("error", () => {});
      child.stdin.end(JSON.stringify({ prompt, cwd: directory }));
    } catch {
      clearTimeout(timer);
      done("");
    }
  });
}

export const LethePlugin = async ({ directory }) => ({
  "chat.message": async (_input, output) => {
    try {
      const prompt = (output.parts ?? [])
        .filter((p) => p?.type === "text" && !p.synthetic && typeof p.text === "string")
        .map((p) => p.text)
        .join(" ")
        .trim();
      if (!prompt) return;

      const memories = await recall(prompt, directory);
      if (!memories) return; // nothing relevant; silence is the right output

      const anchor = output.parts.find((p) => p?.type === "text") ?? {};
      output.parts.push({
        id: `lethe-${Date.now()}`,
        sessionID: anchor.sessionID ?? "",
        messageID: anchor.messageID ?? "",
        type: "text",
        text: memories,
        // Marks this as not typed by the user, which is what it is.
        synthetic: true,
      });
    } catch {
      // A memory harness must never be the reason a turn fails.
    }
  },
});
