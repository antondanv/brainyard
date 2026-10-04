/** The rules `opencode run` gives its sessions; a session opened in the TUI has none. */
export declare const RUN_RULES: string;

export interface OpencodeStore {
  /** A session; `run: true` marks it as started by `opencode run`. */
  session(row: {
    id: string;
    directory: string;
    title: string;
    created?: number;
    updated?: number;
    parent?: string | null;
    run?: boolean;
    archived?: number | null;
  }): void;
  /** A user message with its text, or an assistant message (`completed: false` while it is being written). */
  message(row: {
    session: string;
    role: 'user' | 'assistant';
    text?: string;
    at?: number;
    completed?: boolean;
  }): string;
  close(): void;
}

export declare function openStore(path: string): OpencodeStore;
