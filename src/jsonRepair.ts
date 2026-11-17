/**
 * Reads JSON that a model wrote almost correctly.
 *
 * A model asked for JSON that carries code snippets regularly slips: a quote inside a string that is not escaped, a raw
 * newline in a string, a missing or trailing comma, an answer cut off before it closes. One slip anywhere used to throw the
 * whole answer away ("Expected ',' or ']' after array element in JSON at position 16060"), including everything correct
 * before it. `parseLenient` parses normally first and only repairs when that fails, so valid JSON is never touched.
 */

type Frame = { kind: "o"; phase: "key" | "colon" | "value" | "after" } | { kind: "a"; phase: "value" | "after" };

const ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t", "u"]);
const WS = /\s/;

/** Rewrites the first JSON object or array in `text` into valid JSON, or returns undefined when there is none. */
export function repairJson(text: string): string | undefined {
  let i = text.search(/[{[]/);
  if (i < 0) return undefined;
  const out: string[] = [];
  const stack: Frame[] = [];
  let rootDone = false;

  const top = () => stack[stack.length - 1];
  const afterValue = () => {
    const t = top();
    if (t) t.phase = "after";
    else rootDone = true;
  };
  /** Before a key or value starts: a comma if the previous one finished, a colon if a key is waiting for one. */
  const beforeItem = (isKey: boolean) => {
    const t = top();
    if (!t) return;
    if (t.phase === "after") out.push(",");
    if (t.kind === "o" && t.phase === "colon" && !isKey) out.push(":");
    if (t.kind === "o" && t.phase === "after") t.phase = "key";
  };
  const nextNonWs = (from: number) => {
    let j = from;
    while (j < text.length && WS.test(text[j])) j++;
    return j;
  };
  const startsValue = (c: string | undefined) => c === undefined || /["{[\]}\-0-9tfn]/.test(c);

  const readString = (isKey: boolean): string => {
    // text[i] is the opening quote.
    i++;
    let s = '"';
    while (i < text.length) {
      const ch = text[i];
      if (ch === "\\") {
        const n = text[i + 1];
        if (n !== undefined && ESCAPES.has(n)) {
          s += ch + n;
          i += 2;
        } else {
          s += "\\\\";
          i++;
        }
        continue;
      }
      if (ch === '"') {
        const j = nextNonWs(i + 1);
        const c = text[j];
        let closing = c === undefined || c === "}" || c === "]";
        if (c === ":") closing = isKey;
        // A comma left out: the next thing is a whole string followed by what ends a string ("x" "y"], "x" "k":).
        if (c === '"') closing = /^"[^"\n]*"\s*[,:\]}]/.test(text.slice(j, j + 400));
        if (c === ",") {
          const k = nextNonWs(j + 1);
          const parent = top();
          const wantsKey = parent?.kind === "o";
          closing = wantsKey ? text[k] === '"' || text[k] === "}" || text[k] === undefined : startsValue(text[k]);
        }
        if (closing) {
          i++;
          return s + '"';
        }
        s += '\\"';
        i++;
        continue;
      }
      if (ch === "\n") s += "\\n";
      else if (ch === "\r") s += "\\r";
      else if (ch === "\t") s += "\\t";
      else if (ch < " ") s += " ";
      else s += ch;
      i++;
    }
    return s + '"'; // cut off inside a string
  };

  while (i < text.length && !rootDone) {
    const c = text[i];
    if (WS.test(c)) {
      out.push(c);
      i++;
      continue;
    }
    const t = top();
    if (c === '"') {
      const isKey = t?.kind === "o" && (t.phase === "key" || t.phase === "after");
      beforeItem(isKey);
      out.push(readString(isKey));
      if (isKey) (t as Frame).phase = "colon";
      else afterValue();
    } else if (c === ":") {
      if (t?.kind === "o" && t.phase === "colon") {
        out.push(":");
        t.phase = "value";
      }
      i++;
    } else if (c === ",") {
      // Written only when the next item arrives, so a trailing comma is dropped and a missing one is supplied.
      i++;
    } else if (c === "{" || c === "[") {
      beforeItem(false);
      out.push(c);
      if (t) t.phase = "after"; // the child is this item; if the answer is cut off inside it, the parent is not waiting for a value
      stack.push(c === "{" ? { kind: "o", phase: "key" } : { kind: "a", phase: "value" });
      i++;
    } else if (c === "}" || c === "]") {
      const f = stack.pop();
      if (!f) {
        i++;
        continue;
      }
      if (f.kind === "o" && (f.phase === "colon" || f.phase === "value")) out.push(f.phase === "colon" ? ":null" : "null");
      out.push(f.kind === "o" ? "}" : "]");
      afterValue();
      i++;
    } else {
      const m = /^[A-Za-z0-9_+\-.]+/.exec(text.slice(i));
      if (!m) {
        i++; // stray punctuation between values
        continue;
      }
      const word = m[0];
      i += word.length;
      const isKey = t?.kind === "o" && (t.phase === "key" || t.phase === "after");
      beforeItem(isKey);
      const literal = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(word) || word === "true" || word === "false" || word === "null";
      out.push(literal && !isKey ? word : JSON.stringify(word));
      if (isKey) (t as Frame).phase = "colon";
      else afterValue();
    }
  }
  // Cut off before it closed: finish what is open.
  while (stack.length > 0) {
    const f = stack.pop()!;
    if (f.kind === "o" && (f.phase === "colon" || f.phase === "value")) out.push(f.phase === "colon" ? ":null" : "null");
    out.push(f.kind === "o" ? "}" : "]");
  }
  return out.join("");
}

/** JSON.parse, and when that fails, JSON.parse of the repaired text. `repaired` says which one it took. */
export function parseLenient(text: string): { value: any; repaired: boolean } | undefined {
  try {
    return { value: JSON.parse(text), repaired: false };
  } catch {
    // fall through to the repair
  }
  try {
    const fixed = repairJson(text);
    if (fixed === undefined) return undefined;
    return { value: JSON.parse(fixed), repaired: true };
  } catch {
    return undefined;
  }
}
