/* Caret helpers for the Thumb Calculator (there are no arrow keys): leave a fraction denominator, an exponent
   or a radicand when an operator is pressed, close a bracket with the ( ) key, and write sin²(x) between the
   function name and its bracket. They use MathLive's model (vendored 0.111.4); if it is missing they do nothing. */

const model = (mf) => { try { return mf._mathfield && mf._mathfield.model; } catch (e) { return null; } };
const atomAtCaret = (mf) => { const m = model(mf); return m ? m.at(mf.position) : null; };
const isEmptyish = (a) => !a || a.type === "first" || a.type === "placeholder";

/* is the caret at the end of a structure that is "finished" when you type an operator? */
function exitable(a) {
  if (!a || isEmptyish(a) || !a.isLastSibling || !a.parent) return false;
  const p = a.parent, br = a.parentBranch;
  if (p.type === "genfrac" && br === "below") return true;      // denominator
  if (p.type === "subsup" && (br === "superscript" || br === "subscript")) return true;
  if (p.type === "surd" && br === "body") return true;           // radicand
  return false;
}

/* leave every finished structure under the caret; returns how many levels were left */
export function exitStructures(mf) {
  let n = 0;
  for (let guard = 0; guard < 8; guard++) {
    if (!exitable(atomAtCaret(mf))) break;
    mf.executeCommand("moveToNextChar"); n++;
  }
  return n;
}

/* the ( ) key: close the bracket we are in if the caret is at its end; otherwise open a new pair */
export function closeBracketIfAny(mf) {
  exitStructures(mf);
  const a = atomAtCaret(mf);
  if (a && !isEmptyish(a) && a.isLastSibling && a.parent && a.parent.type === "leftright" && a.parentBranch === "body"
      && a.type !== "mbin" && a.type !== "mrel" && a.type !== "mopen") {
    mf.executeCommand("moveToNextChar");
    return true;
  }
  return false;
}

const TRIG = new Set(["\\sin", "\\cos", "\\tan", "\\cot"]);

/* x² / x³ right after sin(…), cos(…), tan(…), cot(…): put the exponent on the function name: sin²(x) */
export function trigPower(mf, exp) {
  const m = model(mf);
  if (!m) return false;
  const pos = mf.position, br = m.at(pos);
  if (!br || br.type !== "leftright") return false;
  // the function-name atom is the sibling just before the bracket group
  const idx = pos - 1;
  let op = null;
  for (let o = pos - 1; o >= 0 && o >= pos - 400; o--) {          // nearest atom before the group in the same branch
    const a = m.at(o);
    if (a === br) continue;
    if (a.parent === br.parent && a.parentBranch === br.parentBranch) {
      if (a.type === "operator" && TRIG.has(a.command) && !a.superscript) { op = { a, o }; }
      break;
    }
  }
  if (!op) return false;
  const delta0 = mf.lastOffset;
  mf.position = op.o;                                              // caret right after the function name
  mf.insert(`^{${exp}}`, { silenceNotifications: false });
  mf.position = pos + (mf.lastOffset - delta0);                    // back after the bracket
  return true;
}
