// Forge gateway: a quote-aware reader for one shell command line (Bash or PowerShell), used by
// permissions/hard-gate.mjs (WP-AUTONOMY-GW). It splits a command into segments of words with their
// redirect targets, keeps the text of every `$( )` and back-tick substitution, and the body of every
// heredoc. It never runs anything and never decides; it only reads. Pure: no file system, no clock.
// `${NAME}` stays one word; in sh a `{` or `}` ends a segment only as a group word (`{ a; }`), so a
// brace expansion such as `{push,}` stays visible inside its word (security review rv-autonomy-sec F1/F4).

export const PS_STRING = '\u0001'; // marks a PowerShell statement that starts with a quoted string

/** Splits a command into segments of words (quotes removed) with their redirect targets, and collects
 *  the text of every `$( )` and back-tick substitution. Throws on unbalanced quotes or parentheses.
 *  Round 7: `appends[k]` is true when redirect k only adds to its file (`>>`, `&>>`), false when it may replace it. */
export function lexCommand(text, isPs) {
  const segments = [];
  const subs = [];
  const subSegs = []; // for each entry of subs: the index of the segment it appeared in
  const addSub = (t) => { subs.push(t); subSegs.push(segments.length); };
  let words = []; let redirects = []; let appends = []; let word = null; let redirectNext = false; let appendNext = false;
  const heredocs = [];
  const add = (s) => { word = (word === null ? '' : word) + s; };
  // PowerShell: a quoted string that starts a statement is output, not a program to run
  const psString = () => { if (isPs && word === null && words.length === 0) add(PS_STRING); };
  const endWord = () => {
    if (word === null) return;
    if (redirectNext) { redirects.push(word); appends.push(appendNext); } else words.push(word);
    word = null; redirectNext = false; appendNext = false;
  };
  const endSeg = () => {
    endWord();
    if (words.length || redirects.length) segments.push({ words, redirects, appends });
    words = []; redirects = []; appends = []; redirectNext = false; appendNext = false;
  };
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '\n' || c === '\r') {
      endSeg();
      i += 1;
      while (heredocs.length) { // read each pending heredoc body up to its end line; it belongs to its segment
        const { delim, seg } = heredocs.shift();
        const lines = text.slice(i).split('\n');
        let used = 0; let found = false; const body = [];
        for (const line of lines) {
          used += line.length + 1;
          if (line.replace(/\r$/, '').trim() === delim) { found = true; break; }
          body.push(line);
        }
        if (!found) throw new Error('unterminated heredoc');
        if (segments[seg]) segments[seg].heredoc = body.join('\n');
        i += used;
      }
      continue;
    }
    if (c === "'") {
      const j = text.indexOf("'", i + 1);
      if (j < 0) throw new Error('unbalanced quote');
      psString(); add(text.slice(i + 1, j)); i = j + 1; continue;
    }
    if (c === '"') {
      psString();
      let j = i + 1; let s = '';
      while (j < n && text[j] !== '"') {
        const d = text[j];
        if (!isPs && d === '\\' && '"\\$`'.includes(text[j + 1])) { s += text[j + 1]; j += 2; continue; }
        if (isPs && d === '`') { s += text[j + 1] || ''; j += 2; continue; }
        if (d === '$' && text[j + 1] === '(') { const k = closeParen(text, j + 1); addSub(text.slice(j + 2, k)); s += text.slice(j, k + 1); j = k + 1; continue; }
        if (!isPs && d === '`') { const k = text.indexOf('`', j + 1); if (k < 0) throw new Error('unbalanced back-tick'); addSub(text.slice(j + 1, k)); j = k + 1; continue; }
        s += d; j += 1;
      }
      if (j >= n) throw new Error('unbalanced quote');
      add(s); i = j + 1; continue;
    }
    if (isPs && c === '@' && (text[i + 1] === "'" || text[i + 1] === '"') && /[\r\n]/.test(text[i + 2] || '')) { // here-string
      const q = text[i + 1];
      const end = text.indexOf('\n' + q + '@', i + 2);
      if (end < 0) throw new Error('unterminated here-string');
      const body = text.slice(i + 2, end);
      if (q === '"') for (const m of body.matchAll(/\$\(([^()]*)\)/g)) addSub(m[1]);
      add(body); i = end + 3; continue;
    }
    if (c === '$' && text[i + 1] === '(') { const k = closeParen(text, i + 1); addSub(text.slice(i + 2, k)); add(text.slice(i, k + 1)); i = k + 1; continue; }
    // ${NAME} is one variable inside the word, never the end of a segment
    if (c === '$' && text[i + 1] === '{') { const k = text.indexOf('}', i + 2); if (k < 0) throw new Error('unbalanced brace'); add(text.slice(i, k + 1)); i = k + 1; continue; }
    if (c === '`') {
      if (isPs) { if (text[i + 1] !== '\n' && text[i + 1] !== '\r') add(text[i + 1] || ''); i += 2; continue; }
      const k = text.indexOf('`', i + 1);
      if (k < 0) throw new Error('unbalanced back-tick');
      addSub(text.slice(i + 1, k)); add(text.slice(i, k + 1)); i = k + 1; continue;
    }
    if (!isPs && c === '\\' && /[\s"'$`\\]/.test(text[i + 1] || '')) { if (text[i + 1] !== '\n') add(text[i + 1]); i += 2; continue; }
    if (c === '#' && word === null) { while (i < n && text[i] !== '\n') i += 1; continue; }
    if (c === ' ' || c === '\t') { endWord(); i += 1; continue; }
    if (c === '|' || c === ';' || c === '(' || c === ')') { endSeg(); i += 1; continue; }
    if (c === '{' || c === '}') {
      // PowerShell: a script block. sh: `{ cmd; }` is a group only as a word of its own; `{a,b}` is a
      // brace expansion that stays part of the word (bash runs `git {push,}` as `git push`).
      if (isPs || (word === null && (c === '}' || /\s/.test(text[i + 1] || ' ')))) { endSeg(); i += 1; continue; }
      add(c); i += 1; continue;
    }
    if (isPs && c === '&' && text[i + 1] !== '&' && text[i + 1] !== '>') { endWord(); words.push('&'); i += 1; continue; } // the call operator
    if (c === '&' && text[i + 1] !== '>') { endSeg(); i += text[i + 1] === '&' ? 2 : 1; continue; }
    if (c === '>' || (c === '&' && text[i + 1] === '>')) {
      if (word !== null && /^[0-9*]$/.test(word)) word = null; else endWord();
      i += c === '&' ? 2 : 1;
      const append = text[i] === '>';
      if (append) i += 1;
      if (text[i] === '|') i += 1;
      if (text[i] === '&') { i += 1; while (i < n && /[0-9-]/.test(text[i])) i += 1; continue; } // >&1: a descriptor, not a file
      while (text[i] === ' ' || text[i] === '\t') i += 1;
      redirectNext = true;
      appendNext = append;
      continue;
    }
    if (c === '<') {
      if (text[i + 1] === '<' && text[i + 2] !== '<') {
        const m = /^<<-?\s*(['"]?)([A-Za-z0-9_.-]+)\1/.exec(text.slice(i));
        if (!m) throw new Error('unreadable heredoc');
        endWord();
        heredocs.push({ delim: m[2], seg: segments.length }); // the segment this line is building
        i += m[0].length; continue; // the body is stdin: data, or the program of an interpreter
      }
      endWord(); i += 1; continue; // an input file: the next word stays an ordinary (read) argument
    }
    add(c); i += 1;
  }
  if (heredocs.length) throw new Error('unterminated heredoc');
  endSeg();
  return { segments, subs, subSegs };
}

function closeParen(text, open) {
  let depth = 0;
  for (let k = open; k < text.length; k++) {
    const c = text[k];
    if (c === "'" || c === '"') { const e = text.indexOf(c, k + 1); if (e < 0) break; k = e; continue; }
    if (c === '(') depth += 1;
    else if (c === ')' && --depth === 0) return k;
  }
  throw new Error('unbalanced parenthesis');
}
