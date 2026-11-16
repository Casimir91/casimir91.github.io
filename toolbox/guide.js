/* Collapsible keyboard guide (closed by default): what to type → what you get.
   Used by calculator.html and graph.html: <details class="guide" id="guide" data-kind="calc|graph">. */
import { convertLatexToMarkup } from "./vendor/mathlive/mathlive.min.mjs";

const ROWS = {
  calc: [
    ["4/5", "\\frac{4}{5}", "Fraction. Press → to leave the denominator."],
    ["(1+2)/(3-4)", "\\frac{1+2}{3-4}", "Brackets before “/” go in the numerator."],
    ["sqrt(2)", "\\sqrt{2}"],
    ["cbrt(8)", "\\sqrt[3]{8}", "Other roots: the ⁿ√ key (2nd)."],
    ["2^3", "2^{3}", "One digit: the exponent closes by itself."],
    ["2^(1/3)", "2^{1/3}", "Longer exponent: press → to leave it."],
    ["pi", "\\pi"],
    ["sin(30)  cos(30)  tan(30)", "\\sin 30^\\circ", "Angle unit: the DEG / RAD pill."],
    ["arcsin(0.5)", "\\sin^{-1}0.5", "Also arccos, arctan."],
    ["sin(30)^2", "\\sin^{2}30^\\circ", "Square of the sine."],
    ["ln(5)  log(100)", "\\ln 5,\\ \\log 100"],
    ["*", "\\times"],
    ["Enter  ·  Esc", "=\\ \\ \\mathrm{AC}", "Enter calculates, Esc clears."],
  ],
  graph: [
    ["4/5", "\\frac{4}{5}", "Fraction. Press → to leave the denominator."],
    ["(x+1)/(x-1)", "\\frac{x+1}{x-1}", "Brackets before “/” go in the numerator."],
    ["sqrt(x)", "\\sqrt{x}"],
    ["cbrt(x)", "\\sqrt[3]{x}", "Other roots: ƒ layer, ⁿ√ key."],
    ["x^2", "x^{2}", "One digit: the exponent closes by itself."],
    ["x^(1/3)", "x^{1/3}", "Longer exponent: press → to leave it."],
    ["e^x", "e^{x}", "Euler's number, e ≈ 2.718."],
    ["pi", "\\pi"],
    ["sin(x)  cos(x)  tan(x)", "\\sin x"],
    ["arcsin(x)", "\\sin^{-1}x", "Also arccos, arctan."],
    ["sin(x)^2", "\\sin^{2}x", "Square of the sine."],
    ["ln(x)  log(x)", "\\ln x,\\ \\log x"],
    ["|  (Shift + \\)", "|x|", "Absolute value: the first | opens, the second closes."],
    ["a  b  c  d  k  m", "ax^2+bx+c", "Each letter becomes a slider."],
    ["Enter", "f \\to g", "Next function (or a new one)."],
  ],
};

const el = document.getElementById("guide");
if (el) {
  const kind = el.dataset.kind === "graph" ? "graph" : "calc";
  const sum = document.createElement("summary");
  sum.textContent = "⌨ Keyboard guide";
  const body = document.createElement("div");
  body.className = "guide-body";
  const intro = document.createElement("p");
  intro.textContent = "You can type with a physical keyboard: write the left column, the field turns it into the formula on the right.";
  const table = document.createElement("table");
  for (const [typed, latex, note] of ROWS[kind]) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<th scope="row"><code>${typed.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</code></th><td>${convertLatexToMarkup(latex)}${note ? `<small>${note}</small>` : ""}</td>`;
    table.appendChild(tr);
  }
  const tail = document.createElement("p");
  tail.className = "guide-tail";
  tail.textContent = "Arrow keys move the cursor, Backspace deletes. On a phone use the on-screen keys.";
  body.append(intro, table, tail);
  el.append(sum, body);

  const place = () => { body.style.top = Math.round(sum.getBoundingClientRect().bottom + 8) + "px"; };
  el.addEventListener("toggle", () => { if (el.open) place(); });
  window.addEventListener("resize", () => { if (el.open) place(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && el.open && !e.defaultPrevented) { el.open = false; } });
  document.addEventListener("pointerdown", (e) => { if (el.open && !el.contains(e.target)) el.open = false; });
}
