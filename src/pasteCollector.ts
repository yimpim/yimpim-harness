/**
 * Bracketed-paste bookkeeping for the pinned input line.
 *
 * With bracketed paste enabled the terminal wraps a paste in start/end
 * markers, which Node reports as `paste-start` / `paste-end` keypresses. But
 * readline still emits one `line` event per embedded newline, so without help
 * the first pasted line is submitted and the rest arrive as separate messages.
 *
 * The collector swallows those line events while a paste is in progress, then
 * hands back ONE placeholder (`[Pasted text #1 +12 lines]`) to show in the
 * input. Pressing Enter later expands the placeholder back to the full text,
 * so a paste is always one answer, never several commands.
 */
/**
 * What the input line holds once a paste ends, and whether the screen has to be repainted. It always does: readline's echo is dropped
 * while the paste arrives (so a big block is not typed out line by line), which means NOTHING of a paste has been drawn yet, a
 * single-line one included. Skipping the repaint when there was nothing to fold left the pasted text in the buffer but invisible
 * until another key made readline redraw the line.
 */
export function settlePaste(collector: PasteCollector, current: string): { line: string; folded: boolean; repaint: true } {
  const shown = collector.end(current);
  return { line: shown ?? current, folded: shown !== undefined, repaint: true };
}

export class PasteCollector {
  private active = false;
  private lines: string[] = [];
  private pastes = new Map<string, string>();
  private counter = 0;

  /** True between the start and end markers. */
  get pasting(): boolean {
    return this.active;
  }

  start(): void {
    this.active = true;
    this.lines = [];
  }

  /** A `line` event that arrived mid-paste. */
  line(raw: string): void {
    this.lines.push(raw);
  }

  /**
   * Closes the paste. `remainder` is whatever readline still holds after the
   * last newline. Returns the placeholder to put in the input, or undefined
   * when the paste was a single line (nothing to fold; readline already has it).
   */
  end(remainder: string): string | undefined {
    this.active = false;
    const all = [...this.lines, remainder];
    this.lines = [];
    // Only a paste that really contained a newline needs folding.
    if (all.length < 2) return undefined;
    while (all.length > 1 && all[all.length - 1] === "") all.pop();
    if (all.length < 2) return all[0] === remainder ? undefined : all[0];
    const text = all.join("\n");
    const token = `[Pasted text #${++this.counter} +${all.length} lines]`;
    this.pastes.set(token, text);
    return token;
  }

  /** Replaces every placeholder in a submitted line with the text it stands for. */
  expand(raw: string): string {
    if (this.pastes.size === 0) return raw;
    let out = raw;
    for (const [token, text] of this.pastes) out = out.split(token).join(text);
    this.pastes.clear();
    return out;
  }
}
