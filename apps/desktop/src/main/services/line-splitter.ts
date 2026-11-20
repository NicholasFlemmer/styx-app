/**
 * Newline-delimited output split into lines in linear time. Agents send one JSON message per line, and some lines
 * are huge (Codex sends a whole conversation back when it resumes one): appending every chunk to one string and
 * searching it from the start again made that quadratic, a core at 100% for minutes and gigabytes of churn. Here a
 * chunk is searched once, and the pieces of an unfinished line are joined once, when its newline arrives.
 */
export class LineSplitter {
  private parts: string[] = [];

  /** The complete lines this chunk finishes, in order. */
  push(chunk: string): string[] {
    const out: string[] = [];
    let start = 0;
    let nl = chunk.indexOf('\n');
    while (nl >= 0) {
      const piece = chunk.slice(start, nl);
      if (this.parts.length > 0) {
        this.parts.push(piece);
        out.push(this.parts.join(''));
        this.parts = [];
      } else out.push(piece);
      start = nl + 1;
      nl = chunk.indexOf('\n', start);
    }
    if (start < chunk.length) this.parts.push(chunk.slice(start));
    return out;
  }

  /** What is left without a newline (the end of the stream), and forget it. */
  rest(): string {
    const r = this.parts.join('');
    this.parts = [];
    return r;
  }
}
