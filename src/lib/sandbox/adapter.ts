import type { Experimental_SandboxSession } from "ai";

import type { ProjectSandbox } from "./types";

function readTextLines(content: string, startLine = 1, endLine?: number): string {
  const lines = content.split(/\r?\n/);

  if (endLine === undefined) {
    return lines.slice(startLine - 1).join("\n");
  }

  return lines.slice(startLine - 1, endLine).join("\n");
}

export function toSandboxSession(sandbox: ProjectSandbox): Experimental_SandboxSession {
  return {
    description: sandbox.description,

    readFile: async ({ path: targetPath }) => {
      try {
        const bytes = await sandbox.fs.readBinaryFile(targetPath);
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        });
      } catch {
        return null;
      }
    },

    readBinaryFile: async ({ path: targetPath }) => {
      try {
        return await sandbox.fs.readBinaryFile(targetPath);
      } catch {
        return null;
      }
    },

    readTextFile: async ({ path: targetPath, startLine, endLine }) => {
      try {
        const content = await sandbox.fs.readTextFile(targetPath);
        if (startLine || endLine) {
          return readTextLines(content, startLine ?? 1, endLine);
        }
        return content;
      } catch {
        return null;
      }
    },

    writeFile: async ({ path: targetPath, content }) => {
      const reader = content.getReader();
      const chunks: Uint8Array[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (value) {
          chunks.push(value);
        }
      }

      const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      const merged = new Uint8Array(totalLength);
      let offset = 0;

      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.length;
      }

      await sandbox.fs.writeBinaryFile(targetPath, merged);
    },

    writeBinaryFile: async ({ path: targetPath, content }) => {
      await sandbox.fs.writeBinaryFile(targetPath, content);
    },

    writeTextFile: async ({ path: targetPath, content }) => {
      await sandbox.fs.writeTextFile(targetPath, content);
    },

    spawn: async ({ command, workingDirectory, env, abortSignal }) => {
      const childPromise = sandbox.process.executeCommand(
        command,
        workingDirectory,
        env,
      );

      let stdout = "";
      let stderr = "";
      let exitCode = 0;
      let settled = false;

      const resultPromise = childPromise
        .then((result) => {
          settled = true;
          stdout = result.stdout;
          stderr = result.stderr;
          exitCode = result.exitCode;
          return { exitCode };
        })
        .catch((error: Error) => {
          settled = true;
          stderr = error.message;
          exitCode = 1;
          return { exitCode: 1 };
        });

      abortSignal?.addEventListener("abort", () => {
        if (!settled) {
          settled = true;
          exitCode = 1;
          stderr = "Command aborted";
        }
      });

      const encoder = new TextEncoder();

      return {
        stdout: new ReadableStream<Uint8Array>({
          async start(controller) {
            const result = await resultPromise;
            if (stdout) {
              controller.enqueue(encoder.encode(stdout));
            }
            controller.close();
            void result;
          },
        }),
        stderr: new ReadableStream<Uint8Array>({
          async start(controller) {
            await resultPromise;
            if (stderr) {
              controller.enqueue(encoder.encode(stderr));
            }
            controller.close();
          },
        }),
        wait: () => resultPromise,
        kill: async () => {
          settled = true;
          exitCode = 1;
        },
      };
    },

    run: async ({ command, workingDirectory, env }) => {
      const result = await sandbox.process.executeCommand(
        command,
        workingDirectory,
        env,
      );

      return {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    },
  };
}
