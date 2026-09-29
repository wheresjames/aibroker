import { createInterface } from 'node:readline';

// Only filter known, low-severity HTTP lifecycle messages. Unknown output,
// malformed JSON, warnings, and unsuccessful responses remain visible.
export function shouldDisplay(line) {
  const plain = line.replace(/\x1b\[[0-9;]*m/g, '');
  const start = plain.indexOf('{');
  if (start === -1) return true;
  let record;
  try {
    record = JSON.parse(plain.slice(start));
  } catch {
    return true;
  }
  if (!record || typeof record.level !== 'number' || record.level >= 40) return true;
  if (record.msg === 'incoming request' && record.req) return false;
  const status = record.res?.statusCode;
  return !(record.msg === 'request completed' && typeof status === 'number' && status >= 200 && status < 400);
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  if (shouldDisplay(line)) {
    if (!process.stdout.write(`${line}\n`)) {
      await new Promise((resolve) => process.stdout.once('drain', resolve));
    }
  }
}
