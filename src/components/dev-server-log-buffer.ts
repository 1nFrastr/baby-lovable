export type DevLogStream = "stdout" | "stderr";

export interface DevLogIdentity {
  generation: number;
  cmdId: string;
  sessionName: string;
}

export interface DevLogBufferState {
  text: string;
  identity: DevLogIdentity | null;
  lastStream: DevLogStream | null;
  stdoutSeen: number;
  stderrSeen: number;
  hiddenStdout: number;
  hiddenStderr: number;
  stdoutTail: string;
  stderrTail: string;
  dedupeStdout: boolean;
  dedupeStderr: boolean;
  clearPending: boolean;
  truncated: boolean;
}

export const DEV_LOG_BUFFER_LIMIT = 200_000;
const TAIL_LIMIT = 4_096;
const TRUNCATED_NOTICE = "[Earlier logs truncated]\n";

export function emptyDevLogBuffer(): DevLogBufferState {
  return {
    text: "",
    identity: null,
    lastStream: null,
    stdoutSeen: 0,
    stderrSeen: 0,
    hiddenStdout: 0,
    hiddenStderr: 0,
    stdoutTail: "",
    stderrTail: "",
    dedupeStdout: false,
    dedupeStderr: false,
    clearPending: false,
    truncated: false,
  };
}

function identityKey(identity: DevLogIdentity | null): string {
  return identity
    ? `${identity.generation}:${identity.sessionName}:${identity.cmdId}`
    : "";
}

function boundText(text: string, alreadyTruncated: boolean) {
  const plain = text.startsWith(TRUNCATED_NOTICE)
    ? text.slice(TRUNCATED_NOTICE.length)
    : text;
  if (plain.length <= DEV_LOG_BUFFER_LIMIT) {
    return {
      text: alreadyTruncated ? `${TRUNCATED_NOTICE}${plain}` : plain,
      truncated: alreadyTruncated,
    };
  }
  return {
    text: `${TRUNCATED_NOTICE}${plain.slice(-DEV_LOG_BUFFER_LIMIT)}`,
    truncated: true,
  };
}

function streamBlock(stream: DevLogStream, text: string): string {
  return text ? `[${stream}]\n${text}` : "";
}

function appendBlock(
  current: string,
  lastStream: DevLogStream | null,
  stream: DevLogStream,
  text: string,
): string {
  if (!text) {
    return current;
  }
  const marker = lastStream === stream ? "" : `[${stream}]\n`;
  const separator =
    marker && current && !current.endsWith("\n") ? "\n" : "";
  return `${current}${separator}${marker}${text}`;
}

function stripSnapshotOverlap(tail: string, chunk: string): string {
  const max = Math.min(tail.length, chunk.length, TAIL_LIMIT);
  for (let size = max; size > 0; size -= 1) {
    if (tail.endsWith(chunk.slice(0, size))) {
      return chunk.slice(size);
    }
  }
  return chunk;
}

export function setDevLogIdentity(
  state: DevLogBufferState,
  identity: DevLogIdentity,
): DevLogBufferState {
  if (identityKey(state.identity) === identityKey(identity)) {
    return state;
  }
  return { ...emptyDevLogBuffer(), identity };
}

export function applyDevLogSnapshot(
  state: DevLogBufferState,
  stdoutRaw: string,
  stderrRaw: string,
  upstreamTruncated = false,
): DevLogBufferState {
  const hiddenStdout = state.clearPending
    ? stdoutRaw.length
    : state.hiddenStdout;
  const hiddenStderr = state.clearPending
    ? stderrRaw.length
    : state.hiddenStderr;
  const stdout = stdoutRaw.slice(Math.min(hiddenStdout, stdoutRaw.length));
  const stderr = stderrRaw.slice(Math.min(hiddenStderr, stderrRaw.length));
  const blocks = [streamBlock("stdout", stdout), streamBlock("stderr", stderr)]
    .filter(Boolean)
    .join("\n");
  const bounded = boundText(blocks, upstreamTruncated);
  return {
    ...state,
    text: bounded.text,
    lastStream: stderr ? "stderr" : stdout ? "stdout" : null,
    stdoutSeen: stdoutRaw.length,
    stderrSeen: stderrRaw.length,
    hiddenStdout,
    hiddenStderr,
    stdoutTail: stdoutRaw.slice(-TAIL_LIMIT),
    stderrTail: stderrRaw.slice(-TAIL_LIMIT),
    dedupeStdout: Boolean(stdoutRaw),
    dedupeStderr: Boolean(stderrRaw),
    clearPending: false,
    truncated: bounded.truncated,
  };
}

export function appendDevLogChunk(
  state: DevLogBufferState,
  stream: DevLogStream,
  rawChunk: string,
): DevLogBufferState {
  const shouldDedupe =
    stream === "stdout" ? state.dedupeStdout : state.dedupeStderr;
  const tail = stream === "stdout" ? state.stdoutTail : state.stderrTail;
  const chunk = shouldDedupe ? stripSnapshotOverlap(tail, rawChunk) : rawChunk;
  const nextText = appendBlock(state.text, state.lastStream, stream, chunk);
  const bounded = boundText(nextText, state.truncated);
  return {
    ...state,
    text: bounded.text,
    lastStream: chunk ? stream : state.lastStream,
    stdoutSeen:
      state.stdoutSeen + (stream === "stdout" ? chunk.length : 0),
    stderrSeen:
      state.stderrSeen + (stream === "stderr" ? chunk.length : 0),
    stdoutTail:
      stream === "stdout"
        ? `${state.stdoutTail}${chunk}`.slice(-TAIL_LIMIT)
        : state.stdoutTail,
    stderrTail:
      stream === "stderr"
        ? `${state.stderrTail}${chunk}`.slice(-TAIL_LIMIT)
        : state.stderrTail,
    dedupeStdout: stream === "stdout" ? false : state.dedupeStdout,
    dedupeStderr: stream === "stderr" ? false : state.dedupeStderr,
    clearPending: false,
    truncated: bounded.truncated,
  };
}

/** Clear this command locally while retaining a reconnect watermark. */
export function clearDevLogBuffer(
  state: DevLogBufferState,
): DevLogBufferState {
  return {
    ...state,
    text: "",
    lastStream: null,
    hiddenStdout: state.stdoutSeen,
    hiddenStderr: state.stderrSeen,
    clearPending: state.stdoutSeen === 0 && state.stderrSeen === 0,
    truncated: false,
  };
}
