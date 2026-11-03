/**
 * Parse one logfmt line as written by Alloy's faro.receiver (go-logfmt).
 *
 * Values are either bare (no spaces, quotes or `=`) or double-quoted with
 * Go-style escapes: \" \\ \n \r \t and \uXXXX (control characters, U+2028/9
 * and invalid UTF-8 as �). Everything else, including non-ASCII, is
 * written as-is. Keys repeated later on the line overwrite earlier ones.
 */
export function parseLogfmt(line: string): Record<string, string> {
  const result: Record<string, string> = {};
  const length = line.length;
  let i = 0;

  while (i < length) {
    while (i < length && line[i] === ' ') {
      i++;
    }
    if (i >= length) {
      break;
    }

    const keyStart = i;
    while (i < length && line[i] !== '=' && line[i] !== ' ') {
      i++;
    }
    const key = line.slice(keyStart, i);

    if (i >= length || line[i] === ' ') {
      // A bare key without a value.
      if (key) {
        result[key] = '';
      }
      continue;
    }

    // Skip '='.
    i++;

    if (line[i] === '"') {
      i++;
      let value = '';
      let chunkStart = i;
      while (i < length && line[i] !== '"') {
        if (line[i] !== '\\') {
          i++;
          continue;
        }
        value += line.slice(chunkStart, i);
        const escaped = line[i + 1];
        switch (escaped) {
          case 'n':
            value += '\n';
            i += 2;
            break;
          case 'r':
            value += '\r';
            i += 2;
            break;
          case 't':
            value += '\t';
            i += 2;
            break;
          case 'u': {
            const hex = line.slice(i + 2, i + 6);
            if (/^[0-9a-fA-F]{4}$/.test(hex)) {
              value += String.fromCharCode(parseInt(hex, 16));
              i += 6;
            } else {
              value += '\\u';
              i += 2;
            }
            break;
          }
          case undefined:
            i += 1;
            break;
          default:
            // \" \\ and anything unknown: keep the escaped character.
            value += escaped;
            i += 2;
        }
        chunkStart = i;
      }
      value += line.slice(chunkStart, i);
      // Skip the closing quote.
      i++;
      if (key) {
        result[key] = value;
      }
      continue;
    }

    const valueStart = i;
    while (i < length && line[i] !== ' ') {
      i++;
    }
    if (key) {
      result[key] = line.slice(valueStart, i);
    }
  }

  return result;
}
