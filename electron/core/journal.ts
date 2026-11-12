// Lattice's own journal: what it did and what went wrong, kept in memory for
// the window and in a file for a problem report.
import fs from 'node:fs/promises';
import path from 'node:path';
import type { JournalEntry } from '../../shared/types';

/**
 * Takes the query out of every link in a text: download links are signed and
 * may carry an account id, nxm:// links carry a one-time key.
 */
export function redactLinks(text: string): string {
  return text.replace(/\b((?:https?|nxm):\/\/[^\s?"'<>]+)\?[^\s"'<>]*/gi, '$1?…');
}

const KEEP = 400;
const FILE_LIMIT = 1024 * 1024;

export class Journal {
  private buf: JournalEntry[] = [];
  private writing: Promise<void> = Promise.resolve();

  constructor(
    /** where the journal file lives (asked every time: the data folder is a setting) */
    private file: () => string,
    /** takes out what must not leave the computer (the user's home folder) */
    private clean: (text: string) => string,
  ) {}

  note(kind: JournalEntry['kind'], text: string) {
    const e: JournalEntry = { at: new Date().toISOString(), kind, text };
    this.buf.push(e);
    if (this.buf.length > KEEP) this.buf.splice(0, this.buf.length - KEEP);
    const file = this.file();
    this.writing = this.writing
      .then(async () => {
        await fs.mkdir(path.dirname(file), { recursive: true });
        // one file of about a megabyte, and the one before it
        if (((await fs.stat(file).catch(() => null))?.size ?? 0) > FILE_LIMIT) await fs.rename(file, `${file}.1`).catch(() => undefined);
        await fs.appendFile(file, `${e.at} ${kind.toUpperCase().padEnd(4)} ${redactLinks(this.clean(text)).replace(/\r?\n/g, ' | ')}\n`);
      })
      .catch(() => undefined);
  }

  /** The journal of this session, newest last. */
  list(): JournalEntry[] {
    return this.buf;
  }

  /** Waits until everything noted so far is in the file. */
  flush(): Promise<void> {
    return this.writing;
  }
}
