import {
  NotImplementedError,
  type ExecuteResult,
  type FileInfo,
  type ProjectSandbox,
  type SandboxFileSystem,
  type SandboxProcessRunner,
} from "./types";

function notImplemented(method: string): never {
  throw new NotImplementedError(`Daytona sandbox ${method}`);
}

class DaytonaSandboxFileSystem implements SandboxFileSystem {
  async listFiles(): Promise<FileInfo[]> {
    return notImplemented("fs.listFiles");
  }

  async readTextFile(): Promise<string> {
    return notImplemented("fs.readTextFile");
  }

  async readBinaryFile(): Promise<Uint8Array> {
    return notImplemented("fs.readBinaryFile");
  }

  async writeTextFile(): Promise<void> {
    return notImplemented("fs.writeTextFile");
  }

  async writeBinaryFile(): Promise<void> {
    return notImplemented("fs.writeBinaryFile");
  }

  async createFolder(): Promise<void> {
    return notImplemented("fs.createFolder");
  }

  async deleteFile(): Promise<void> {
    return notImplemented("fs.deleteFile");
  }

  async moveFiles(): Promise<void> {
    return notImplemented("fs.moveFiles");
  }

  async searchFiles(): Promise<string[]> {
    return notImplemented("fs.searchFiles");
  }

  async getFileDetails(): Promise<FileInfo> {
    return notImplemented("fs.getFileDetails");
  }
}

class DaytonaSandboxProcessRunner implements SandboxProcessRunner {
  async executeCommand(): Promise<ExecuteResult> {
    return notImplemented("process.executeCommand");
  }
}

export class DaytonaProjectSandbox implements ProjectSandbox {
  readonly id: string;
  readonly rootDir: string;
  readonly description: string;
  readonly fs = new DaytonaSandboxFileSystem();
  readonly process = new DaytonaSandboxProcessRunner();

  constructor(sessionId: string) {
    this.id = sessionId;
    this.rootDir = "/workspace";
    this.description = `Daytona sandbox for session ${sessionId} (not yet connected)`;
  }
}
