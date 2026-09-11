/**
 * Line-buffered prompts for the CLIs.
 *
 * readline's question() drops lines that arrive before it is called - with
 * piped input they all arrive at once, so answers vanished and the process
 * exited cleanly having saved nothing. Iterating the line stream buffers them
 * instead, and running out of input is a loud error, never a silent success.
 */

import readline from "node:readline";
import { stdin, stdout } from "node:process";

export function prompter() {
  const rl = readline.createInterface({ input: stdin, terminal: stdin.isTTY ?? false });
  const lines = rl[Symbol.asyncIterator]();
  return {
    async ask(question: string): Promise<string> {
      stdout.write(question);
      const next = await lines.next();
      if (next.done) throw new Error(`Input ended before "${question.trim()}" was answered.`);
      if (!stdin.isTTY) stdout.write("\n");
      return String(next.value).trim();
    },
    close: () => rl.close(),
  };
}
